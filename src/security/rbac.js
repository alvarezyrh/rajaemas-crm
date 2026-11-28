export const Roles = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN', // system owner: every permission
  HQ_STAFF: 'HQ_STAFF', // head office / management & executive
  AREA_MANAGER: 'AREA_MANAGER', // supervises every outlet in one area
  BRANCH_HEAD: 'BRANCH_HEAD', // outlet head
  CUSTOMER_SERVICE: 'CUSTOMER_SERVICE', // customer service team
  DIGITAL_MARKETING: 'DIGITAL_MARKETING', // campaigns, budgets, reviews
  APPRAISER: 'APPRAISER', // appraiser
});

export const Permissions = Object.freeze({
  DASHBOARD_READ: 'dashboard:read',
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_WRITE: 'customer:write',
  CUSTOMER_PII_REVEAL: 'customer:pii:reveal',
  INTERACTION_WRITE: 'interaction:write',
  APPOINTMENT_READ: 'appointment:read',
  APPOINTMENT_WRITE: 'appointment:write',
  APPRAISAL_READ: 'appraisal:read',
  APPRAISAL_WRITE: 'appraisal:write',
  APPRAISAL_APPROVE: 'appraisal:approve',
  SEGMENT_READ: 'segment:read',
  TRANSACTION_WRITE: 'transaction:write',
  TRANSACTION_READ: 'transaction:read',
  QMS_READ: 'qms:read',
  QMS_WRITE: 'qms:write',
  RATING_WRITE: 'rating:write',
  INTEGRATION_MANAGE: 'integration:manage',
  USER_MANAGE: 'user:manage',
  // Master Data & Access Control
  MASTERDATA_READ: 'masterdata:read',
  MASTERDATA_MANAGE: 'masterdata:manage',
  OUTLET_MANAGE: 'outlet:manage',
  STAFFING_MANAGE: 'staffing:manage',
  ROLE_READ: 'role:read',
  SETTINGS_MANAGE: 'settings:manage',
  // Leads & acquisition
  LEAD_READ: 'lead:read',
  LEAD_WRITE: 'lead:write',
  LEAD_CONVERT: 'lead:convert',
  BUDGET_READ: 'budget:read',
  BUDGET_MANAGE: 'budget:manage',
  // Marketing & reputation
  BLAST_READ: 'blast:read',
  BLAST_MANAGE: 'blast:manage',
  REVIEW_READ: 'review:read',
  REVIEW_MANAGE: 'review:manage',
  // Reporting
  REPORT_EXECUTIVE: 'report:executive',
  REPORT_OUTLET_RATING: 'report:outlet_rating',
  LMREI_READ: 'lmrei:read',
  LIVE_OMSET_READ: 'live_omset:read',
});

const P = Permissions;
const R = Roles;

/** Every permission except the ones reserved for the system owner. */
const ALL_BUT_SETTINGS = Object.values(P).filter((p) => p !== P.SETTINGS_MANAGE);

/** Read access to operational data, shared by supervisory roles. */
const OPERATIONAL_READ = [
  P.DASHBOARD_READ,
  P.CUSTOMER_READ,
  P.INTERACTION_WRITE,
  P.APPOINTMENT_READ,
  P.APPOINTMENT_WRITE,
  P.APPRAISAL_READ,
  P.SEGMENT_READ,
  P.MASTERDATA_READ,
];

/** Reporting menus gated by permission; row-level isolation is done by scope. */
const REPORTING = [P.REPORT_EXECUTIVE, P.REPORT_OUTLET_RATING, P.LMREI_READ, P.LIVE_OMSET_READ];

const LEADS_FULL = [P.LEAD_READ, P.LEAD_WRITE, P.LEAD_CONVERT];

