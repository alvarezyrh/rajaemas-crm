/**
 * Key-value cache abstraction for JSON values with a TTL.
 * - Redis (REDIS_URL terisi): state dibagi antar-instance → stateless horizontal scaling.
 * - Memory: local development / a single process only.
 *
 * Antarmuka: get, set, setIfAbsent, incr, del, ping, close.
 */
export async function createCache({ redisUrl, logger }) {
  return redisUrl ? createRedisCache(redisUrl, logger) : createMemoryCache();
}

function createMemoryCache() {
  const store = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);
  }, 60_000);
  sweeper.unref();

  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > Date.now()) return entry;
    store.delete(key);
    return undefined;
  };
  const put = (key, value, ttlSec) =>
    store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });

  return Object.freeze({
    kind: 'memory',
    get: async (key) => live(key)?.value ?? null,
    set: async (key, value, ttlSec) => void put(key, value, ttlSec),
    async setIfAbsent(key, value, ttlSec) {
      if (live(key)) return false;
      put(key, value, ttlSec);
      return true;
    },
    async incr(key, ttlSec) {
      const entry = live(key);
      if (entry) return ++entry.value;
      put(key, 1, ttlSec);
      return 1;
    },
    del: async (key) => void store.delete(key),
    ping: async () => true,
    async close() {
      clearInterval(sweeper);
      store.clear();
    },
  });
}

async function createRedisCache(url, logger) {
  const { createClient } = await import('redis');
  const client = createClient({ url });
  client.on('error', (err) => logger.error('cache.redis_error', { err }));
  await client.connect();

  return Object.freeze({
    kind: 'redis',
    async get(key) {
      const raw = await client.get(key);
      return raw === null ? null : JSON.parse(raw);
    },
    async set(key, value, ttlSec) {
      await client.set(key, JSON.stringify(value), { EX: ttlSec });
    },
    async setIfAbsent(key, value, ttlSec) {
      return (await client.set(key, JSON.stringify(value), { EX: ttlSec, NX: true })) === 'OK';
    },
    async incr(key, ttlSec) {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttlSec);
      return count;
    },
    async del(key) {
      await client.del(key);
    },
    ping: async () => (await client.ping()) === 'PONG',
    close: () => client.quit(),
  });
}
