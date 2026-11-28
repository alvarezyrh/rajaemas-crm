import { Errors } from '../core/errors.js';

/**
 * Data scope by assignment:
 * - Staff tied to an outlet (`branchId` set) only see that outlet's data.
 * - Area managers (`areaId` set, no outlet) see every outlet in their area.
 * - Head office staff (both null) see everything.
 *
 * A permission decides *which menu opens*; the scope decides *which rows are visible*.
 */
export const branchScopeOf = (actor) => actor.branchId ?? null;

/** An outlet-bound actor is never area-scoped, even if an area id lingers on the row. */
export const areaScopeOf = (actor) => (actor.branchId ? null : (actor.areaId ?? null));

/** Filter object handed to repositories; `{ branchId: null, areaId: null }` = unrestricted. */
export const dataScopeOf = (actor) =>
  Object.freeze({ branchId: branchScopeOf(actor), areaId: areaScopeOf(actor) });

export function assertBranchAccess(actor, branchId) {
  if (actor.branchId && actor.branchId !== branchId) {
    throw Errors.forbidden('This record is outside your branch scope');
  }
}

/** Branch staff always use their own branch; head office must pick one. */
export function resolveBranchId(actor, requestedBranchId) {
  if (actor.branchId) {
    assertBranchAccess(actor, requestedBranchId ?? actor.branchId);
    return actor.branchId;
  }
  if (!requestedBranchId) throw Errors.validation([{ field: 'branchId', message: 'is required' }]);
  return requestedBranchId;
}

/**
 * Area managers may only act inside their own area. Membership lives in the
 * `branches` table, so the check needs a read (`branches.isInArea`).
 */
export async function assertOutletInScope(branches, actor, branchId) {
  assertBranchAccess(actor, branchId);
  const areaId = areaScopeOf(actor);
  if (areaId && !(await branches.isInArea(branchId, areaId))) {
    throw Errors.forbidden('This record is outside your area scope');
  }
}

/** `resolveBranchId` plus the area check, for writes by area managers. */
export async function resolveScopedBranchId(branches, actor, requestedBranchId) {
  const branchId = resolveBranchId(actor, requestedBranchId);
  await assertOutletInScope(branches, actor, branchId);
  return branchId;
}
