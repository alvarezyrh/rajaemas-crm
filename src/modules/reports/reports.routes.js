import { actorOf, queryOf } from '../../core/http/context.js';
import { ok } from '../../core/http/response.js';
import { v, validate } from '../../core/validation.js';

const querySchema = v.object({
  from: v.date(),
  to: v.date(),
  groupBy: v.oneOf(['area', 'city', 'branch', 'reference', 'tier']),
});

export function registerReportsRoutes(router, { reports, guard }) {
  router.get('/api/v1/reports', guard.authenticate, async (ctx) => {
    ok(ctx, reports.catalog(actorOf(ctx)));
  });

  router.get(
    '/api/v1/reports/:name',
    guard.authenticate,
    async (ctx, next) => {
      const report = reports.definition(ctx.params.name);
      await guard.authorize(report.permission)(ctx, next);
    },
    async (ctx) => {
      const query = validate(querySchema, queryOf(ctx));
      const data = await reports.run(actorOf(ctx), ctx.params.name, query);
      ok(ctx, data, { meta: { report: ctx.params.name } });
    },
  );
}
