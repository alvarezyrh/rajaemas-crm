import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  can,
  Permissions as P,
  permissionsOf,
  roleMatrix,
  Roles,
  ROLE_ORDER,
} from '../src/security/rbac.js';

const ALL_ROLES = Object.values(Roles);
const ALL_PERMISSIONS = Object.values(P);

describe('RBAC — 7 roles (6 from the architecture doc + APPRAISER)', () => {
  it('covers every documented role and keeps the appraiser', () => {
    assert.equal(ALL_ROLES.length, 7);
    for (const role of [
      'SUPER_ADMIN',
      'HQ_STAFF',
      'AREA_MANAGER',
      'BRANCH_HEAD',
      'CUSTOMER_SERVICE',
      'DIGITAL_MARKETING',
      'APPRAISER',
    ])
      assert.ok(ALL_ROLES.includes(role), role);
  });

  it('grants every permission to the super admin only', () => {
    for (const permission of ALL_PERMISSIONS)
      assert.equal(can(Roles.SUPER_ADMIN, permission), true, permission);
    assert.equal(permissionsOf(Roles.SUPER_ADMIN).length, ALL_PERMISSIONS.length);
  });

  it('keeps global settings away from every role but the super admin', () => {
    assert.equal(can(Roles.HQ_STAFF, P.SETTINGS_MANAGE), false);
    for (const role of ALL_ROLES.filter((r) => r !== Roles.SUPER_ADMIN))
      assert.equal(can(role, P.SETTINGS_MANAGE), false, role);
  });

  it('does not lock head office out of staff management', () => {
    // Regression guard: moving user:manage to SUPER_ADMIN only would strand the
    // seeded head-office account.
    assert.equal(can(Roles.HQ_STAFF, P.USER_MANAGE), true);
    assert.equal(can(Roles.HQ_STAFF, P.INTEGRATION_MANAGE), true);
  });

  it('never gives master-data writes to outlet or campaign roles', () => {
    for (const role of [
      Roles.AREA_MANAGER,
      Roles.BRANCH_HEAD,
      Roles.CUSTOMER_SERVICE,
      Roles.DIGITAL_MARKETING,
      Roles.APPRAISER,
    ]) {
      assert.equal(can(role, P.MASTERDATA_MANAGE), false, role);
      assert.equal(can(role, P.OUTLET_MANAGE), false, role);
      assert.equal(can(role, P.USER_MANAGE), false, role);
      assert.equal(can(role, P.MASTERDATA_READ), true, `${role} must read master data`);
    }
  });

  it('keeps buyback approval with the branch head, never with the appraiser', () => {
    assert.equal(can(Roles.BRANCH_HEAD, P.APPRAISAL_APPROVE), true);
    assert.equal(can(Roles.APPRAISER, P.APPRAISAL_APPROVE), false);
    assert.equal(can(Roles.APPRAISER, P.APPRAISAL_WRITE), true);
    assert.equal(can(Roles.AREA_MANAGER, P.APPRAISAL_APPROVE), false);
  });

  it('lets customer service and supervisors work leads, but not marketing', () => {
    for (const role of [Roles.CUSTOMER_SERVICE, Roles.BRANCH_HEAD, Roles.AREA_MANAGER])
      assert.equal(can(role, P.LEAD_CONVERT), true, role);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.LEAD_CONVERT), false);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.LEAD_READ), true);
  });

  it('gives marketing its own tools and no identity data', () => {
    assert.equal(can(Roles.DIGITAL_MARKETING, P.BLAST_MANAGE), true);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.BUDGET_MANAGE), true);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.REVIEW_MANAGE), true);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.CUSTOMER_PII_REVEAL), false);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.CUSTOMER_WRITE), false);
    assert.equal(can(Roles.DIGITAL_MARKETING, P.TRANSACTION_WRITE), false);
  });

  it('reserves the role matrix and live turnover for supervisors', () => {
    assert.equal(can(Roles.SUPER_ADMIN, P.ROLE_READ), true);
    assert.equal(can(Roles.HQ_STAFF, P.ROLE_READ), true);
    for (const role of [
      Roles.AREA_MANAGER,
      Roles.BRANCH_HEAD,
      Roles.CUSTOMER_SERVICE,
      Roles.DIGITAL_MARKETING,
      Roles.APPRAISER,
    ])
      assert.equal(can(role, P.ROLE_READ), false, role);

    for (const role of [Roles.AREA_MANAGER, Roles.BRANCH_HEAD])
      assert.equal(can(role, P.LIVE_OMSET_READ), true, role);
    assert.equal(can(Roles.CUSTOMER_SERVICE, P.LIVE_OMSET_READ), false);
    assert.equal(can(Roles.APPRAISER, P.LIVE_OMSET_READ), false);
  });

  it('lets outlet heads and area managers staff their own CS officers', () => {
    assert.equal(can(Roles.BRANCH_HEAD, P.STAFFING_MANAGE), true);
    assert.equal(can(Roles.AREA_MANAGER, P.STAFFING_MANAGE), true);
    assert.equal(can(Roles.CUSTOMER_SERVICE, P.STAFFING_MANAGE), false);
  });

  it('an unknown role can do nothing', () => {
    assert.equal(can('ROLE_TIDAK_ADA', P.CUSTOMER_READ), false);
    assert.deepEqual(permissionsOf('ROLE_TIDAK_ADA'), []);
  });

  it('exposes the matrix for the read-only Roles screen, most privileged first', () => {
    const matrix = roleMatrix();
    assert.deepEqual(
      matrix.map((row) => row.role),
      [...ROLE_ORDER],
    );
    assert.equal(matrix[0].role, Roles.SUPER_ADMIN);
    assert.equal(matrix[0].permissions.length, ALL_PERMISSIONS.length);
    for (const row of matrix) assert.ok(Array.isArray(row.permissions), row.role);
  });
});
