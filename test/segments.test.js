import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  channelsOfMask,
  isSideAllowed,
  maskOf,
  overlapRegions,
  SEGMENTS,
} from '../src/shared/segments.js';
import { createSegmentService } from '../src/modules/segments/segment.service.js';
import { can, Permissions as P } from '../src/security/rbac.js';

describe('Customer clusters (domain)', () => {
  it('mask ↔ channels round-trips for every combination', () => {
    for (let mask = 0; mask <= 7; mask += 1) assert.equal(maskOf(channelsOfMask(mask)), mask);
    assert.equal(maskOf(['STORE', 'ECOMMERCE']), 5);
    assert.deepEqual(channelsOfMask(6), ['MOBILE_APP', 'ECOMMERCE']);
    assert.equal(maskOf(['UNKNOWN']), 0);
  });

  it('builds 7 overlap regions + unclustered, including empty ones', () => {
    const { regions, unclustered } = overlapRegions({ 0: 2, 1: 4, 7: 1 });
    assert.equal(regions.length, 7);
    assert.equal(unclustered, 2);
    assert.deepEqual(regions.find((r) => r.mask === 7).channels, SEGMENTS);
    assert.equal(regions.find((r) => r.mask === 1).customers, 4);
    assert.equal(regions.find((r) => r.mask === 3).customers, 0);
  });

  it('e-commerce only accepts purchases; store and app accept buy and sell', () => {
    assert.equal(isSideAllowed('ECOMMERCE', 'BUY'), true);
    assert.equal(isSideAllowed('ECOMMERCE', 'SELL'), false);
    for (const channel of ['STORE', 'MOBILE_APP']) {
      assert.equal(isSideAllowed(channel, 'BUY'), true);
      assert.equal(isSideAllowed(channel, 'SELL'), true);
    }
    assert.equal(isSideAllowed('OTHER', 'BUY'), false);
  });

  it('RBAC: counter roles record transactions, but appraisers cannot read the cluster summary', () => {
    assert.equal(can('APPRAISER', P.TRANSACTION_WRITE), true);
    assert.equal(can('APPRAISER', P.SEGMENT_READ), false);
    assert.equal(can('CUSTOMER_SERVICE', P.SEGMENT_READ), true);
    // Customer service runs the counter (queue, sale, rating) per the architecture doc,
    // so it holds transaction:write — the cluster summary stays read-only for it.
    assert.equal(can('CUSTOMER_SERVICE', P.TRANSACTION_WRITE), true);
    assert.equal(can('CUSTOMER_SERVICE', P.QMS_WRITE), true);
    assert.equal(can('DIGITAL_MARKETING', P.TRANSACTION_WRITE), false);
    assert.equal(can('BRANCH_HEAD', P.SEGMENT_READ), true);
  });
});

describe('Commerce event ingestion', () => {
  /** Fake intake: the account link appears only after a slow registration finishes. */
  function harness() {
    const linked = new Set();
    const recorded = [];
    const intake = {
      async upsert(candidate, { channel }) {
        const key = `${channel}:${candidate.accountId}`;
        if (candidate.phone) {
          await new Promise((resolve) => setTimeout(resolve, 30)); // slow first-time registration
          linked.add(key);
          return { status: 'created', customerId: 'c1' };
        }
        return linked.has(key)
          ? { status: 'matched', customerId: 'c1' }
          : { status: 'skipped', reason: 'unknown account and no phone number' };
      },
    };
    const uow = {
      run: (work) =>
        work({
          segments: { insertTransaction: async (tx) => (recorded.push(tx), tx) },
          audit: { append: async () => {} },
        }),
    };
    const logger = { info() {}, error() {} };
    return { service: createSegmentService({ uow, customers: {}, intake, logger }), recorded };
  }

  it('records an order that arrives while its account is still being registered', async () => {
    const { service, recorded } = harness();
    const base = { source: 'ECOMMERCE', accountId: 'web-1' };
    await Promise.all([
      service.ingestCommerceEvent({
        ...base,
        eventId: 'e1',
        type: 'account.registered',
        phone: '+6281200000001',
        fullName: 'Ayu',
      }),
      service.ingestCommerceEvent({
        ...base,
        eventId: 'e2',
        type: 'order.completed',
        orderId: 'o1',
        side: 'BUY',
        weightGram: 1,
        amount: 1,
      }),
    ]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].externalRef, 'ECOMMERCE:o1');
  });
});
