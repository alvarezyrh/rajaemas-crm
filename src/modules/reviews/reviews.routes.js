import { actorOf } from '../../core/http/context.js';
import { ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';
import { Permissions as P } from '../../security/rbac.js';

const idParams = v.object({ id: v.uuid({ required: true }) });

export function registerReviewsRoutes(router, { reviews, guard }) {
  router.get(
    '/api/v1/reviews/outlets/:id',
    guard.authenticate,
    guard.authorize(P.REVIEW_READ),
    async (ctx) => {
      const { id } = validate(idParams, ctx.params);
      ok(ctx, await reviews.outlet(actorOf(ctx), id));
    },
  );
}
