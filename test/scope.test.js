import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  areaScopeOf,
  assertBranchAccess,
  assertOutletInScope,
  branchScopeOf,
  dataScopeOf,
  resolveBranchId,
  resolveScopedBranchId,
} from '../src/shared/scope.js';
import { outletScopeFilter, outletScopeSql } from '../src/shared/sql.js';

const outlet = { branchId: 'b1' };
const areaManager = { branchId: null, areaId: 'a1' };
const headOffice = { branchId: null, areaId: null };

/** Fake branch repository: b1 and b2 belong to area a1, b3 to area a2. */
const branches = {
  async isInArea(branchId, areaId) {
    return { a1: ['b1', 'b2'], a2: ['b3'] }[areaId]?.includes(branchId) ?? false;
  },
};

describe('Data scope by assignment', () => {
  it('outlet staff are bound to their own outlet and never to an area', () => {
    assert.deepEqual(dataScopeOf(outlet), { branchId: 'b1', areaId: null });
    // A row may still carry area_id through its outlet; it must not widen the scope.
    assert.equal(areaScopeOf({ branchId: 'b1', areaId: 'a1' }), null);
    assert.equal(branchScopeOf(outlet), 'b1');
  });

  it('area managers are bound to an area, head office to nothing', () => {
    assert.deepEqual(dataScopeOf(areaManager), { branchId: null, areaId: 'a1' });
    assert.deepEqual(dataScopeOf(headOffice), { branchId: null, areaId: null });
  });

  it('a missing areaId on an older token means "no area restriction"', () => {
    assert.equal(areaScopeOf({ branchId: null }), null);
  });
});

describe('Outlet access checks', () => {
  it('branch staff stay inside their own outlet', () => {
    assert.equal(resolveBranchId(outlet, undefined), 'b1');
    assert.throws(() => resolveBranchId(outlet, 'b2'), /outside your branch scope/);
    assert.doesNotThrow(() => assertBranchAccess(outlet, 'b1'));
  });

  it('head office must name an outlet, and may name any', async () => {
    assert.equal(await resolveScopedBranchId(branches, headOffice, 'b3'), 'b3');
    await assert.rejects(
      () => resolveScopedBranchId(branches, headOffice, undefined),
      /validation/i,
    );
  });

  it('area managers reach every outlet of their area and nothing beyond it', async () => {
    assert.equal(await resolveScopedBranchId(branches, areaManager, 'b1'), 'b1');
    assert.equal(await resolveScopedBranchId(branches, areaManager, 'b2'), 'b2');
    await assert.rejects(
      () => resolveScopedBranchId(branches, areaManager, 'b3'),
      /outside your area scope/,
    );
  });

  it('an unknown outlet is rejected for area managers too', async () => {
    await assert.rejects(
      () => assertOutletInScope(branches, areaManager, 'b9'),
      /outside your area scope/,
    );
  });

  it('head office passes the outlet check without a lookup', async () => {
    await assert.doesNotReject(assertOutletInScope(branches, headOffice, 'b9'));
  });
});

describe('Outlet scope SQL fragment', () => {
  it('is unrestricted for head office and binds nothing', () => {
    const params = [];
    assert.equal(outletScopeSql('branch_id', dataScopeOf(headOffice), params), 'TRUE');
    assert.deepEqual(params, []);
  });

  it('binds one parameter per outlet for outlet staff', () => {
    const params = [];
    assert.equal(outletScopeSql('branch_id', dataScopeOf(outlet), params), '(branch_id = $1)');
    assert.deepEqual(params, ['b1']);
  });

  it('resolves an area through the branches table', () => {
    const params = [];
    const sql = outletScopeSql('g.branch_id', dataScopeOf(areaManager), params);
    assert.equal(sql, '(g.branch_id IN (SELECT branch_id FROM branches WHERE area_id = $1))');
    assert.deepEqual(params, ['a1']);
  });

  it('ANDs both when a branch is picked inside an area, so it can never widen', () => {
    const params = [];
    const sql = outletScopeSql('branch_id', { branchId: 'b1', areaId: 'a1' }, params);
    assert.match(sql, /branch_id = \$1/);
    assert.match(sql, /area_id = \$2/);
    assert.match(sql, / AND /);
    assert.deepEqual(params, ['b1', 'a1']);
  });

  it('reuses one bound value across several columns', () => {
    const params = [];
    const filter = outletScopeFilter(dataScopeOf(areaManager), params);
    const home = filter('c.home_branch_id');
    const tx = filter('g.branch_id');
    assert.match(home, /c\.home_branch_id IN/);
    assert.match(tx, /g\.branch_id IN/);
    // Both fragments point at $1: the area id is pushed exactly once.
    assert.deepEqual(params, ['a1']);
    assert.match(home, /\$1/);
    assert.match(tx, /\$1/);
  });

  it('keeps pushing later parameters after the scope ones', () => {
    const params = [];
    const filter = outletScopeFilter(dataScopeOf(outlet), params);
    filter('branch_id');
    params.push(50);
    assert.deepEqual(params, ['b1', 50]);
  });
});
