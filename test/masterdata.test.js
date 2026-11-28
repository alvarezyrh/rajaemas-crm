/**
 * Master Data service — business rules and audit trail, with in-memory
 * repositories (no PostgreSQL needed).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMasterdataService } from '../src/modules/masterdata/masterdata.service.js';

const actor = {
  id: 'u-hq',
  role: 'HQ_STAFF',
  branchId: null,
  areaId: null,
  requestId: 'req-1',
  ip: '127.0.0.1',
};
const areaManager = { ...actor, id: 'u-area', role: 'AREA_MANAGER', areaId: 'a1' };

function fakeUow(seed = {}) {
  const audit = [];
  const state = {
    areas: new Map(Object.entries(seed.areas ?? {})),
    products: new Map(),
    productCategories: new Map(
      Object.entries(seed.productCategories ?? { 'c-active': { id: 'c-active', isActive: true } }),
    ),
    csAssignments: [...(seed.csAssignments ?? [])],
    users: seed.users ?? [
      { id: 'u-cs', fullName: 'CS', email: 'cs@x', role: 'CUSTOMER_SERVICE', branchId: 'b1' },
    ],
    branches: seed.branches ?? [
      { id: 'b1', code: 'JKT01', areaId: 'a1', isActive: true },
      { id: 'b3', code: 'SBY01', areaId: 'a2', isActive: true },
    ],
  };
  let seq = 0;
  const unique = (prefix) => `${prefix}-${++seq}`;
  const pgUniqueViolation = () => Object.assign(new Error('duplicate key'), { code: '23505' });

  const collection = (name, codes = new Set()) => ({
    async list(query = {}) {
      const rows = [...state[name].values()];
      // Copies, like the real repository which maps each row into a fresh object.
      return (query.includeInactive ? rows : rows.filter((r) => r.isActive !== false)).map((r) => ({
        ...r,
      }));
    },
    async findById(id) {
      const row = state[name].get(id);
      return row ? { ...row } : null;
    },
    async insert(fields) {
      if (fields.code && codes.has(fields.code)) throw pgUniqueViolation();
      if (fields.code) codes.add(fields.code);
      const id = unique(name);
      state[name].set(id, { id, isActive: true, ...fields });
      return id;
    },
    async update(id, fields) {
      const row = state[name].get(id);
      if (!row) return false;
      if (fields.code && codes.has(fields.code) && fields.code !== row.code)
        throw pgUniqueViolation();
      Object.assign(row, fields);
      return true;
    },
  });

  const repos = {
    audit: {
      async append(entry) {
        audit.push(entry);
      },
    },
    areas: collection('areas', new Set([...state.areas.values()].map((a) => a.code))),
    products: collection('products'),
    productCategories: {
      async findById(id) {
        return state.productCategories.get(id) ?? null;
      },
      async list() {
        return [...state.productCategories.values()];
      },
    },
    references: collection('references'),
    transactionTypes: collection('transactionTypes'),
    users: {
      async list({ active, role } = {}) {
        if (active === false) return [];
        return state.users.filter((u) => !role || u.role === role);
      },
    },
    branches: {
      async list({ areaId = null, branchId = null } = {}) {
        return state.branches.filter(
          (b) => (!areaId || b.areaId === areaId) && (!branchId || b.id === branchId),
        );
      },
      async listActive() {
        return state.branches;
      },
    },
    csAssignments: {
      async list({ userId = null } = {}) {
        return state.csAssignments.filter((r) => !userId || r.userId === userId);
      },
      async insert(fields) {
        const clash = state.csAssignments.some(
          (r) =>
            r.userId === fields.userId &&
            r.branchId === fields.branchId &&
            r.validFrom === fields.validFrom,
        );
        if (clash) throw pgUniqueViolation();
        const id = unique('cs');
        state.csAssignments.push({ id, ...fields });
        return id;
      },
      async remove(id) {
        const index = state.csAssignments.findIndex((r) => r.id === id);
        if (index === -1) return false;
        state.csAssignments.splice(index, 1);
        return true;
      },
      async countPrimary(branchId, excludeId = null) {
        return state.csAssignments.filter(
          (r) => r.branchId === branchId && r.isPrimary && !r.validTo && r.id !== excludeId,
        ).length;
      },
    },
  };

  return { repos, audit, state, run: (work) => work(repos) };
}

describe('Master data — catalogue rules', () => {
  it('creates an area and audits it in the same transaction', async () => {
    const uow = fakeUow();
    const service = createMasterdataService({ uow });
    const area = await service.areas.create(actor, {
      code: 'JKT',
      name: 'Jabodetabek',
      province: 'DKI Jakarta',
    });

    assert.equal(area.code, 'JKT');
    assert.equal(uow.audit.length, 1);
    assert.equal(uow.audit[0].action, 'AREA_CREATED');
    assert.equal(uow.audit[0].entityType, 'area');
    assert.equal(uow.audit[0].actor.id, 'u-hq');
    assert.deepEqual(uow.audit[0].diff.after, {
      code: 'JKT',
      name: 'Jabodetabek',
      province: 'DKI Jakarta',
    });
  });

  it('turns a duplicate code into a readable conflict', async () => {
    const uow = fakeUow({
      areas: { 'a-1': { id: 'a-1', code: 'JKT', name: 'x', isActive: true } },
    });
    const service = createMasterdataService({ uow });
    await assert.rejects(
      () => service.areas.create(actor, { code: 'JKT', name: 'Duplikat', province: 'DKI' }),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /area with this code already exists/i);
        return true;
      },
    );
  });

  it('records before/after values when updating, without leaking untouched fields', async () => {
    const uow = fakeUow({
      areas: { 'a-1': { id: 'a-1', code: 'JKT', name: 'Lama', province: 'DKI', isActive: true } },
    });
    const service = createMasterdataService({ uow });
    const updated = await service.areas.update(actor, 'a-1', { name: 'Baru' });

    assert.equal(updated.name, 'Baru');
    assert.equal(updated.province, 'DKI');
    assert.deepEqual(uow.audit[0].diff.fields, ['name']);
    assert.deepEqual(uow.audit[0].diff.before, { name: 'Lama' });
    assert.deepEqual(uow.audit[0].diff.after, { name: 'Baru' });
  });

  it('rejects an unknown entity on update', async () => {
    const service = createMasterdataService({ uow: fakeUow() });
    await assert.rejects(
      () => service.areas.update(actor, 'a-tidak-ada', { name: 'X' }),
      /Area not found/,
    );
  });

  it('refuses a product in an inactive or unknown category', async () => {
    const uow = fakeUow({
      productCategories: {
        'c-off': { id: 'c-off', code: 'OFF', name: 'Nonaktif', isActive: false },
      },
    });
    const service = createMasterdataService({ uow });

    for (const categoryId of ['c-off', 'c-tidak-ada']) {
      await assert.rejects(
        () => service.products.create(actor, { sku: 'X-1', name: 'Emas', categoryId }),
        (err) => {
          assert.equal(err.status, 422);
          assert.equal(err.details[0].field, 'categoryId');
          return true;
        },
        categoryId,
      );
    }
  });

  it('accepts a product in an active category and stores who created it', async () => {
    const uow = fakeUow();
    const service = createMasterdataService({ uow });
    const product = await service.products.create(actor, {
      sku: 'LM-1',
      name: 'LM REI 1 gram',
      categoryId: 'c-active',
      isBullion: true,
    });
    assert.equal(product.sku, 'LM-1');
    assert.equal(product.isBullion, true);
    assert.equal(uow.state.products.get(product.id).createdBy, 'u-hq');
  });
});

describe('Master data — CS assignments', () => {
  const valid = { userId: 'u-cs', branchId: 'b1', validFrom: '2026-11-01' };

  it('rejects staff or outlets outside the directory', async () => {
    const service = createMasterdataService({ uow: fakeUow() });
    await assert.rejects(
      () => service.csAssignments.create(actor, { ...valid, userId: 'u-tidak-ada' }),
      (err) => {
        assert.equal(err.status, 422);
        assert.equal(err.details[0].field, 'userId');
        assert.match(err.details[0].message, /not an active customer service account/);
        return true;
      },
    );
    await assert.rejects(
      () => service.csAssignments.create(actor, { ...valid, branchId: 'b-tidak-ada' }),
      (err) => {
        assert.equal(err.details[0].field, 'branchId');
        assert.match(err.details[0].message, /not an active outlet/);
        return true;
      },
    );
  });

  it('rejects a window that ends before it starts', async () => {
    const service = createMasterdataService({ uow: fakeUow() });
    await assert.rejects(
      () => service.csAssignments.create(actor, { ...valid, validTo: '2026-10-01' }),
      (err) => {
        assert.equal(err.details[0].field, 'validTo');
        return true;
      },
    );
  });

  it('allows only one primary officer per outlet', async () => {
    const uow = fakeUow({
      csAssignments: [{ id: 'cs-1', userId: 'u-lain', branchId: 'b1', isPrimary: true }],
    });
    const service = createMasterdataService({ uow });
    await assert.rejects(
      () => service.csAssignments.create(actor, { ...valid, isPrimary: true }),
      /already has a primary customer service officer/,
    );
    // A secondary assignment at the same outlet is fine.
    const created = await service.csAssignments.create(actor, { ...valid, isPrimary: false });
    assert.equal(created.userId, 'u-cs');
  });

  it('audits both ends of an assignment', async () => {
    const uow = fakeUow();
    const service = createMasterdataService({ uow });
    const created = await service.csAssignments.create(actor, valid);
    assert.equal(uow.audit[0].action, 'CS_ASSIGNMENT_CREATED');

    await service.csAssignments.remove(actor, created.id);
    assert.equal(uow.audit[1].action, 'CS_ASSIGNMENT_REMOVED');
    assert.equal(uow.audit[1].diff.before.userId, 'u-cs');
    assert.equal(uow.state.csAssignments.length, 0);
  });

  it('rejects removing an assignment that is already gone', async () => {
    const service = createMasterdataService({ uow: fakeUow() });
    await assert.rejects(
      () => service.csAssignments.remove(actor, 'cs-tidak-ada'),
      /CS assignment not found/,
    );
  });

  it('offers only customer-service staff inside the caller’s area, plus unassigned ones', async () => {
    const uow = fakeUow({
      users: [
        {
          id: 'u1',
          fullName: 'CS Jakarta',
          email: 'a',
          role: 'CUSTOMER_SERVICE',
          branchId: 'b1',
          branchCode: 'JKT01',
        },
        {
          id: 'u2',
          fullName: 'CS Surabaya',
          email: 'b',
          role: 'CUSTOMER_SERVICE',
          branchId: 'b3',
          branchCode: 'SBY01',
        },
        { id: 'u3', fullName: 'CS Lepas', email: 'c', role: 'CUSTOMER_SERVICE', branchId: null },
        // Not assignable as CS, even though they are active and in scope.
        { id: 'u4', fullName: 'Kepala Cabang', email: 'd', role: 'BRANCH_HEAD', branchId: 'b1' },
        { id: 'u5', fullName: 'Super Admin', email: 'e', role: 'SUPER_ADMIN', branchId: null },
      ],
    });
    const service = createMasterdataService({ uow });

    const forArea = (await service.csAssignments.staffOptions(areaManager)).map((u) => u.id);
    assert.deepEqual(forArea.sort(), ['u1', 'u3']);

    const forHq = (await service.csAssignments.staffOptions(actor)).map((u) => u.id);
    assert.deepEqual(forHq.sort(), ['u1', 'u2', 'u3']);
  });
});
