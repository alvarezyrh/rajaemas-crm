const BASE_URL = 'http://127.0.0.1:3000/readyz';
const REQUESTS = Number(process.env.QA_LOAD_REQUESTS ?? 100);
const CONCURRENCY = Number(process.env.QA_LOAD_CONCURRENCY ?? 10);

if (!Number.isInteger(REQUESTS) || REQUESTS < 1 || REQUESTS > 2000) {
  throw new Error('QA_LOAD_REQUESTS must be an integer from 1 to 2000');
}
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 50) {
  throw new Error('QA_LOAD_CONCURRENCY must be an integer from 1 to 50');
}

const latencies = [];
const failures = [];
let nextRequest = 0;
const startedAt = performance.now();

async function worker() {
  while (nextRequest < REQUESTS) {
    const request = nextRequest;
    nextRequest += 1;
    const requestStartedAt = performance.now();
    try {
      const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      const duration = performance.now() - requestStartedAt;
      if (!response.ok || body.status !== 'ready') {
        failures.push({ request: request + 1, status: response.status, body: body.status });
      } else {
        latencies.push(duration);
      }
    } catch (error) {
      failures.push({ request: request + 1, error: error.message });
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, () => worker()));

const elapsedMs = performance.now() - startedAt;
latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? null;
const result = {
  endpoint: BASE_URL,
  requests: REQUESTS,
  concurrency: Math.min(CONCURRENCY, REQUESTS),
  succeeded: latencies.length,
  failed: failures.length,
  durationMs: Math.round(elapsedMs),
  requestsPerSecond: Math.round((REQUESTS / (elapsedMs / 1000)) * 100) / 100,
  latencyMs: {
    min: latencies.length ? Math.round(latencies[0] * 100) / 100 : null,
    median: percentile(0.5) === null ? null : Math.round(percentile(0.5) * 100) / 100,
    p95: percentile(0.95) === null ? null : Math.round(percentile(0.95) * 100) / 100,
    max: latencies.length ? Math.round(latencies.at(-1) * 100) / 100 : null,
  },
};

console.log(JSON.stringify({ ...result, failures: failures.slice(0, 5) }, null, 2));
if (failures.length > 0) process.exitCode = 1;
