import { ok } from '../../core/http/response.js';

export function registerBranchRoutes(router, { uow, guard }) {
  router.get('/api/v1/branches', guard.authenticate, async (ctx) => {
    ok(ctx, await uow.repos.branches.listActive());
  });
}
