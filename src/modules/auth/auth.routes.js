import { actorOf } from '../../core/http/context.js';
import { ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';

const loginSchema = v.object({
  email: v.string({ required: true, max: 160, transform: (s) => s.toLowerCase() }),
  password: v.string({ required: true, min: 8, max: 200 }),
});
const accountSchema = v.object({
  fullName: v.string({ required: true, min: 2, max: 120 }),
});
const passwordSchema = v.object({
  currentPassword: v.string({ required: true, max: 200 }),
  newPassword: v.string({ required: true, max: 200 }),
});

export function registerAuthRoutes(router, { auth, guard }) {
  router.post('/api/v1/auth/login', guard.loginLimiter, async (ctx) => {
    const input = validate(loginSchema, ctx.body);
    const result = await auth.login(input, { requestId: ctx.requestId, ip: ctx.ip });
    ok(ctx, result);
  });

  router.post('/api/v1/auth/logout', guard.authenticate, async (ctx) => {
    await auth.logout(ctx.state.user.sessionId);
    ok(ctx, null);
  });

  router.get('/api/v1/auth/me', guard.authenticate, async (ctx) => {
    ok(ctx, await auth.profile(ctx.state.user.id));
  });

  /* Own account settings — every signed-in user. */
  router.get('/api/v1/account', guard.authenticate, async (ctx) => {
    ok(ctx, await auth.account(ctx.state.user.id));
  });

  router.patch('/api/v1/account', guard.authenticate, async (ctx) => {
    ok(ctx, await auth.updateAccount(actorOf(ctx), validate(accountSchema, ctx.body)));
  });

  // Same limiter as login: this endpoint also checks a password.
  router.post('/api/v1/account/password', guard.authenticate, guard.loginLimiter, async (ctx) => {
    ok(ctx, await auth.changePassword(actorOf(ctx), validate(passwordSchema, ctx.body)));
  });

  router.post('/api/v1/account/sessions/revoke-others', guard.authenticate, async (ctx) => {
    ok(ctx, await auth.signOutOtherSessions(actorOf(ctx)));
  });
}
