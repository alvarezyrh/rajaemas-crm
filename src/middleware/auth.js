import { Errors } from '../core/errors.js';
import { can } from '../security/rbac.js';

/** Endpoints still usable while an account must change its (temporary) password. */
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/v1/auth/me',
  '/api/v1/auth/logout',
  '/api/v1/account',
  '/api/v1/account/password',
]);

/** Validates the Bearer token + live session, then puts the identity in `ctx.state.user`. */
export function authenticate(authService) {
  return async (ctx, next) => {
    const header = ctx.req.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw Errors.unauthorized();

    ctx.state.user = await authService.resolveSession(token);
    if (ctx.state.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(ctx.path)) {
      throw Errors.passwordChangeRequired();
    }
    await next();
  };
}

/** RBAC: the user's role must hold every listed permission. */
export function authorize(...permissions) {
  return async (ctx, next) => {
    const { user } = ctx.state;
    if (!user || !permissions.every((permission) => can(user.role, permission))) {
      throw Errors.forbidden();
    }
    await next();
  };
}
