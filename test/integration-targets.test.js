import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntegrationService } from '../src/modules/integrations/integration.service.js';
import { createIntegrationTargets } from '../src/modules/integrations/targets.js';
import { createBlindIndexer, createPiiCipher } from '../src/security/crypto.js';

const actor = { id: 'staff-1', role: 'HQ_STAFF', branchId: null, areaId: null };
const pii = createPiiCipher(Buffer.alloc(32, 1));
const blindIndex = createBlindIndexer(Buffer.alloc(32, 2));

function harness({ products = [], datasetInserted = true, existingCustomer = true } = {}) {
  const calls = { products: [], leads: [], appointments: [], transactions: [], datasets: [] };
  const uow = {
    repos: {
      products: { list: async () => products },
      productCategories: {
        list: async () => [{ id: 'category-1', code: 'RING', isActive: true }],
      },
      branches: { listActive: async () => [{ id: 'branch-1', code: 'JKT', isActive: true }] },
      areas: { list: async () => [{ id: 'area-1', code: 'JAKARTA', isActive: true }] },
      references: { list: async () => [{ id: 'reference-1', code: 'WEB', isActive: true }] },
      transactionTypes: {
        list: async () => [{ id: 'type-1', code: 'BUY', isActive: true }],
      },
      customers: {
        findIdByPhoneHash: async () => (existingCustomer ? 'customer-1' : null),
      },
      segments: { findCustomerIdByAccount: async () => 'customer-1' },
      leads: { findActiveIdByPhoneHash: async () => null },
      integrations: {
        upsertDatasetRecord: async (...args) => {
          calls.datasets.push(args);
          return datasetInserted;
        },
      },
    },
  };
  const targets = createIntegrationTargets({
    uow,
    pii,
    blindIndex,
    intake: {},
    leads: { create: async (...args) => calls.leads.push(args) },
    appointments: {
      create: async (...args) => {
        calls.appointments.push(args);
        return { created: true };
      },
    },
    transactions: {
      record: async (...args) => {
        calls.transactions.push(args);
        return { created: true };
      },
    },
    masterdata: {
      products: {
        create: async (...args) => {
          calls.products.push(args);
          return { id: 'product-1', sku: args[1].sku };
        },
      },
    },
  });
  return { calls, targets };
}

