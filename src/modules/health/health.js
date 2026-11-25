import { sendJson } from '../../core/http/response.js';

/** /healthz (liveness) & /readyz (readiness: koneksi DB + cache, dan status shutdown). */
export function createHealth({ db, cache }) {
  let shuttingDown = false;

  return Object.freeze({
    markShuttingDown() {
      shuttingDown = true;
    },

    async readiness() {
      if (shuttingDown) return { ready: false, checks: { shutdown: 'in_progress' } };
      const [database, cacheCheck] = await Promise.allSettled([db.ping(), cache.ping()]);
      const checks = {
        database: database.status === 'fulfilled' ? 'ok' : 'fail',
        cache: cacheCheck.status === 'fulfilled' && cacheCheck.value ? 'ok' : 'fail',
      };
      return { ready: Object.values(checks).every((c) => c === 'ok'), checks };
    },
  });
}

export function registerHealthRoutes(router, { health }) {
  router.get('/healthz', async (ctx) => {
    sendJson(ctx, 200, { status: 'ok', uptimeSec: Math.round(process.uptime()) });
  });

  router.get('/readyz', async (ctx) => {
    const { ready, checks } = await health.readiness();
    sendJson(ctx, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks });
  });
}
