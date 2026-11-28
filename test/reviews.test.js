import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReviewsService } from '../src/modules/reviews/reviews.service.js';
import { createLogger } from '../src/core/logger.js';

const actor = { role: 'HQ_STAFF', branchId: null, areaId: null };
const branch = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'JKT01',
  name: 'Jakarta',
  googlePlaceId: 'place/id',
};

describe('On-demand Google reviews', () => {
  it('fetches only the requested outlet and returns attribution without storing content', async () => {
    const requests = [];
    const service = createReviewsService({
      branches: { get: async (_actor, id) => ({ ...branch, id }) },
      apiKey: 'test-key',
      logger: createLogger({ level: 'silent' }),
      fetchPlace: async (url, options) => {
        requests.push({ url, options });
        return {
          rating: 4.5,
          userRatingCount: 20,
          googleMapsUri: 'https://maps.google.com/?cid=123',
          reviews: [
            {
              rating: 5,
              text: { text: 'Helpful staff' },
              publishTime: '2026-11-27T10:00:00Z',
              authorAttribution: {
                displayName: 'Google reviewer',
                uri: 'https://www.google.com/maps/contrib/123',
              },
            },
          ],
        };
      },
    });

    const result = await service.outlet(actor, branch.id);

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /place%2Fid$/);
    assert.equal(requests[0].options.headers['X-Goog-Api-Key'], 'test-key');
    assert.equal(result.rating, 4.5);
    assert.equal(result.reviews[0].author, 'Google reviewer');
    assert.equal(result.reviews[0].text, 'Helpful staff');
    assert.equal(result.googleMapsUri, 'https://maps.google.com/?cid=123');
  });

  it('fails explicitly when Places is unconfigured or an outlet lacks a place ID', async () => {
    let calls = 0;
    const service = createReviewsService({
      branches: { get: async () => branch },
      apiKey: null,
      logger: createLogger({ level: 'silent' }),
      fetchPlace: async () => {
        calls += 1;
      },
    });

    await assert.rejects(service.outlet(actor, branch.id), { status: 501 });
    assert.equal(calls, 0);
  });
});
