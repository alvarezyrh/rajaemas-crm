import { createAppointmentRepository } from '../modules/appointments/appointment.repository.js';
import { createAppraisalRepository } from '../modules/appraisals/appraisal.repository.js';
import { createApiClientRepository } from '../modules/partner/apiClient.repository.js';
import { createAuditRepository } from '../modules/audit/audit.repository.js';
import { createUserRepository } from '../modules/auth/user.repository.js';
import { createBranchRepository } from '../modules/branches/branch.repository.js';
import { createCustomerRepository } from '../modules/customers/customer.repository.js';
import { createDashboardRepository } from '../modules/dashboard/dashboard.repository.js';
import { createIntegrationRepository } from '../modules/integrations/integration.repository.js';
import { createInteractionRepository } from '../modules/interactions/interaction.repository.js';
import { createSegmentRepository } from '../modules/segments/segment.repository.js';

/** Builds every repository on one executor (the pool or a transaction client). */
export const buildRepositories = (executor) =>
  Object.freeze({
    users: createUserRepository(executor),
    branches: createBranchRepository(executor),
    customers: createCustomerRepository(executor),
    interactions: createInteractionRepository(executor),
    appointments: createAppointmentRepository(executor),
    appraisals: createAppraisalRepository(executor),
    dashboard: createDashboardRepository(executor),
    segments: createSegmentRepository(executor),
    integrations: createIntegrationRepository(executor),
    apiClients: createApiClientRepository(executor),
    audit: createAuditRepository(executor),
  });
