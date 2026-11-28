import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLiveOmsetService } from '../src/modules/liveomset/liveOmset.service.js';

function dateKey(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}`;
}

describe('Live Omset service', () => {
  it('uses the caller-scoped outlet list and reads local-day Redis snapshots', async () => {
    const instant = new Date('2026-11-28T04:08:00.000Z');
    const actor = { role: 'AREA_MANAGER', areaId: 'area-1', branchId: null };
    const outlets = [
      {
        id: 'branch-1',
        code: 'JKT-01',
        name: 'Jakarta One',
        city: 'Jakarta',
        province: 'DKI Jakarta',
        timezone: 'Asia/Jakarta',
      },
      {
        id: 'branch-2',
        code: 'DPS-01',
        name: 'Bali One',
        city: 'Denpasar',
        province: 'Bali',
        timezone: 'Asia/Makassar',
      },
    ];
    const branchSummary = {
      transaction_count: '3',
      buy_count: '2',
      sell_count: '1',
      buy_amount: '1250000.00',
      sell_amount: '450000.00',
      bonus_amount: '1250.00',
      weight_gram: '4.500',
    };
    const keys = [];
    let listCalls = 0;
    const service = createLiveOmsetService({
      branches: {
        async list(receivedActor, options) {
          listCalls += 1;
          assert.equal(receivedActor, actor);
          assert.deepEqual(options, { includeInactive: false });
          return outlets;
        },
      },
      cache: {
        async get(key) {
          keys.push(key);
          return key.includes('branch-1') ? branchSummary : null;
        },
      },
      clock: () => instant,
    });

    const source = await service.open(actor);
    const snapshot = await source.snapshot();
    const repeated = await source.snapshot();

    assert.equal(listCalls, 1);
    assert.deepEqual(keys.slice(0, 2), [
      `omset:live:branch-1:${dateKey('Asia/Jakarta', instant)}`,
      `omset:live:branch-2:${dateKey('Asia/Makassar', instant)}`,
    ]);
    assert.equal(snapshot.generatedAt, instant.toISOString());
    assert.deepEqual(snapshot.totals, {
      transactionCount: 3,
      buyCount: 2,
      sellCount: 1,
      buyAmount: 1250000,
      sellAmount: 450000,
      bonusAmount: 1250,
      weightGram: 4.5,
    });
    assert.equal(snapshot.branches.length, 2);
    assert.equal(snapshot.branches[1].transactionCount, 0);
    assert.deepEqual(repeated.totals, snapshot.totals);
  });
});
