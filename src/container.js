import { createCache } from './infra/cache.js';
import { createDatabase } from './infra/database.js';
import { createEventBus } from './infra/eventBus.js';
import { buildRepositories } from './infra/repositories.js';
import { createUnitOfWork } from './infra/unitOfWork.js';
import { createAppointmentService } from './modules/appointments/appointment.service.js';
import { createAppraisalService } from './modules/appraisals/appraisal.service.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createCustomerIntake } from './modules/customers/customer.intake.js';
import { createCustomerService } from './modules/customers/customer.service.js';
import { createCustomerTransfer } from './modules/customers/customer.transfer.js';
import { createHealth } from './modules/health/health.js';
import { createIntegrationService } from './modules/integrations/integration.service.js';
import { createInteractionService } from './modules/interactions/interaction.service.js';
import { createPartnerService } from './modules/partner/partner.service.js';
import { createSegmentService } from './modules/segments/segment.service.js';
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

  const customers = createCustomerService({ uow, pii, blindIndex });
  const auth = createAuthService({ uow, tokens, cache });
  const intake = createCustomerIntake({ uow, customers, blindIndex });
  const services = Object.freeze({
    auth,
    users: createUserService({ uow, auth }),
    customers,
    interactions: createInteractionService({ uow, customers, blindIndex, logger }),
    appointments: createAppointmentService({ uow, ...config.appointments }),
    appraisals: createAppraisalService({ uow }),
    segments: createSegmentService({ uow, customers, intake, logger }),
    customerTransfer: createCustomerTransfer({ uow, customers, pii, blindIndex }),
    partner: createPartnerService({ uow, pii, blindIndex }),
    integrations: createIntegrationService({
      uow,
      pii,
      bus,
      logger,
      intake,
      allowPrivateHosts: config.integrations.allowPrivateHosts,
    }),
  });

  bus.subscribe(OMNICHANNEL_EVENTS.INBOUND, (event) =>
    services.interactions.recordInboundMessage(event),
  );
  bus.subscribe(COMMERCE_EVENT, (event) => services.segments.ingestCommerceEvent(event));
  bus.subscribe(OMNICHANNEL_EVENTS.STATUS, (event) =>
    logger.info('omnichannel.delivery_status', { eventId: event.eventId, status: event.status }),
  );

  return Object.freeze({
    config,
    logger,
    db,
    cache,
    bus,
    uow,
    services,
    health: createHealth({ db, cache }),

    async dispose() {
      await bus.drain();
      await Promise.allSettled([db.close(), cache.close()]);
    },
  });
}
