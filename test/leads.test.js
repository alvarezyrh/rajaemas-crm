/**
 * Lead funnel — status machine, duplicate guards, conversion and data scope,
 * exercised with in-memory repositories (no PostgreSQL needed).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLeadService } from '../src/modules/leads/lead.service.js';

const hq = {
  id: 'u-hq',
  role: 'HQ_STAFF',
  branchId: null,
  areaId: null,
  requestId: 'req',
  ip: '127.0.0.1',
};
const areaManager = { ...hq, id: 'u-area', role: 'AREA_MANAGER', areaId: 'a1' };
const outletStaff = { ...hq, id: 'u-cs', role: 'CUSTOMER_SERVICE', branchId: 'b1' };

const pii = {
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => cipher.replace(/^enc:/, ''),
};
const blindIndex = (domain, value) => `${domain}:${value}`;

function fakeWorld({ customers = [], leads = [] } = {}) {
  const audit = [];
  let seq = 0;
  const store = new Map(leads.map((l) => [l.id, { ...l }]));
  const intakeCalls = [];

  const repos = {
    leads: {
      async search({ scope, status, name, phoneHash, limit, offset }) {
        const rows = [...store.values()].filter((l) => {
          if (scope.branchId && l.branchId !== scope.branchId) return false;
          if (scope.areaId && l.areaId !== scope.areaId) return false;
          if (status && l.status !== status) return false;
          if (name && !l.fullName.toLowerCase().includes(name.toLowerCase())) return false;
          if (phoneHash && l.phoneHash !== phoneHash) return false;
          return true;
        });
        return { items: rows.slice(offset, offset + limit), total: rows.length };
      },
      async findById(id, scope) {
        const lead = store.get(id);
        if (!lead) return null;
        if (scope?.branchId && lead.branchId !== scope.branchId) return null;
        if (scope?.areaId && lead.areaId !== scope.areaId) return null;
        return { ...lead };
      },
      async findRawById(id) {
        const lead = store.get(id);
        return lead ? { ...lead } : null;
      },
      async findActiveIdByPhoneHash(phoneHash) {
        const found = [...store.values()].find(
          (l) => l.phoneHash === phoneHash && !['CONVERTED', 'LOST', 'EXPIRED'].includes(l.status),
        );
        return found?.id ?? null;
      },
      async insert(record) {
        const id = `lead-${++seq}`;
        store.set(id, {
          id,
          status: 'NEW',
          ...record,
          convertedCustomerId: null,
          convertedAt: null,
          lostReason: null,
        });
        return id;
      },
      async update(id, fields) {
        const lead = store.get(id);
        if (!lead) return false;
        Object.assign(lead, fields);
        return true;
      },
      async markConverted(id, customerId, at) {
        Object.assign(store.get(id), {
          status: 'CONVERTED',
          convertedCustomerId: customerId,
          convertedAt: at,
        });
        return true;
      },
      async summary({ scope }) {
        const rows = [...store.values()].filter(
          (l) => !scope.branchId || l.branchId === scope.branchId,
        );
        const byStatus = {
          NEW: 0,
          CONTACTED: 0,
          QUALIFIED: 0,
          CONVERTED: 0,
          LOST: 0,
          EXPIRED: 0,
        };
        for (const row of rows) byStatus[row.status] += 1;
        return {
          total: rows.length,
          byStatus,
          avgDaysToConvert: null,
          byReference: [],
          byArea: [],
        };
      },
      async countsByAreaReference() {
        return [];
      },
    },
    customers: {
      async findIdByPhoneHash(phoneHash) {
        return customers.find((c) => c.phoneHash === phoneHash)?.id ?? null;
      },
      async linkAcquisition(id, link) {
        const customer = customers.find((c) => c.id === id);
        if (customer) Object.assign(customer, link);
      },
    },
    areas: { findById: async (id) => (id === 'a1' ? { id, isActive: true } : null) },
    references: {
      findById: async (id) => (id === 'r1' ? { id, isActive: true } : null),
    },
    branches: {
      findById: async (id) => (id === 'b1' ? { id, areaId: 'a1' } : null),
      isInArea: async (branchId, areaId) => branchId === 'b1' && areaId === 'a1',
    },
    audit: { append: async (entry) => audit.push(entry) },
  };

  const intake = {
    async upsert(candidate) {
      intakeCalls.push(candidate);
      return { status: 'created', customerId: 'cust-1' };
    },
  };

  const uow = { repos, audit, run: (work) => work(repos) };
  const service = createLeadService({ uow, pii, blindIndex, intake });
  return { service, store, audit, intakeCalls, repos };
}

const validLead = { fullName: 'Prospek Baru', phone: '+6281199900001' };

describe('Lead creation', () => {
  it('encrypts the phone, derives the area from the outlet and audits', async () => {
    const { service, store, audit } = fakeWorld();
    const lead = await service.create(hq, { ...validLead, branchId: 'b1', referenceId: 'r1' });

    assert.equal(lead.status, 'NEW');
    assert.equal(lead.branchId, 'b1');
    assert.equal(lead.areaId, 'a1'); // derived from the outlet, not from the request
    assert.equal(store.get(lead.id).phoneEncrypted, 'enc:+6281199900001');
    assert.equal(store.get(lead.id).phoneLast4, '0001');
    assert.equal(audit[0].action, 'LEAD_CREATED');
    assert.equal(audit[0].entityType, 'lead');
    // The audit entry names the fields, never their values.
    assert.equal(JSON.stringify(audit[0].diff).includes('62811'), false);
  });

  it('hands the plain number only to roles that may reveal PII', async () => {
    const { service } = fakeWorld();
    const lead = await service.create(hq, validLead);
    const forHq = await service.get(hq, lead.id);
    const appraiser = { ...hq, role: 'APPRAISER' };
    const forAppraiser = await service.get(appraiser, lead.id);

    assert.equal(forHq.phone, '+6281199900001');
    assert.equal(forAppraiser.phone, undefined);
    assert.equal(forAppraiser.phoneMasked, '+62 ••• •••• 0001');
    assert.equal(forAppraiser.phoneEncrypted, undefined);
  });

  it('refuses a number that is already a customer or already in the funnel', async () => {
    const phoneHash = blindIndex('phone', validLead.phone);
    const asCustomer = fakeWorld({ customers: [{ id: 'cust-9', phoneHash }] });
    await assert.rejects(
      () => asCustomer.service.create(hq, validLead),
      /already a registered customer/,
    );

    const { service } = fakeWorld();
    await service.create(hq, validLead);
    await assert.rejects(() => service.create(hq, validLead), /already an open lead/);
  });

  it('rejects an unknown or inactive acquisition channel', async () => {
    const { service } = fakeWorld();
    await assert.rejects(
      () => service.create(hq, { ...validLead, referenceId: 'r-tidak-ada' }),
      (err) => {
        assert.equal(err.status, 422);
        assert.equal(err.details[0].field, 'referenceId');
        return true;
      },
    );
  });

  it('keeps an area manager inside their own area', async () => {
    const { service } = fakeWorld();
    await assert.rejects(
      () => service.create(areaManager, { ...validLead, branchId: 'b2' }),
      /outside your area scope|not found/i,
    );
    const lead = await service.create(areaManager, { ...validLead, branchId: 'b1' });
    assert.equal(lead.areaId, 'a1');
  });
});

describe('Lead funnel', () => {
  it('walks NEW → CONTACTED → QUALIFIED and audits each step', async () => {
    const { service, audit } = fakeWorld();
    const lead = await service.create(hq, validLead);
    await service.update(hq, lead.id, { status: 'CONTACTED' });
    const qualified = await service.update(hq, lead.id, { status: 'QUALIFIED' });

    assert.equal(qualified.status, 'QUALIFIED');
    assert.deepEqual(
      audit.map((a) => a.action),
      ['LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'LEAD_STATUS_CHANGED'],
    );
    assert.deepEqual(audit[1].diff.before, { status: 'NEW' });
    assert.deepEqual(audit[1].diff.after, { status: 'CONTACTED' });
  });

  it('cannot walk the funnel backwards', async () => {
    const { service } = fakeWorld();
    const lead = await service.create(hq, validLead);
    await service.update(hq, lead.id, { status: 'QUALIFIED' });
    await assert.rejects(
      () => service.update(hq, lead.id, { status: 'CONTACTED' }),
      /Status cannot change from QUALIFIED to CONTACTED/,
    );
  });

  it('requires a reason when a lead is lost', async () => {
    const { service, store } = fakeWorld();
    const lead = await service.create(hq, validLead);
    await service.update(hq, lead.id, { status: 'QUALIFIED' });

    await assert.rejects(
      () => service.update(hq, lead.id, { status: 'LOST' }),
      (err) => {
        assert.equal(err.status, 422);
        assert.equal(err.details[0].field, 'lostReason');
        return true;
      },
    );

    const lost = await service.update(hq, lead.id, {
      status: 'LOST',
      lostReason: 'Tidak menanggapi',
    });
    assert.equal(lost.status, 'LOST');
    assert.equal(store.get(lead.id).lostReason, 'Tidak menanggapi');
  });

  it('routes CONVERTED and EXPIRED through their own paths', async () => {
    const { service } = fakeWorld();
    const lead = await service.create(hq, validLead);
    await assert.rejects(
      () => service.update(hq, lead.id, { status: 'CONVERTED' }),
      /Use the convert action/,
    );
    await assert.rejects(
      () => service.update(hq, lead.id, { status: 'EXPIRED' }),
      /expired automatically/,
    );
  });

  it('freezes a lead once it reached a terminal status', async () => {
    const { service } = fakeWorld();
    const lead = await service.create(hq, validLead);
    await service.convert(hq, lead.id);
    await assert.rejects(
      () => service.update(hq, lead.id, { notes: 'ubah' }),
      /can no longer be changed/,
    );
  });
});

describe('Lead conversion', () => {
  it('creates the customer through the shared intake path and links both ways', async () => {
    const customers = [{ id: 'cust-1', phoneHash: null }];
    const { service, store, audit, intakeCalls } = fakeWorld({ customers });
    const lead = await service.create(hq, { ...validLead, referenceId: 'r1' });
    const result = await service.convert(hq, lead.id);

    assert.equal(result.customerId, 'cust-1');
    assert.equal(result.alreadyConverted, false);
    assert.equal(intakeCalls.length, 1);
    assert.equal(intakeCalls[0].phone, '+6281199900001');
    assert.equal(store.get(lead.id).status, 'CONVERTED');
    assert.equal(customers[0].leadId, lead.id); // attribution written back
    assert.equal(customers[0].referenceId, 'r1');
    assert.equal(audit.at(-1).action, 'LEAD_CONVERTED');
  });

  it('is idempotent: converting twice returns the same customer', async () => {
    const { service, intakeCalls } = fakeWorld({ customers: [{ id: 'cust-1' }] });
    const lead = await service.create(hq, validLead);
    const first = await service.convert(hq, lead.id);
    const second = await service.convert(hq, lead.id);

    assert.equal(first.alreadyConverted, false);
    assert.equal(second.alreadyConverted, true);
    assert.equal(second.customerId, 'cust-1');
    assert.equal(intakeCalls.length, 1); // intake is not run again
  });

  it('refuses to convert a lost lead', async () => {
    const { service } = fakeWorld();
    const lead = await service.create(hq, validLead);
    await service.update(hq, lead.id, { status: 'QUALIFIED' });
    await service.update(hq, lead.id, { status: 'LOST', lostReason: 'Tidak menanggapi' });
    await assert.rejects(() => service.convert(hq, lead.id), /LOST lead cannot be converted/);
  });
});

describe('Lead scope & summary', () => {
  const seeded = [
    {
      id: 'l1',
      fullName: 'A',
      phoneHash: 'h1',
      phoneEncrypted: 'enc:+6281',
      phoneLast4: '1',
      branchId: 'b1',
      areaId: 'a1',
      status: 'QUALIFIED',
      referenceId: 'r1',
    },
    {
      id: 'l2',
      fullName: 'B',
      phoneHash: 'h2',
      phoneEncrypted: 'enc:+6282',
      phoneLast4: '2',
      branchId: 'b3',
      areaId: 'a2',
      status: 'NEW',
      referenceId: 'r1',
    },
    {
      id: 'l3',
      fullName: 'C',
      phoneHash: 'h3',
      phoneEncrypted: 'enc:+6283',
      phoneLast4: '3',
      branchId: 'b1',
      areaId: 'a1',
      status: 'CONVERTED',
      referenceId: 'r2',
    },
  ];

  it('outlet staff only see their own outlet, area managers their whole area', async () => {
    const { service } = fakeWorld({ leads: seeded });
    const forOutlet = await service.search(outletStaff, { page: 1, pageSize: 10 });
    const forArea = await service.search(areaManager, { page: 1, pageSize: 10 });
    const forHq = await service.search(hq, { page: 1, pageSize: 10 });

    assert.deepEqual(
      forOutlet.items.map((l) => l.id),
      ['l1', 'l3'],
    );
    assert.deepEqual(
      forArea.items.map((l) => l.id),
      ['l1', 'l3'],
    );
    assert.equal(forHq.items.length, 3);
    assert.equal(forHq.meta.total, 3);
  });

  it('a lead from another area is reported as missing, not forbidden', async () => {
    const { service } = fakeWorld({ leads: seeded });
    await assert.rejects(() => service.get(areaManager, 'l2'), /Lead not found/);
  });

  it('computes conversion against all leads and against decided ones', async () => {
    const { service } = fakeWorld({ leads: seeded });
    const summary = await service.summary(hq, {});

    assert.equal(summary.total, 3);
    assert.equal(summary.openLeads, 2); // QUALIFIED + NEW
    assert.equal(summary.byStatus.CONVERTED, 1);
    assert.equal(summary.conversionRate, 1 / 3);
    assert.equal(summary.decidedRate, 1); // the only decided lead converted
  });
});
