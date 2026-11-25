import { randomUUID } from 'node:crypto';
import { Errors } from '../../core/errors.js';
import { hashPassword, verifyPassword } from '../../security/crypto.js';
import { permissionsOf } from '../../security/rbac.js';
import { passwordProblem } from '../../shared/password.js';
import { withoutSecret } from './user.repository.js';

const sessionKey = (sessionId) => `sess:${sessionId}`;
// Sessions created before this timestamp (ms) are no longer valid for the user.
const revokedKey = (userId) => `revoked:${userId}`;

/**
 * Staff authentication: signed token + session in the cache (Redis) so logout
 * and revocation apply across every instance.
 *
 * Revocation: role/branch changes, deactivation, password resets and password
 * changes call `revokeAllSessions`, which stores a "revoked before" timestamp.
 * Every session remembers when it was created and is rejected if older —
 * the token's cached role/branch claims can therefore never outlive a change.
 */
export function createAuthService({ uow, tokens, cache }) {
  // Dummy hash for unknown emails → equal response time (no user enumeration).
  const dummyHash = hashPassword(randomUUID());

  const publicUser = (user) => ({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    branchId: user.branchId,
    branchCode: user.branchCode,
    mustChangePassword: user.mustChangePassword,
    permissions: permissionsOf(user.role),
  });

  async function openSession(user, issuedAt = Date.now()) {
    const sessionId = randomUUID();
    await cache.set(
      sessionKey(sessionId),
      { userId: user.id, issuedAt, mustChangePassword: user.mustChangePassword },
      tokens.ttlSec,
    );
    const token = tokens.issue({
      sub: user.id,
      sid: sessionId,
      role: user.role,
      branchId: user.branchId,
      name: user.fullName,
    });
    return { sessionId, token };
  }

  async function account(userId) {
    const user = await uow.repos.users.findById(userId);
    if (!user) throw Errors.notFound('User');
    return withoutSecret(user);
  }

  async function revokeAllSessions(userId, at = Date.now()) {
    await cache.set(revokedKey(userId), at, tokens.ttlSec);
    return at;
  }

  return Object.freeze({
    revokeAllSessions,

    async login({ email, password }, meta) {
      const user = await uow.repos.users.findByEmail(email);
      const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
      if (!user || !user.isActive || !valid) {
        throw Errors.unauthorized('Incorrect email or password');
      }

      const { token } = await openSession(user);
      await uow.repos.users.touchLogin(user.id);
      await uow.repos.audit.append({
        actor: { id: user.id, ...meta },
        action: 'AUTH_LOGIN',
        entityType: 'user',
        entityId: user.id,
      });
      return { token, expiresIn: tokens.ttlSec, user: publicUser(user) };
    },

    async resolveSession(token) {
      const claims = tokens.verify(token);
      if (!claims) throw Errors.unauthorized('Invalid or expired token');
      const [session, revokedBefore] = await Promise.all([
        cache.get(sessionKey(claims.sid)),
        cache.get(revokedKey(claims.sub)),
      ]);
      if (!session || session.userId !== claims.sub)
        throw Errors.unauthorized('Your session has ended');
      if (revokedBefore !== null && !(session.issuedAt > revokedBefore)) {
        await cache.del(sessionKey(claims.sid));
        throw Errors.unauthorized('Your session has ended. Please sign in again.');
      }

      return Object.freeze({
        id: claims.sub,
        role: claims.role,
        branchId: claims.branchId ?? null,
        name: claims.name,
        sessionId: claims.sid,
        mustChangePassword: Boolean(session.mustChangePassword),
      });
    },

    async logout(sessionId) {
      await cache.del(sessionKey(sessionId));
    },

    async profile(userId) {
      const user = await uow.repos.users.findById(userId);
      if (!user) throw Errors.notFound('User');
      return publicUser(user);
    },

    /* ------------------------------------------------------------------ */
    /* Own account (Settings)                                              */
    /* ------------------------------------------------------------------ */
    account,

    async updateAccount(actor, { fullName }) {
      await uow.run(async ({ users, audit }) => {
        await users.updateName(actor.id, fullName);
        await audit.append({
          actor,
          action: 'ACCOUNT_UPDATED',
          entityType: 'user',
          entityId: actor.id,
          diff: { fullName },
        });
      });
      return account(actor.id);
    },

    /**
     * Changes the caller's password, signs out every other device, and returns
     * a fresh token for this device (the old one is revoked with the rest).
     */
    async changePassword(actor, { currentPassword, newPassword }) {
      const user = await uow.repos.users.findById(actor.id);
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw Errors.validation([{ field: 'currentPassword', message: 'is incorrect' }]);
      }
      const problem = passwordProblem(newPassword, user);
      if (problem) throw Errors.validation([{ field: 'newPassword', message: problem }]);
      if (await verifyPassword(newPassword, user.passwordHash)) {
        throw Errors.validation([
          { field: 'newPassword', message: 'must be different from the current password' },
        ]);
      }

      await uow.run(async ({ users, audit }) => {
        await users.setPassword(actor.id, await hashPassword(newPassword), { mustChange: false });
        await audit.append({
          actor,
          action: 'PASSWORD_CHANGED',
          entityType: 'user',
          entityId: actor.id,
        });
      });
      await cache.del(sessionKey(actor.sessionId));
      const revokedAt = await revokeAllSessions(actor.id);
      const { token } = await openSession({ ...user, mustChangePassword: false }, revokedAt + 1);
      return { token, expiresIn: tokens.ttlSec };
    },

    /** Signs out every other device; this device keeps working with a new token. */
    async signOutOtherSessions(actor) {
      const user = await uow.repos.users.findById(actor.id);
      await cache.del(sessionKey(actor.sessionId));
      const revokedAt = await revokeAllSessions(actor.id);
      const { token } = await openSession(user, revokedAt + 1);
      await uow.repos.audit.append({
        actor,
        action: 'SESSIONS_REVOKED',
        entityType: 'user',
        entityId: actor.id,
        diff: { scope: 'other devices' },
      });
      return { token, expiresIn: tokens.ttlSec };
    },
  });
}
