/**
 * Key-value cache abstraction for JSON values with a TTL.
 * - Redis (REDIS_URL terisi): state dibagi antar-instance → stateless horizontal scaling.
 * - Memory: local development / a single process only.
 *
 * Antarmuka: key/value, counter, sorted-set, health, and lifecycle operations.
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
  const put = (key, value, ttlSec, kind = 'value') =>
    store.set(key, { kind, value, expiresAt: Date.now() + ttlSec * 1000 });

  return Object.freeze({
    kind: 'memory',
    get: async (key) => {
      const entry = live(key);
      if (entry?.kind === 'sorted-set') throw new TypeError('Cache key is not a string value');
      return entry?.value ?? null;
    },
    set: async (key, value, ttlSec) => void put(key, value, ttlSec),
    async setIfAbsent(key, value, ttlSec) {
      if (live(key)) return false;
      put(key, value, ttlSec);
      return true;
    },
    async delIfValue(key, value) {
      if (live(key)?.value !== value) return false;
      store.delete(key);
      return true;
    },
    async incr(key, ttlSec) {
      const entry = live(key);
      if (entry) {
        if (!Number.isSafeInteger(entry.value)) {
          throw new TypeError('Cache value is not an integer counter');
        }
        entry.value += 1;
        entry.kind = 'counter';
        return entry.value;
      }
      put(key, 1, ttlSec, 'counter');
      return 1;
    },
    async zAdd(key, score, member, ttlSec) {
      const entry = live(key);
      if (entry && entry.kind !== 'sorted-set') {
        throw new TypeError('Cache key is not a sorted set');
      }
      const members = entry?.value ?? new Map();
      members.set(String(member), Number(score));
      put(key, members, ttlSec, 'sorted-set');
    },
    async zRangeWithScores(key) {
      const entry = live(key);
      if (!entry) return [];
      if (entry.kind !== 'sorted-set') throw new TypeError('Cache key is not a sorted set');
      return [...entry.value]
        .map(([value, score]) => ({ value, score }))
        .sort((a, b) => a.score - b.score || a.value.localeCompare(b.value));
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
    async delIfValue(key, value) {
      const deleted = await client.eval(
        `if redis.call("GET", KEYS[1]) == ARGV[1] then
           return redis.call("DEL", KEYS[1])
         else
           return 0
         end`,
        { keys: [key], arguments: [JSON.stringify(value)] },
      );
      return deleted === 1;
    },
    async incr(key, ttlSec) {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttlSec);
      return count;
    },
    async zAdd(key, score, member, ttlSec) {
      await client.zAdd(key, { score: Number(score), value: String(member) });
      await client.expire(key, ttlSec);
    },
    zRangeWithScores: async (key) => client.zRangeWithScores(key, 0, -1),
    async del(key) {
      await client.del(key);
    },
    ping: async () => (await client.ping()) === 'PONG',
    close: () => client.quit(),
  });
}
