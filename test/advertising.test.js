/**
 * Advertising budgets & summary — spend next to the leads of the same period,
 * with in-memory repositories (no PostgreSQL needed).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdvertisingService } from '../src/modules/advertising/advertising.service.js';

const hq = {
  id: 'u-hq',
  role: 'HQ_STAFF',
  branchId: null,
  areaId: null,
  requestId: 'req',
  ip: '127.0.0.1',
};
const outletStaff = { ...hq, id: 'u-kacab', role: 'BRANCH_HEAD', branchId: 'b1' };

const SPEND = [
  { areaId: 'a1', referenceId: 'r1', spend: 10_000_000 },
  { areaId: 'a1', referenceId: 'r2', spend: 5_000_000 },
];
const LEADS = [
  { areaId: 'a1', referenceId: 'r1', leads: 20, converted: 5 },
  { areaId: 'a1', referenceId: 'r2', leads: 10, converted: 1 },
];

function fakeWorld() {
  const audit = [];
  const budgets = new Map();
  let seq = 0;

  const repos = {
    advertising: {
      // Copies, like the real repository which maps each row into a fresh object.
      async list() {
        return [...budgets.values()].map((b) => ({ ...b }));
      },
      async findById(id) {
        const budget = budgets.get(id);
        return budget ? { ...budget } : null;
      },
      async insert(fields) {
        // One budget per area × channel × month.
        const clash = [...budgets.values()].some(
          (b) =>
            b.areaId === fields.areaId &&
            b.referenceId === fields.referenceId &&
            b.periodMonth === fields.periodMonth,
        );
        if (clash) throw Object.assign(new Error('duplicate'), { code: '23505' });
        const id = `budget-${++seq}`;
        budgets.set(id, { id, ...fields });
        return id;
      },
      async update(id, fields) {
        const budget = budgets.get(id);
        if (!budget) return false;
        Object.assign(budget, fields);
        return true;
      },
      // The fake honours the window so an out-of-range period is really empty.
      async spendByAreaReference({ from } = {}) {
        return from === '2020-01-01' ? [] : SPEND;
      },
    },
    leads: {
      async countsByAreaReference({ from } = {}) {
        return from === '2020-01-01' ? [] : LEADS;
      },
    },
    areas: {
      findById: async (id) => (id === 'a1' ? { id, code: 'JKT', isActive: true } : null),
      list: async () => [{ id: 'a1', code: 'JKT', name: 'Jabodetabek' }],
    },
    references: {
      findById: async (id) =>
        id === 'r1' || id === 'r2' ? { id, code: id.toUpperCase(), isActive: true } : null,
      list: async () => [
        { id: 'r1', code: 'INSTAGRAM', name: 'Instagram', channelType: 'SOCIAL' },
        { id: 'r2', code: 'GOOGLE_ADS', name: 'Google Ads', channelType: 'DIGITAL_ADS' },
      ],
    },
    audit: { append: async (entry) => audit.push(entry) },
  };

  const uow = { repos, audit, run: (work) => work(repos) };
  return { service: createAdvertisingService({ uow }), budgets, audit };
}

const budget = {
  areaId: 'a1',
  referenceId: 'r1',
  periodMonth: '2026-11-01',
  spendAmount: 12_500_000,
};

describe('Advertising budgets', () => {
  it('creates a budget and audits it', async () => {
    const { service, budgets, audit } = fakeWorld();
    const created = await service.create(hq, budget);

    assert.equal(created.spendAmount, 12_500_000);
    assert.equal(budgets.size, 1);
    assert.equal(audit[0].action, 'BUDGET_CREATED');
    assert.equal(audit[0].entityType, 'advertising_budget');
  });

  it('rejects a second budget for the same area, channel and month', async () => {
    const { service } = fakeWorld();
    await service.create(hq, budget);
    await assert.rejects(
      () => service.create(hq, budget),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /already has a budget/);
        return true;
      },
    );
  });

  it('rejects an unknown area or channel', async () => {
    const { service } = fakeWorld();
    for (const patch of [{ areaId: 'a-x' }, { referenceId: 'r-x' }]) {
      await assert.rejects(
        () => service.create(hq, { ...budget, ...patch }),
        (err) => err.status === 422,
      );
    }
  });

  it('records before/after values on update', async () => {
    const { service, audit } = fakeWorld();
    const created = await service.create(hq, budget);
    const updated = await service.update(hq, created.id, { spendAmount: 15_000_000 });

    assert.equal(updated.spendAmount, 15_000_000);
    assert.deepEqual(audit[1].diff.fields, ['spendAmount']);
    assert.deepEqual(audit[1].diff.before, { spendAmount: 12_500_000 });
    assert.deepEqual(audit[1].diff.after, { spendAmount: 15_000_000 });
  });

  it('an unknown budget is reported as missing', async () => {
    const { service } = fakeWorld();
    await assert.rejects(
      () => service.update(hq, 'budget-tidak-ada', { spendAmount: 1 }),
      /Advertising budget not found/,
    );
  });
});

describe('Advertising summary', () => {
  it('puts spend next to leads per channel, with cost ratios', async () => {
    const { service } = fakeWorld();
    const summary = await service.summary(hq, { groupBy: 'reference' });

    assert.equal(summary.comparable, true);
    assert.deepEqual(
      summary.rows.map((r) => [r.referenceCode, r.spend, r.leads, r.converted]),
      [
        ['INSTAGRAM', 10_000_000, 20, 5],
        ['GOOGLE_ADS', 5_000_000, 10, 1],
      ],
    );
    assert.equal(summary.rows[0].costPerLead, 500_000);
    assert.equal(summary.rows[0].costPerConversion, 2_000_000);
    assert.equal(summary.rows[0].conversionRate, 0.25);
    assert.deepEqual(summary.totals, {
      spend: 15_000_000,
      leads: 30,
      converted: 6,
      costPerLead: 500_000,
      costPerConversion: 2_500_000,
    });
  });

  it('groups by area when asked', async () => {
    const { service } = fakeWorld();
    const summary = await service.summary(hq, { groupBy: 'area' });

    assert.equal(summary.rows.length, 1);
    assert.equal(summary.rows[0].areaCode, 'JKT');
    assert.equal(summary.rows[0].spend, 15_000_000);
    assert.equal(summary.rows[0].leads, 30);
  });

  it('hides the ratios when spend and leads are not the same population', async () => {
    const { service } = fakeWorld();
    const summary = await service.summary(outletStaff, { groupBy: 'reference' });

    // An outlet-scoped caller sees the whole area's spend but only its own leads.
    assert.equal(summary.comparable, false);
    assert.equal(summary.totals.costPerLead, null);
    assert.equal(summary.totals.costPerConversion, null);
    assert.ok(summary.rows.every((row) => row.costPerLead === null));
    // The raw numbers are still shown, so nothing is silently dropped.
    assert.equal(summary.totals.spend, 15_000_000);
    assert.equal(summary.totals.leads, 30);
  });

  it('an empty period yields zeroes rather than NaN', async () => {
    const { service } = fakeWorld();
    const summary = await service.summary(hq, { from: '2020-01-01', to: '2020-01-31' });
    assert.deepEqual(summary.rows, []);
    assert.equal(summary.totals.spend, 0);
    assert.equal(summary.totals.leads, 0);
    assert.equal(summary.totals.costPerLead, null);
    assert.equal(summary.totals.costPerConversion, null);
  });
});
