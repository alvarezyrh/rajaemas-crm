import { Errors } from '../../core/errors.js';
import { dataScopeOf } from '../../shared/scope.js';

/**
 * Outlet (branch) directory. Reads follow the caller's scope (one outlet, one
 * area, or everything); writes are head-office only and always audited inside
 * the same transaction.
 */
export function createBranchService({ uow }) {
  async function requireOutlet(id) {
    const outlet = await uow.repos.branches.findById(id);
    if (!outlet) throw Errors.notFound('Outlet');
    return outlet;
  }

  /** An outlet outside the caller's scope is reported as missing, not forbidden. */
  function assertVisible(scope, outlet) {
    if (scope.branchId && outlet.id !== scope.branchId) throw Errors.notFound('Outlet');
    if (scope.areaId && outlet.areaId !== scope.areaId) throw Errors.notFound('Outlet');
  }

  return Object.freeze({
    list(actor, { includeInactive }) {
      const scope = dataScopeOf(actor);
      return uow.repos.branches.list({
        includeInactive,
        branchId: scope.branchId,
        areaId: scope.areaId,
      });
    },

    async get(actor, id) {
      const outlet = await requireOutlet(id);
      assertVisible(dataScopeOf(actor), outlet);
      return outlet;
    },

    /** Partial update: only the fields present in `input` change. */
    async update(actor, id, input) {
      const before = await requireOutlet(id);
      return uow.run(async ({ branches, audit }) => {
        const updated = await branches.update(id, input);
        if (!updated) throw Errors.notFound('Outlet');
        const after = await branches.findById(id);
        const fields = Object.keys(input).filter((key) => input[key] !== undefined);
        await audit.append({
          actor,
          action: 'OUTLET_UPDATED',
          entityType: 'branch',
          entityId: id,
          diff: {
            fields,
            before: Object.fromEntries(fields.map((f) => [f, before[f]])),
            after: Object.fromEntries(fields.map((f) => [f, after[f]])),
          },
        });
        return after;
      });
    },
  });
}
