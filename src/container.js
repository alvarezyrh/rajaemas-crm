import { createCache } from './infra/cache.js';
import { createDatabase } from './infra/database.js';
import { createEventBus } from './infra/eventBus.js';
import { createReadModel } from './infra/readModel.js';
import { buildRepositories } from './infra/repositories.js';
import { createUnitOfWork } from './infra/unitOfWork.js';
import { createAppointmentService } from './modules/appointments/appointment.service.js';
import { createAppraisalService } from './modules/appraisals/appraisal.service.js';
import { createAdvertisingService } from './modules/advertising/advertising.service.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createBranchService } from './modules/branches/branch.service.js';
import { createCustomerIntake } from './modules/customers/customer.intake.js';
import { createCustomerService } from './modules/customers/customer.service.js';
import { createCustomerTransfer } from './modules/customers/customer.transfer.js';
import { createHealth } from './modules/health/health.js';
import { createIntegrationService } from './modules/integrations/integration.service.js';
import { createInteractionService } from './modules/interactions/interaction.service.js';
import { createLeadService } from './modules/leads/lead.service.js';
import { createLiveOmsetService } from './modules/liveomset/liveOmset.service.js';
import { createJobRunner } from './infra/jobs.js';
import { createMasterdataService } from './modules/masterdata/masterdata.service.js';
import { createPartnerService } from './modules/partner/partner.service.js';
import { createQmsService } from './modules/qms/qms.service.js';
import { createReportsService } from './modules/reports/reports.service.js';
import { createReviewsService } from './modules/reviews/reviews.service.js';
import { createBlastService } from './modules/blasts/blast.service.js';
import { createMetaGateway } from './modules/blasts/metaGateway.js';
import { createSegmentService } from './modules/segments/segment.service.js';
import { createTransactionService } from './modules/transactions/transaction.service.js';
import { createUserService } from './modules/users/user.service.js';
import { COMMERCE_EVENT, OMNICHANNEL_EVENTS } from './modules/webhooks/webhook.routes.js';
import { createBlindIndexer, createPiiCipher } from './security/crypto.js';
import { createTokenService } from './security/token.js';

/**
 * Composition root: satu-satunya tempat dependensi dirakit.
 * Other layers receive dependencies as parameters (easy to test and swap).
 */
export async function buildContainer(config, logger) {
  const db = createDatabase(config.db, logger);
  const cache = await createCache({ redisUrl: config.redisUrl, logger });
  const bus = createEventBus(logger);
  const readModel = createReadModel({ db, cache, bus, logger });
  await readModel.reconcile();
  await readModel.hydrateCache();

  if (cache.kind === 'memory' && config.cluster.workers > 1) {
    logger.warn('cache.memory_with_cluster', {
      hint: 'Set REDIS_URL so sessions, rate limits and idempotency are shared across workers',
    });
  }

  const uow = createUnitOfWork(db, buildRepositories);
  const pii = createPiiCipher(config.security.piiKey);
  const blindIndex = createBlindIndexer(config.security.blindIndexKey);
  const tokens = createTokenService({
    secret: config.security.tokenSecret,
    ttlSec: config.security.tokenTtlSec,
  });

  const customers = createCustomerService({
    uow,
    pii,
    blindIndex,
    loyalRules: config.loyalty,
  });
  const branches = createBranchService({ uow });
  const auth = createAuthService({ uow, tokens, cache });
  const intake = createCustomerIntake({ uow, customers, blindIndex });
  const leads = createLeadService({ uow, pii, blindIndex, intake });
  const advertising = createAdvertisingService({ uow });
  const masterdata = createMasterdataService({ uow });
  const appointments = createAppointmentService({ uow, ...config.appointments });
  const transactions = createTransactionService({
    uow,
    customers,
    bonusRules: config.bonus,
    bus,
  });
  const qms = createQmsService({ uow });
  const reports = createReportsService({
    repository: uow.repos.reports,
    transactions,
    qms,
    leads,
    advertising,
  });
  const metaGateway = createMetaGateway({
    config: config.marketing.metaWhatsApp,
  });
  const services = Object.freeze({
    auth,
    users: createUserService({ uow, auth }),
    branches,
    masterdata,
    leads,
    advertising,
    transactions,
    qms,
    reports,
    reviews: createReviewsService({
      branches,
      apiKey: config.marketing.googlePlacesApiKey,
      logger,
    }),
    metaGateway,
    blasts: createBlastService({
      uow,
      pii,
      blindIndex,
      gateway: metaGateway,
      logger,
    }),
    liveOmset: createLiveOmsetService({ branches, cache }),
    customers,
    interactions: createInteractionService({
      uow,
      customers,
      blindIndex,
      logger,
    }),
    appointments,
    appraisals: createAppraisalService({ uow, bus }),
    segments: createSegmentService({ uow, customers, intake, logger, bus }),
    customerTransfer: createCustomerTransfer({
      uow,
      customers,
      pii,
      blindIndex,
    }),
    partner: createPartnerService({ uow, pii, blindIndex }),
    integrations: createIntegrationService({
      uow,
      pii,
      blindIndex,
      bus,
      logger,
      intake,
      leads,
      appointments,
      transactions,
      masterdata,
      allowPrivateHosts: config.integrations.allowPrivateHosts,
    }),
  });
  const jobs = createJobRunner({ db, cache, logger });
  jobs.register({
    name: 'blast-worker',
    intervalMs: 10_000,
    shouldRun: () => services.blasts.hasPendingWork(),
    run: () => services.blasts.runScheduled(),
  });
  jobs.start();

  bus.subscribe(OMNICHANNEL_EVENTS.INBOUND, (event) =>
    services.interactions.recordInboundMessage(event),
  );
  bus.subscribe(COMMERCE_EVENT, (event) => services.segments.ingestCommerceEvent(event));
  bus.subscribe(OMNICHANNEL_EVENTS.STATUS, (event) =>
    logger.info('omnichannel.delivery_status', {
      eventId: event.eventId,
      status: event.status,
    }),
  );

  return Object.freeze({
    config,
    logger,
    db,
    cache,
    bus,
    readModel,
    jobs,
    uow,
    services,
    health: createHealth({ db, cache }),

    async dispose() {
      await jobs.stop();
      readModel.stop();
      await bus.drain();
      await Promise.allSettled([db.close(), cache.close()]);
    },
  });
}
