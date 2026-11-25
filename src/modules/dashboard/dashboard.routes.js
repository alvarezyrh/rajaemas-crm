import { actorOf } from '../../core/http/context.js';
import { ok } from '../../core/http/response.js';
import { Permissions as P } from '../../security/rbac.js';
import { branchScopeOf } from '../../shared/scope.js';

export function registerDashboardRoutes(router, { uow, guard }) {
  router.get(
    '/api/v1/dashboard/summary',
    guard.authenticate,
    guard.authorize(P.DASHBOARD_READ),
    async (ctx) => {
      const branchId = branchScopeOf(actorOf(ctx));
      const { dashboard } = uow.repos;
      const [kpi, tiers, upcoming] = await Promise.all([
        dashboard.summary(branchId),
        dashboard.tierDistribution(branchId),
        dashboard.upcomingAppointments(branchId, 6),
      ]);
      ok(ctx, { kpi, tiers, upcoming });
    },
  );
}
