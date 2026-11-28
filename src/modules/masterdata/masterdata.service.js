import { Errors } from '../../core/errors.js';
import { Roles } from '../../security/rbac.js';
import { dataScopeOf } from '../../shared/scope.js';

/** Turns a unique-violation into a readable 409; anything else is re-thrown. */
function duplicate(err, message) {
  if (err.code === '23505') throw Errors.conflict(message);
  throw err;
}

/**
 * Master Data service — areas, references, product categories, products,
 * transaction types and CS assignments.
 *
 * Knows nothing about HTTP: it receives `actor` and writes the audit trail
 * inside the same transaction as the change it records.
 */
export function createMasterdataService({ uow }) {
  /**
   * One CRUD surface per entity. `beforeSave` may enrich or reject the input
   * (async, outside the transaction) before anything is written.
   */
  function crud(repoName, { entity, action, duplicateMessage, beforeSave }) {
    const prepare = (input) => (beforeSave ? beforeSave(uow.repos, input) : input);
    // audit_logs.entity_type is lowercase snake_case, like every existing entry.
    const entityType = entity.toLowerCase().replace(/\s+/g, '_');

    async function get(id) {
      const found = await uow.repos[repoName].findById(id);
      if (!found) throw Errors.notFound(entity);
      return found;
    }

    return Object.freeze({
      list(query) {
        return uow.repos[repoName].list(query);
      },

      get,

      async create(actor, input) {
        const record = await prepare(input);
        try {
          return await uow.run(async (repos) => {
            const id = await repos[repoName].insert({ ...record, createdBy: actor.id });
            await repos.audit.append({
              actor,
              action: `${action}_CREATED`,
              entityType,
              entityId: id,
              diff: { after: input },
            });
            return repos[repoName].findById(id);
          });
        } catch (err) {
          duplicate(err, duplicateMessage);
        }
      },

      async update(actor, id, input) {
        const record = await prepare(input);
        const before = await get(id);
        try {
          return await uow.run(async (repos) => {
            const changed = await repos[repoName].update(id, record);
            if (!changed) throw Errors.notFound(entity);
            const after = await repos[repoName].findById(id);
            await repos.audit.append({
              actor,
              action: `${action}_UPDATED`,
              entityType,
              entityId: id,
              diff: {
                fields: Object.keys(input),
                before: Object.fromEntries(Object.keys(input).map((k) => [k, before[k]])),
                after: Object.fromEntries(Object.keys(input).map((k) => [k, after[k]])),
              },
            });
            return after;
          });
        } catch (err) {
          duplicate(err, duplicateMessage);
        }
      },
    });
  }

  /** A product must sit in an active category (when it has one). */
  async function checkCategory(repos, input) {
    if (!input.categoryId) return input;
    const category = await repos.productCategories.findById(input.categoryId);
    if (!category || !category.isActive) {
      throw Errors.validation([{ field: 'categoryId', message: 'is not an active category' }]);
    }
    return input;
  }

  const csAssignments = Object.freeze({
    list(query) {
      return uow.repos.csAssignments.list(query);
    },

    /**
     * Staff selectable for a CS assignment, already narrowed to the caller's
     * scope. Exists because `staffing:manage` holders may not read `/users`.
     * Only customer-service accounts are assignable: they are the ones whose
     * service rating and bonus are measured per outlet.
     */
    async staffOptions(actor) {
      const scope = dataScopeOf(actor);
      const [users, outlets] = await Promise.all([
        uow.repos.users.list({ active: true, role: Roles.CUSTOMER_SERVICE }),
        uow.repos.branches.list({ areaId: scope.areaId, branchId: scope.branchId }),
      ]);
      const visible = new Set(outlets.map((o) => o.id));
      return users
        .filter((u) => u.branchId === null || visible.has(u.branchId))
        .map((u) => ({
          id: u.id,
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          branchCode: u.branchCode ?? null,
        }));
    },

    async create(actor, input) {
      const [users, branches] = await Promise.all([
        uow.repos.users.list({ active: true, role: Roles.CUSTOMER_SERVICE }),
        uow.repos.branches.listActive(),
      ]);
      if (!users.some((u) => u.id === input.userId))
        throw Errors.validation([
          { field: 'userId', message: 'is not an active customer service account' },
        ]);
      if (!branches.some((b) => b.id === input.branchId))
        throw Errors.validation([{ field: 'branchId', message: 'is not an active outlet' }]);
      if (input.validTo && input.validTo < input.validFrom) {
        throw Errors.validation([{ field: 'validTo', message: 'is before the start date' }]);
      }
      // One primary CS per outlet, otherwise "who handled this" is ambiguous.
      if (input.isPrimary && (await uow.repos.csAssignments.countPrimary(input.branchId)) > 0) {
        throw Errors.conflict('That outlet already has a primary customer service officer');
      }

      try {
        return await uow.run(async (repos) => {
          const id = await repos.csAssignments.insert(input);
          await repos.audit.append({
            actor,
            action: 'CS_ASSIGNMENT_CREATED',
            entityType: 'cs_assignment',
            entityId: id,
            diff: { after: input },
          });
          const rows = await repos.csAssignments.list({ userId: input.userId });
          return rows.find((row) => row.id === id) ?? { id };
        });
      } catch (err) {
        duplicate(err, 'That staff member is already assigned to this outlet for the same period');
      }
    },

    /** Ends an assignment (the row is removed; the audit entry keeps the history). */
    async remove(actor, id) {
      const existing = await uow.repos.csAssignments.list({});
      const assignment = existing.find((row) => row.id === id);
      if (!assignment) throw Errors.notFound('CS assignment');
      await uow.run(async (repos) => {
        await repos.csAssignments.remove(id);
        await repos.audit.append({
          actor,
          action: 'CS_ASSIGNMENT_REMOVED',
          entityType: 'cs_assignment',
          entityId: id,
          diff: {
            before: {
              userId: assignment.userId,
              branchId: assignment.branchId,
              validFrom: assignment.validFrom,
              validTo: assignment.validTo,
            },
          },
        });
      });
      return { removed: true };
    },
  });

  return Object.freeze({
    areas: crud('areas', {
      entity: 'Area',
      action: 'AREA',
      duplicateMessage: 'An area with this code already exists',
    }),
    references: crud('references', {
      entity: 'Reference',
      action: 'REFERENCE',
      duplicateMessage: 'A reference with this code already exists',
    }),
    productCategories: crud('productCategories', {
      entity: 'Product category',
      action: 'PRODUCT_CATEGORY',
      duplicateMessage: 'A category with this code already exists',
    }),
    products: crud('products', {
      entity: 'Product',
      action: 'PRODUCT',
      duplicateMessage: 'A product with this SKU already exists',
      beforeSave: checkCategory,
    }),
    transactionTypes: crud('transactionTypes', {
      entity: 'Transaction type',
      action: 'TRANSACTION_TYPE',
      duplicateMessage: 'A transaction type with this code already exists',
    }),
    csAssignments,
  });
}
