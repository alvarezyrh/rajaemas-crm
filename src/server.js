import cluster from 'node:cluster';
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { buildContainer } from './container.js';
import { createLogger } from './core/logger.js';

const config = loadConfig();
const logger = createLogger({ level: config.log.level, bindings: { service: 'rajaemas-crm' } });

if (cluster.isPrimary && config.cluster.workers > 1) {
  runPrimary();
} else {
  runWorker().catch((err) => {
    logger.error('server.start_failed', { err });
    process.exit(1);
  });
}

/** Primary process: forks workers and restarts any that die unexpectedly. */
function runPrimary() {
  let stopping = false;
  logger.info('cluster.start', { workers: config.cluster.workers });
  for (let i = 0; i < config.cluster.workers; i += 1) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    logger.warn('cluster.worker_exited', { pid: worker.process.pid, code, signal });
    cluster.fork();
  });

  const stop = (signal) => {
    stopping = true;
    logger.info('cluster.stopping', { signal });
    for (const worker of Object.values(cluster.workers)) worker?.process.kill(signal);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

async function runWorker() {
  const log = logger.child({ pid: process.pid });
  const container = await buildContainer(config, log);

  const server = http.createServer(
    {
      requestTimeout: config.http.requestTimeoutMs,
      headersTimeout: config.http.headersTimeoutMs,
      keepAliveTimeout: config.http.keepAliveTimeoutMs,
    },
    createApp(container),
  );
  server.maxHeadersCount = 100;

  await new Promise((resolve) => server.listen(config.http.port, config.http.host, resolve));
  log.info('server.listening', {
    host: config.http.host,
    port: config.http.port,
    cache: container.cache.kind,
  });

  let shuttingDown = false;
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server.shutdown_started', { reason });

    // 1) /readyz → 503 so the load balancer stops sending traffic.
    container.health.markShuttingDown();
    const forceExit = setTimeout(() => {
      log.error('server.shutdown_timeout');
      process.exit(1);
    }, config.http.shutdownTimeoutMs);
    forceExit.unref();

    // 2) Refuse new connections, finish in-flight requests.
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    // 3) Drain event handlers, then close the DB pool and cache.
    await container.dispose();

    log.info('server.shutdown_complete');
    process.exit(exitCode);
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('process.unhandled_rejection', { err }));
  process.on('uncaughtException', (err) => {
    log.error('process.uncaught_exception', { err });
    shutdown('uncaughtException', 1);
  });
}
