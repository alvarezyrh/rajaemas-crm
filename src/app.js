import path from 'node:path';

import { Errors } from './core/errors.js';
import { jsonBody } from './core/http/body.js';
import { createContext } from './core/http/context.js';
import { compose } from './core/http/pipeline.js';
import { Router } from './core/http/router.js';
import { createStaticHandler } from './core/http/static.js';
import { accessLog } from './middleware/accessLog.js';
import { authenticate, authorize } from './middleware/auth.js';
import { errorBoundary } from './middleware/errorBoundary.js';
import { idempotency } from './middleware/idempotency.js';
import { rateLimit } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { registerAppointmentRoutes } from './modules/appointments/appointment.routes.js';
import { registerAppraisalRoutes } from './modules/appraisals/appraisal.routes.js';
import { registerAdvertisingRoutes } from './modules/advertising/advertising.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerBranchRoutes } from './modules/branches/branch.routes.js';
import { registerCustomerRoutes } from './modules/customers/customer.routes.js';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { registerHealthRoutes } from './modules/health/health.js';
import { registerIntegrationRoutes } from './modules/integrations/integration.routes.js';
import { registerInteractionRoutes } from './modules/interactions/interaction.routes.js';
import { registerLeadRoutes } from './modules/leads/lead.routes.js';
import { registerLiveOmsetRoutes } from './modules/liveomset/liveOmset.routes.js';
import { registerMasterdataRoutes } from './modules/masterdata/masterdata.routes.js';
import { registerPartnerRoutes } from './modules/partner/partner.routes.js';
import { registerQmsRoutes } from './modules/qms/qms.routes.js';
import { registerReportsRoutes } from './modules/reports/reports.routes.js';
import { registerReviewsRoutes } from './modules/reviews/reviews.routes.js';
import { registerBlastRoutes } from './modules/blasts/blast.routes.js';
import { registerSegmentRoutes } from './modules/segments/segment.routes.js';
import { registerTransactionRoutes } from './modules/transactions/transaction.routes.js';
import { registerUserRoutes } from './modules/users/user.routes.js';
import { registerWebhookRoutes } from './modules/webhooks/webhook.routes.js';

const isProbe = (ctx) => ctx.path === '/healthz' || ctx.path === '/readyz';

function buildRouter({ config, cache, bus, uow, services, health }) {
  const guard = Object.freeze({
    authenticate: authenticate(services.auth),
    authorize,
    idempotency: idempotency({ cache }),
    loginLimiter: rateLimit({
      cache,
      name: 'login',
      limit: config.rateLimit.loginPerMinute,
      windowSec: 60,
    }),
  });

  const router = new Router();
  registerHealthRoutes(router, { health });
  registerAuthRoutes(router, { auth: services.auth, guard });
  registerBranchRoutes(router, { branches: services.branches, guard });
  registerMasterdataRoutes(router, { masterdata: services.masterdata, guard });
  registerDashboardRoutes(router, { uow, guard });
  registerCustomerRoutes(router, {
    customers: services.customers,
    transfer: services.customerTransfer,
    guard,
  });
  registerInteractionRoutes(router, {
    interactions: services.interactions,
    guard,
  });
  registerAppointmentRoutes(router, {
    appointments: services.appointments,
    guard,
  });
  registerAppraisalRoutes(router, { appraisals: services.appraisals, guard });
  registerSegmentRoutes(router, { segments: services.segments, guard });
  registerLeadRoutes(router, { leads: services.leads, guard });
  registerAdvertisingRoutes(router, {
    advertising: services.advertising,
    guard,
  });
  registerTransactionRoutes(router, {
    transactions: services.transactions,
    guard,
    bonusRules: config.bonus,
  });
  registerQmsRoutes(router, { qms: services.qms, guard });
  registerReportsRoutes(router, { reports: services.reports, guard });
  registerReviewsRoutes(router, { reviews: services.reviews, guard });
  registerBlastRoutes(router, {
    blasts: services.blasts,
    gateway: services.metaGateway,
    guard,
  });
  registerLiveOmsetRoutes(router, { liveOmset: services.liveOmset, guard });
  registerIntegrationRoutes(router, {
    integrations: services.integrations,
    guard,
  });
  registerUserRoutes(router, { users: services.users, guard });
  registerPartnerRoutes(router, { partner: services.partner, guard });
  registerWebhookRoutes(router, {
    cache,
    bus,
    webhookSecret: config.security.webhookSecret,
  });
  return router;
}

function dispatch(router, staticHandlers) {
  return async (ctx) => {
    const match = router.match(ctx.method, ctx.path);
    if (match?.handlers) {
      ctx.params = match.params;
      return compose(match.handlers)(ctx);
    }
    if (match) {
      ctx.res.setHeader('allow', match.allowed.join(', '));
      throw Errors.methodNotAllowed(match.allowed);
    }
    const isPageRequest =
      (ctx.method === 'GET' || ctx.method === 'HEAD') && !ctx.path.startsWith('/api/');
    if (isPageRequest) {
      for (const serve of staticHandlers) if (await serve(ctx)) return;
    }
    throw Errors.notFound('Endpoint');
  };
}

/** Merakit pipeline HTTP global → router → handler modul. */
export function createApp(container) {
  const { config, logger, cache } = container;
  const router = buildRouter(container);

  const pipeline = compose([
    accessLog(),
    errorBoundary(),
    securityHeaders({ hsts: config.isProduction }),
    rateLimit({
      cache,
      name: 'global',
      limit: config.rateLimit.globalPerMinute,
      windowSec: 60,
      skip: isProbe,
    }),
    jsonBody({ limitBytes: config.http.bodyLimitBytes }),
    dispatch(router, [
      // Font Awesome is served from the local npm package (no CDN): css/ and webfonts/ only.
      createStaticHandler(path.join(config.http.vendorDir.fontawesome, 'css'), {
        prefix: '/vendor/fontawesome/css',
        spaFallback: false,
        maxAge: 86400,
      }),
      createStaticHandler(path.join(config.http.vendorDir.fontawesome, 'webfonts'), {
        prefix: '/vendor/fontawesome/webfonts',
        spaFallback: false,
        maxAge: 86400,
      }),
      // Text font (Fontsource, local): only the woff2 files in files/.
      createStaticHandler(config.http.vendorDir.nunito, {
        prefix: '/vendor/fonts/nunito',
        spaFallback: false,
        maxAge: 86400,
      }),
      createStaticHandler(config.http.publicDir),
    ]),
  ]);

  return function handleRequest(req, res) {
    const ctx = createContext(req, res, {
      trustProxy: config.http.trustProxy,
      logger,
    });
    pipeline(ctx).catch((err) => {
      logger.error('http.pipeline_failure', { err, requestId: ctx.requestId });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  };
}
