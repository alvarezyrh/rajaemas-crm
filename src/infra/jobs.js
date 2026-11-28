import { randomUUID } from 'node:crypto';

const STATE_TTL_EXTRA_SEC = 24 * 60 * 60;

export function createJobRunner({
  db,
  cache,
  logger,
  clock = () => new Date(),
  tickMs = 1_000,
  retryBaseMs = 30_000,
  retryMaxMs = 30 * 60 * 1_000,
}) {
  const jobs = new Map();
  const inFlight = new Set();
  let timer = null;

  async function execute(job) {
    const stateKey = `jobs:state:${job.name}`;
    const lockKey = `jobs:lock:${job.name}`;
    const initialState = await cache.get(stateKey);
    if (initialState?.nextRunAt && Date.parse(initialState.nextRunAt) > clock().getTime()) {
      return false;
    }
    if (job.shouldRun) {
      try {
        if (!(await job.shouldRun())) {
          await cache.set(
            stateKey,
            {
              attempt: 0,
              nextRunAt: new Date(clock().getTime() + job.intervalMs).toISOString(),
            },
            Math.ceil(Math.max(job.intervalMs, retryMaxMs) / 1000) + STATE_TTL_EXTRA_SEC,
          );
          return false;
        }
      } catch {
        // Let the durable run path record a preflight failure through job.run().
      }
    }

    const lockToken = randomUUID();
    if (!(await cache.setIfAbsent(lockKey, lockToken, job.lockTtlSec ?? 1_800))) return false;

    let runId;
    try {
      const state = await cache.get(stateKey);
      if (state?.nextRunAt && Date.parse(state.nextRunAt) > clock().getTime()) return false;
      let attempt = (state?.attempt ?? 0) + 1;
      const { rows } = await db.query(
        `INSERT INTO job_runs (job_name, attempt)
         VALUES ($1, $2)
         RETURNING job_run_id`,
        [job.name, attempt],
      );
      runId = rows[0].job_run_id;

      try {
        const result = (await job.run()) ?? {};
        const status = result.skipped ? 'SKIPPED' : 'SUCCEEDED';
        await db.query(
          `UPDATE job_runs
           SET status = $2, result = $3, finished_at = now()
           WHERE job_run_id = $1`,
          [runId, status, JSON.stringify(result)],
        );
        await cache.set(
          stateKey,
          {
            attempt: 0,
            nextRunAt: new Date(clock().getTime() + job.intervalMs).toISOString(),
          },
          Math.ceil(Math.max(job.intervalMs, retryMaxMs) / 1000) + STATE_TTL_EXTRA_SEC,
        );
        logger.info('job.completed', { jobName: job.name, runId, status });
      } catch (err) {
        attempt = (state?.attempt ?? 0) + 1;
        const retryMs = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs);
        const message = (err.message || 'Job failed').slice(0, 500);
        await db.query(
          `UPDATE job_runs
           SET status = 'FAILED', error_message = $2, finished_at = now()
           WHERE job_run_id = $1`,
          [runId, message],
        );
        await cache.set(
          stateKey,
          { attempt, nextRunAt: new Date(clock().getTime() + retryMs).toISOString() },
          Math.ceil(retryMaxMs / 1000) + STATE_TTL_EXTRA_SEC,
        );
        logger.error('job.failed', { jobName: job.name, runId, attempt, err });
      }
      return true;
    } catch (err) {
      logger.error('job.runner_failed', { jobName: job.name, runId, err });
      return false;
    } finally {
      try {
        await cache.delIfValue(lockKey, lockToken);
      } catch (err) {
        logger.error('job.lock_release_failed', { jobName: job.name, err });
      }
    }
  }

  async function runDue() {
    const results = await Promise.all([...jobs.values()].map(execute));
    return results.filter(Boolean).length;
  }

  function trigger() {
    const task = runDue().catch((err) => logger.error('job.tick_failed', { err }));
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }

  return Object.freeze({
    register(job) {
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(job.name)) throw new TypeError('Invalid job name');
      if (!Number.isSafeInteger(job.intervalMs) || job.intervalMs < 1_000) {
        throw new TypeError('Job interval must be at least one second');
      }
      if (typeof job.run !== 'function') throw new TypeError('Job requires a run function');
      if (job.shouldRun !== undefined && typeof job.shouldRun !== 'function') {
        throw new TypeError('Job shouldRun must be a function');
      }
      if (jobs.has(job.name)) throw new Error(`Duplicate job: ${job.name}`);
      jobs.set(job.name, Object.freeze(job));
    },

    runDue,

    start() {
      if (timer) throw new Error('Job runner is already started');
      timer = setInterval(trigger, tickMs);
      timer.unref();
      trigger();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.allSettled([...inFlight]);
    },
  });
}
