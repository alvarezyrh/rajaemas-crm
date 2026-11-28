import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createCache } from '../src/infra/cache.js';
import { createLogger } from '../src/core/logger.js';

const cachePromise = createCache({ redisUrl: null, logger: createLogger({ level: 'error' }) });
after(async () => (await cachePromise).close());

describe('Cache sorted sets', () => {
  it('updates members and returns scores in ascending order', async () => {
    const cache = await cachePromise;
    await cache.zAdd('hours', 22, '10', 60);
    await cache.zAdd('hours', 8, '09', 60);
    await cache.zAdd('hours', 31, '10', 60);
    assert.deepEqual(await cache.zRangeWithScores('hours'), [
      { value: '09', score: 8 },
      { value: '10', score: 31 },
    ]);
  });

  it('rejects using a value key as a sorted set', async () => {
    const cache = await cachePromise;
    await cache.set('value', { ok: true }, 60);
    await assert.rejects(cache.zAdd('value', 1, 'member', 60), TypeError);
  });

  it('only releases a lock when the stored value matches its owner token', async () => {
    const cache = await cachePromise;
    assert.equal(await cache.setIfAbsent('job-lock', 'owner-1', 60), true);
    assert.equal(await cache.setIfAbsent('job-lock', 'owner-2', 60), false);
    assert.equal(await cache.delIfValue('job-lock', 'owner-2'), false);
    assert.equal(await cache.get('job-lock'), 'owner-1');
    assert.equal(await cache.delIfValue('job-lock', 'owner-1'), true);
    assert.equal(await cache.get('job-lock'), null);
  });
});
