export const Roles = Object.freeze({
  HQ_STAFF: 'HQ_STAFF', // head office
  BRANCH_HEAD: 'BRANCH_HEAD', // branch head
  APPRAISER: 'APPRAISER', // appraiser
  CUSTOMER_SERVICE: 'CUSTOMER_SERVICE', // customer service team
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
  INTEGRATION_MANAGE: 'integration:manage',
  USER_MANAGE: 'user:manage',
});

const P = Permissions;

const MATRIX = Object.freeze({
  [Roles.HQ_STAFF]: new Set(Object.values(P)),
  // Partner API integrations and staff accounts span every branch: head office only.
  [Roles.BRANCH_HEAD]: new Set(
    Object.values(P).filter((p) => p !== P.INTEGRATION_MANAGE && p !== P.USER_MANAGE),
  ),
  [Roles.APPRAISER]: new Set([
    P.DASHBOARD_READ,
    P.CUSTOMER_READ,
    P.APPOINTMENT_READ,
    P.APPRAISAL_READ,
    P.APPRAISAL_WRITE,
    P.TRANSACTION_WRITE,
  ]),
  [Roles.CUSTOMER_SERVICE]: new Set([
    P.DASHBOARD_READ,
    P.CUSTOMER_READ,
    P.CUSTOMER_WRITE,
    P.CUSTOMER_PII_REVEAL,
    P.INTERACTION_WRITE,
    P.APPOINTMENT_READ,
    P.APPOINTMENT_WRITE,
    P.APPRAISAL_READ,
    P.SEGMENT_READ,
  ]),
});

export function can(role, permission) {
  return MATRIX[role]?.has(permission) ?? false;
}

export function permissionsOf(role) {
  return [...(MATRIX[role] ?? [])];
}