const MATRIX = Object.freeze({
  [R.SUPER_ADMIN]: new Set(Object.values(P)),
  // Head office keeps user & integration management so existing admin accounts
  // do not lose access; only global settings are reserved for SUPER_ADMIN.
  [R.HQ_STAFF]: new Set(ALL_BUT_SETTINGS),
  // Supervises several outlets: reads and coaching, never master data or accounts.
  [R.AREA_MANAGER]: new Set([
    ...OPERATIONAL_READ,
    P.CUSTOMER_WRITE,
    P.CUSTOMER_PII_REVEAL,
    P.TRANSACTION_READ,
    P.TRANSACTION_WRITE,
    P.QMS_READ,
    P.STAFFING_MANAGE,
    ...LEADS_FULL,
    P.BUDGET_READ,
    P.REVIEW_READ,
    ...REPORTING,
  ]),
  // Partner API integrations, staff accounts and master data span every branch:
  // head office only. An outlet head runs their own outlet, including CS staffing.
  [R.BRANCH_HEAD]: new Set(
    ALL_BUT_SETTINGS.filter(
      (p) =>
        p !== P.INTEGRATION_MANAGE &&
        p !== P.USER_MANAGE &&
        p !== P.MASTERDATA_MANAGE &&
        p !== P.OUTLET_MANAGE &&
        p !== P.ROLE_READ &&
        p !== P.BLAST_MANAGE &&
        p !== P.BUDGET_MANAGE &&
        p !== P.REVIEW_MANAGE,
    ),
  ),
  [R.CUSTOMER_SERVICE]: new Set([
    P.DASHBOARD_READ,
    P.CUSTOMER_READ,
    P.CUSTOMER_WRITE,
    P.CUSTOMER_PII_REVEAL,
    P.INTERACTION_WRITE,
    P.APPOINTMENT_READ,
    P.APPOINTMENT_WRITE,
    P.APPRAISAL_READ,
    P.SEGMENT_READ,
    P.MASTERDATA_READ,
    // CS runs the counter: the queue, the sale and the service rating.
    P.TRANSACTION_READ,
    P.TRANSACTION_WRITE,
    P.QMS_READ,
    P.QMS_WRITE,
    P.RATING_WRITE,
    ...LEADS_FULL,
  ]),
  // Campaigns and reputation only: customer names are visible, PII is not.
  // Deliberately no REPORT_EXECUTIVE — bonus, queue and transaction performance
  // are operational data, not marketing data (the architecture doc keeps them
  // restricted). Marketing reads its own numbers via budget:read and lead:read.
  [R.DIGITAL_MARKETING]: new Set([
    P.DASHBOARD_READ,
    P.CUSTOMER_READ,
    P.SEGMENT_READ,
    P.MASTERDATA_READ,
    P.LEAD_READ,
    P.BUDGET_READ,
    P.BUDGET_MANAGE,
    P.BLAST_READ,
    P.BLAST_MANAGE,
    P.REVIEW_READ,
    P.REVIEW_MANAGE,
    P.REPORT_OUTLET_RATING,
  ]),
  [R.APPRAISER]: new Set([
    P.DASHBOARD_READ,
    P.CUSTOMER_READ,
    P.APPOINTMENT_READ,
    P.APPRAISAL_READ,
    P.APPRAISAL_WRITE,
    P.TRANSACTION_READ,
    P.TRANSACTION_WRITE,
    P.QMS_READ,
    P.QMS_WRITE,
    P.MASTERDATA_READ,
    P.LMREI_READ,
  ]),
});

export function can(role, permission) {
  return MATRIX[role]?.has(permission) ?? false;
}

export function permissionsOf(role) {
  return [...(MATRIX[role] ?? [])];
}

/** Role list in display order (most privileged first). */
export const ROLE_ORDER = Object.freeze([
  R.SUPER_ADMIN,
  R.HQ_STAFF,
  R.AREA_MANAGER,
  R.BRANCH_HEAD,
  R.CUSTOMER_SERVICE,
  R.DIGITAL_MARKETING,
  R.APPRAISER,
]);

/** The whole matrix, for the read-only Roles screen. */
export function roleMatrix() {
  return ROLE_ORDER.map((role) => ({
    role,
    permissions: permissionsOf(role),
  }));
}
