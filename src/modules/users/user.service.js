import { Errors } from '../../core/errors.js';
import { hashPassword } from '../../security/crypto.js';
import { Roles } from '../../security/rbac.js';
import { temporaryPassword } from '../../shared/password.js';
import { withoutSecret } from '../auth/user.repository.js';

export const ROLES = Object.freeze(Object.values(Roles));
/** Roles that administer the whole company and are never tied to one outlet. */
const GLOBAL_ADMIN_ROLES = Object.freeze([Roles.SUPER_ADMIN, Roles.HQ_STAFF]);

/** Mirrors the users table constraints, with readable messages. */
const BRANCH_RULE = Object.freeze({
  [Roles.SUPER_ADMIN]: 'none', // sees every outlet
  [Roles.HQ_STAFF]: 'none', // head office sees every outlet
  [Roles.AREA_MANAGER]: 'none', // bound to an area instead of one outlet
  [Roles.BRANCH_HEAD]: 'required',
  [Roles.APPRAISER]: 'required',
  [Roles.CUSTOMER_SERVICE]: 'optional',
  [Roles.DIGITAL_MARKETING]: 'optional',
});

/** Staff user management (head office only). */
export function createUserService({ uow, auth }) {
  async function checkBranch(role, branchId) {
    const rule = BRANCH_RULE[role];
    if (rule === 'none' && branchId) {
      throw Errors.validation([
        { field: 'branchId', message: 'this role is not tied to a single outlet' },
      ]);
    }
    if (rule === 'required' && !branchId) {
      throw Errors.validation([{ field: 'branchId', message: 'is required for this role' }]);
    }
    if (branchId) {
      const active = await uow.repos.branches.listActive();
      if (!active.some((b) => b.id === branchId))
        throw Errors.validation([{ field: 'branchId', message: 'is not an active outlet' }]);
    }
    return rule === 'none' ? null : (branchId ?? null);
  }

  /** Only area managers carry an area; for them it is mandatory. */
  async function checkArea(role, areaId) {
    const required = role === Roles.AREA_MANAGER;
    if (required && !areaId) {
      throw Errors.validation([{ field: 'areaId', message: 'is required for an area manager' }]);
    }
    if (!required && areaId) {
      throw Errors.validation([
        { field: 'areaId', message: 'only area managers are tied to an area' },
      ]);
    }
    if (areaId) {
      const active = await uow.repos.areas.list();
      if (!active.some((a) => a.id === areaId))
        throw Errors.validation([{ field: 'areaId', message: 'is not an active area' }]);
    }
    return areaId ?? null;
  }

  async function requireUser(users, id, opts) {
    const user = await users.findById(id, opts);
    if (!user) throw Errors.notFound('User');
    return user;
  }

  return Object.freeze({
    list(query) {
      return uow.repos.users.list(query);
    },

    /** @returns {{ user, temporaryPassword }} — the password is shown once and never stored in clear. */
    async create(actor, input) {
      const branchId = await checkBranch(input.role, input.branchId);
      const areaId = await checkArea(input.role, input.areaId);
      const password = temporaryPassword();
      const passwordHash = await hashPassword(password);
      try {
        const user = await uow.run(async ({ users, audit }) => {
          const id = await users.insert({
            email: input.email,
            fullName: input.fullName,
            role: input.role,
            branchId,
            areaId,
            jobTitle: input.jobTitle ?? null,
            passwordHash,
          });
          await audit.append({
            actor,
            action: 'USER_CREATED',
            entityType: 'user',
            entityId: id,
            diff: { email: input.email, role: input.role, branchId, areaId },
          });
          return requireUser(users, id);
        });
        return { user: withoutSecret(user), temporaryPassword: password };
      } catch (err) {
        if (err.code === '23505')
          throw Errors.conflict('An account with this email already exists');
        throw err;
      }
    },

    async update(actor, id, input) {
      const branchId = await checkBranch(input.role, input.branchId);
      const areaId = await checkArea(input.role, input.areaId);
      const { before, after } = await uow.run(async ({ users, audit }) => {
        const current = await requireUser(users, id, { forUpdate: true });

        if (id === actor.id && (input.role !== current.role || !input.isActive)) {
          throw Errors.conflict('You cannot change your own role or deactivate your own account');
        }
        const losesAdmin =
          GLOBAL_ADMIN_ROLES.includes(current.role) &&
          current.isActive &&
          (!GLOBAL_ADMIN_ROLES.includes(input.role) || !input.isActive);
        if (losesAdmin && (await users.countOtherActiveHq(id)) === 0) {
          throw Errors.conflict('At least one active head office account is required');
        }

        const next = {
          fullName: input.fullName,
          role: input.role,
          branchId,
          areaId,
          jobTitle: input.jobTitle ?? null,
          isActive: input.isActive,
        };
        await users.update(id, next);
        const prev = {
          fullName: current.fullName,
          role: current.role,
          branchId: current.branchId,
          areaId: current.areaId,
          jobTitle: current.jobTitle,
          isActive: current.isActive,
        };
        await audit.append({
          actor,
          action: 'USER_UPDATED',
          entityType: 'user',
          entityId: id,
          diff: { before: prev, after: next },
        });
        return { before: current, after: next };
      });

      // Role, outlet, area and status live in the user's tokens: end their sessions
      // so the change applies now.
      const accessChanged =
        before.role !== after.role ||
        before.branchId !== after.branchId ||
        (before.areaId ?? null) !== after.areaId ||
        before.isActive !== after.isActive;
      if (accessChanged) await auth.revokeAllSessions(id);

      const user = await requireUser(uow.repos.users, id);
      return { user: withoutSecret(user), sessionsEnded: accessChanged };
    },

    async resetPassword(actor, id) {
      if (id === actor.id) throw Errors.conflict('Change your own password from Settings');
      const password = temporaryPassword();
      const passwordHash = await hashPassword(password);
      await uow.run(async ({ users, audit }) => {
        await requireUser(users, id, { forUpdate: true });
        await users.setPassword(id, passwordHash, { mustChange: true });
        await audit.append({
          actor,
          action: 'USER_PASSWORD_RESET',
          entityType: 'user',
          entityId: id,
        });
      });
      await auth.revokeAllSessions(id);
      return { temporaryPassword: password };
    },
  });
}
