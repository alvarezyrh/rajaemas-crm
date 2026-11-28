import { Errors } from '../../core/errors.js';
import { actorOf } from '../../core/http/context.js';
import { created, ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const scheduleSchema = v.object({
  scheduledAt: v.string({ required: true, min: 1, max: 40 }),
});

export function registerBlastRoutes(router, { blasts, gateway, guard }) {
  const { authenticate, authorize } = guard;

  router.get('/api/v1/blasts', authenticate, authorize(P.BLAST_READ), async (ctx) => {
    ok(ctx, await blasts.list());
  });

  router.post('/api/v1/blasts/preview', authenticate, authorize(P.BLAST_MANAGE), async (ctx) => {
    ok(ctx, await blasts.preview(ctx.body?.criteria));
  });

  router.post('/api/v1/blasts', authenticate, authorize(P.BLAST_MANAGE), async (ctx) => {
    created(ctx, await blasts.create(actorOf(ctx), ctx.body ?? {}));
  });

  router.post(
    '/api/v1/blasts/:id/schedule',
    authenticate,
    authorize(P.BLAST_MANAGE),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      const { scheduledAt } = validate(scheduleSchema, ctx.body);
      ok(ctx, await blasts.schedule(actorOf(ctx), id, scheduledAt));
    },
  );

  router.post('/api/v1/blasts/:id/cancel', authenticate, authorize(P.BLAST_MANAGE), async (ctx) => {
    const { id } = validate(idParams, ctx.params);
    ok(ctx, await blasts.cancel(actorOf(ctx), id));
  });

  router.get('/api/v1/webhooks/meta', async (ctx) => {
    const challenge = ctx.query.get('hub.challenge');
    const valid = gateway.verifyWebhook(
      ctx.query.get('hub.mode'),
      ctx.query.get('hub.verify_token'),
    );
    if (!gateway.isWebhookConfigured()) {
      throw Errors.notImplemented('Meta webhook verification is not configured');
    }
    if (!valid || challenge === null || challenge.length > 200) {
      throw Errors.forbidden('Meta webhook verification failed');
    }
    ctx.response = { status: 200 };
    ctx.res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    ctx.res.end(challenge);
  });

  router.post('/api/v1/webhooks/meta', async (ctx) => {
    if (!gateway.isWebhookConfigured()) {
      throw Errors.notImplemented('Meta webhook signature verification is not configured');
    }
    if (!gateway.verifySignature(ctx.rawBody, ctx.req.headers['x-hub-signature-256'])) {
      throw Errors.unauthorized('Invalid Meta webhook signature');
    }
    ok(ctx, await blasts.handleWebhook(ctx.body));
  });
}
