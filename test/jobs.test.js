import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../src/core/logger.js';
import { createCache } from '../src/infra/cache.js';
import { createJobRunner } from '../src/infra/jobs.js';

const logger = createLogger({ level: 'error' });

describe('Job runner', () => {
  it('does not create durable run records while a job has no work', async () => {
    const cache = await createCache({ redisUrl: null, logger });
    let queries = 0;
    let preflights = 0;
    const runner = createJobRunner({
      db: {
        query: async () => {
          queries += 1;
          throw new Error('No job run should be written');
        },
      },
      cache,
      logger,
    });
    runner.register({
      name: 'blast-worker',
      intervalMs: 10_000,
      shouldRun: async () => {
        preflights += 1;
        return false;
      },
      run: async () => assert.fail('job must not run without work'),
    });

    try {
      assert.equal(await runner.runDue(), 0);
      assert.equal(await runner.runDue(), 0);
      assert.equal(preflights, 1);
      assert.equal(queries, 0);
    } finally {
      await runner.stop();
      await cache.close();
    }
  });

  it('records failures, retries with backoff, and records the recovery', async () => {
    const cache = await createCache({ redisUrl: null, logger });
    const runs = [];
    let clockMs = Date.parse('2026-11-28T00:00:00.000Z');
    let callCount = 0;
    const db = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO job_runs')) {
          const runId = `run-${runs.length + 1}`;
          runs.push({ runId, status: 'RUNNING', params });
          return { rows: [{ job_run_id: runId }] };
        }
        if (sql.includes("SET status = 'FAILED'")) {
          const run = runs.find(({ runId }) => runId === params[0]);
          Object.assign(run, { status: 'FAILED', error: params[1] });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SET status = $2')) {
          const run = runs.find(({ runId }) => runId === params[0]);
          Object.assign(run, { status: params[1], result: params[2] });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const runner = createJobRunner({
      db,
      cache,
      logger,
      clock: () => new Date(clockMs),
      retryBaseMs: 1_000,
      retryMaxMs: 5_000,
    });
    runner.register({
      name: 'review-sync',
      intervalMs: 60_000,
      run: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error('temporary provider failure');
        return { processed: 1 };
      },
    });

    try {
      assert.equal(await runner.runDue(), 1);
      assert.equal(runs[0].status, 'FAILED');
      assert.equal(await runner.runDue(), 0);

      clockMs += 1_000;
      assert.equal(await runner.runDue(), 1);
      assert.equal(runs[1].status, 'SUCCEEDED');
      assert.deepEqual(JSON.parse(runs[1].result), { processed: 1 });
    } finally {
      await runner.stop();
      await cache.close();
    }
  });
});
