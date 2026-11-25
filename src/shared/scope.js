import { Errors } from '../core/errors.js';

/**
 * Data scope by assignment:
 * - Staff tied to a branch (branchId set) only see that branch's data.
 * - Head office staff (branchId null) see everything.
 */
export const branchScopeOf = (actor) => actor.branchId ?? null;

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
