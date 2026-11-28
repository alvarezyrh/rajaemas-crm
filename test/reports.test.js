import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReportsService } from '../src/modules/reports/reports.service.js';

const areaActor = { role: 'AREA_MANAGER', branchId: null, areaId: 'area-1' };
const adminActor = { role: 'SUPER_ADMIN', branchId: null, areaId: null };
const marketingActor = { role: 'DIGITAL_MARKETING', branchId: null, areaId: null };

function createService(overrides = {}) {
  const calls = [];
  const service = createReportsService({
    repository: {
      dailySales: async (query) => {
        calls.push(['dailySales', query]);
        return { totals: {}, rows: [] };
      },
      transactionSummary: async (query) => {
        calls.push(['transactionSummary', query]);
        return { totals: {}, rows: [] };
      },
      customerSummary: async () => ({ totals: {}, rows: [] }),
      appDemographics: async () => ({ totals: {}, rows: [], suppressedGroups: true }),
      lmreiSummary: async () => ({ totals: {}, rows: [] }),
      ...overrides.repository,
    },
    transactions: { bonusSummary: async () => ({ totals: {}, rows: [] }) },
    qms: {
      summary: async () => [],
      ratingSummary: async () => [],
    },
    leads: { summary: async () => ({}) },
    advertising: { summary: async () => ({ totals: {}, rows: [] }) },
  });
  return { service, calls };
}

describe('Reports service', () => {
  it('lists only reports allowed for the actor, including unavailable sources explicitly', () => {
    const { service } = createService();
    const catalog = service.catalog(marketingActor);
    assert.ok(catalog.some((report) => report.name === 'advertising'));
    assert.ok(catalog.some((report) => report.name === 'google-reviews' && !report.available));
    assert.ok(!catalog.some((report) => report.name === 'transactions'));
  });

  it('applies the caller area scope to a city report', async () => {
    const { service, calls } = createService();
    const result = await service.run(areaActor, 'dashboard-city', {
      from: '2026-01-01',
      to: '2026-01-31',
    });
    assert.deepEqual(calls[0], [
      'dailySales',
      {
        from: '2026-01-01',
        to: '2026-01-31',
        groupBy: 'city',
        scope: { branchId: null, areaId: 'area-1' },
      },
    ]);
    assert.equal(result.report, 'dashboard-city');
  });

  it('supports documented transaction groupings without widening scope', async () => {
    const { service, calls } = createService();
    await service.run(areaActor, 'transactions', { groupBy: 'reference' });
    assert.equal(calls[0][1].groupBy, 'reference');
    assert.deepEqual(calls[0][1].scope, { branchId: null, areaId: 'area-1' });
  });

  it('rejects unauthorized, unavailable, invalid, and unknown reports explicitly', async () => {
    const { service } = createService();
    await assert.rejects(service.run(marketingActor, 'transactions', {}), { code: 'FORBIDDEN' });
    await assert.rejects(service.run(adminActor, 'google-reviews', {}), {
      code: 'NOT_IMPLEMENTED',
    });
    await assert.rejects(
      service.run(adminActor, 'transactions', {
        from: '2026-02-01',
        to: '2026-01-31',
      }),
      { code: 'VALIDATION_FAILED' },
    );
    await assert.rejects(service.run(adminActor, 'transactions', { groupBy: 'tier' }), {
      code: 'VALIDATION_FAILED',
    });
    await assert.rejects(service.run(adminActor, 'not-a-report', {}), { code: 'NOT_FOUND' });
  });
});
