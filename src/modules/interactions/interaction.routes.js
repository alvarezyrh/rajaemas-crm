import { actorOf } from '../../core/http/context.js';
import { created } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';
import { CHANNELS } from '../customers/customer.schema.js';

const idParams = v.object({ id: v.uuid({ required: true }) });
const logSchema = v.object({
  channel: v.oneOf(CHANNELS, { required: true }),
  direction: v.oneOf(['INBOUND', 'OUTBOUND'], { required: true }),
  summary: v.string({ required: true, min: 3, max: 500 }),
});

export function registerInteractionRoutes(router, { interactions, guard }) {
  router.post(
    '/api/v1/customers/:id/interactions',
    guard.authenticate,
    guard.authorize(P.INTERACTION_WRITE),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      const input = validate(logSchema, ctx.body);
      created(ctx, await interactions.log(actorOf(ctx), id, input));
    },
  );
}