describe('API Gateway import targets', () => {
  it('creates a mapped catalog product once and matches its SKU on later records', async () => {
    const { calls, targets } = harness();
    const source = {
      id: 'source-1',
      name: 'Catalog',
      targetType: 'PRODUCT',
      fieldMap: { sku: 'product.sku', name: 'product.name', categoryCode: 'product.category' },
    };
    const context = await targets.prepare(source);
    const record = { product: { sku: 'RING-01', name: 'Gold ring', category: 'RING' } };

    assert.deepEqual(await targets.importRecord(source, record, actor, context), {
      status: 'created',
    });
    assert.deepEqual(await targets.importRecord(source, record, actor, context), {
      status: 'matched',
    });
    assert.equal(calls.products.length, 1);
    assert.equal(calls.products[0][1].categoryId, 'category-1');
  });

  it('maps lead fields through the CRM lead service', async () => {
    const { calls, targets } = harness({ existingCustomer: false });
    const source = {
      id: 'source-1',
      targetType: 'LEAD',
      fieldMap: {
        fullName: 'name',
        phone: 'phone',
        email: 'email',
        referenceCode: 'channel',
        branchCode: 'outlet',
        areaCode: 'area',
        notes: 'notes',
      },
    };
    const context = await targets.prepare(source);

    assert.deepEqual(
      await targets.importRecord(
        source,
        {
          name: 'Dewi Lestari',
          phone: '081234567890',
          email: 'dewi@example.com',
          channel: 'WEB',
          outlet: 'JKT',
          area: 'JAKARTA',
          notes: 'Interested in a ring',
        },
        actor,
        context,
      ),
      { status: 'created' },
    );
    assert.equal(calls.leads[0][1].referenceId, 'reference-1');
    assert.equal(calls.leads[0][1].branchId, 'branch-1');
    assert.equal(calls.leads[0][1].areaId, 'area-1');
  });

  it('maps appointments to an existing customer with a source-scoped idempotency key', async () => {
    const { calls, targets } = harness();
    const source = {
      id: 'source-1',
      targetType: 'APPOINTMENT',
      fieldMap: {
        externalId: 'id',
        branchCode: 'outlet',
        customerPhone: 'phone',
        serviceType: 'service',
        scheduledAt: 'scheduledAt',
      },
    };
    const context = await targets.prepare(source);
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();

    assert.deepEqual(
      await targets.importRecord(
        source,
        {
          id: 'appointment-42',
          outlet: 'JKT',
          phone: '081234567890',
          service: 'APPRAISAL',
          scheduledAt,
        },
        actor,
        context,
      ),
      { status: 'created' },
    );
    assert.equal(calls.appointments[0][1].customerId, 'customer-1');
    assert.equal(calls.appointments[0][2].sourceId, source.id);
    assert.notEqual(calls.appointments[0][2].keyHash, 'appointment-42');
  });

  it('maps transaction items through the transaction service', async () => {
    const { calls, targets } = harness({ products: [{ id: 'product-1', sku: 'RING-01' }] });
    const source = {
      id: 'source-1',
      targetType: 'TRANSACTION',
      fieldMap: {
        externalId: 'id',
        branchCode: 'outlet',
        customerPhone: 'phone',
        transactionTypeCode: 'type',
        items: 'items',
        itemDescription: 'description',
        itemWeightGram: 'weight',
        itemUnitPrice: 'unitPrice',
        itemProductSku: 'sku',
      },
    };
    const context = await targets.prepare(source);

    assert.deepEqual(
      await targets.importRecord(
        source,
        {
          id: 'transaction-8',
          outlet: 'JKT',
          phone: '081234567890',
          type: 'BUY',
          items: [{ description: 'Ring', weight: 2, unitPrice: 1_000_000, sku: 'RING-01' }],
        },
        actor,
        context,
      ),
      { status: 'created' },
    );
    assert.equal(calls.transactions[0][1].items[0].productId, 'product-1');
    assert.equal(calls.transactions[0][2].sourceId, source.id);
  });

  it('encrypts custom dataset payloads and deduplicates with a blind external key', async () => {
    const { calls, targets } = harness();
    const source = {
      id: 'source-1',
      targetType: 'DATASET',
      fieldMap: { externalId: 'id' },
    };
    const record = { id: 'stock-2025-01', quantity: 12 };

    assert.deepEqual(await targets.importRecord(source, record, actor, {}), { status: 'created' });
    const [sourceId, keyHash, encrypted] = calls.datasets[0];
    assert.equal(sourceId, source.id);
    assert.equal(keyHash, blindIndex('integration-record', `${source.id}:stock-2025-01`));
    assert.notEqual(encrypted, JSON.stringify(record));
    assert.deepEqual(
      JSON.parse(pii.decrypt(encrypted, `integrations.dataset:${source.id}`)),
      record,
    );

    const duplicate = harness({ datasetInserted: false });
    assert.deepEqual(await duplicate.targets.importRecord(source, record, actor, {}), {
      status: 'matched',
    });
  });

  it('rejects custom dataset records larger than 100 KB', async () => {
    const { targets } = harness();
    const source = {
      id: 'source-1',
      targetType: 'DATASET',
      fieldMap: { externalId: 'id' },
    };

    await assert.rejects(
      targets.importRecord(source, { id: 'large-record', payload: 'x'.repeat(100_000) }, actor, {}),
      (error) => error.status === 422 && error.details.some((item) => item.field === 'record'),
    );
  });

  it('requires customer identity mapping and channel for account-ID matching', async () => {
    const integrations = {
      findById: async () => null,
    };
    const service = createIntegrationService({
      uow: {
        repos: { integrations },
        run: async () => {},
      },
      pii,
      blindIndex,
      intake: {},
      leads: {},
      appointments: {},
      transactions: {},
      masterdata: {},
      bus: { subscribe() {}, publish() {} },
      logger: { error() {} },
      allowPrivateHosts: true,
    });
    const base = {
      name: 'Appointments',
      endpointUrl: 'https://example.test/appointments',
      targetType: 'APPOINTMENT',
      pagination: 'none',
      pageSize: 100,
      isActive: true,
      fieldMap: {
        externalId: 'id',
        branchCode: 'outlet',
        serviceType: 'service',
        scheduledAt: 'scheduledAt',
      },
    };

    await assert.rejects(
      service.create(actor, base),
      (error) =>
        error.status === 422 &&
        error.details.some((item) => item.field === 'customerAccountId|customerPhone'),
    );
    await assert.rejects(
      service.create(actor, {
        ...base,
        fieldMap: { ...base.fieldMap, customerAccountId: 'accountId' },
      }),
      (error) => error.status === 422 && error.details.some((item) => item.field === 'channel'),
    );
    await assert.rejects(
      service.create(actor, {
        ...base,
        targetType: 'CUSTOMER',
        fieldMap: { fullName: 'name', phone: 'phone', accountId: 'id' },
      }),
      (error) => error.status === 422 && error.details.some((item) => item.field === 'channel'),
    );
  });
});
