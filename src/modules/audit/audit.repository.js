/** Append-only audit trail, written inside the same transaction as the change it records. */
export function createAuditRepository(db) {
  return Object.freeze({
    async append({ actor, action, entityType, entityId, diff = {} }) {
      await db.query(
        `INSERT INTO audit_logs
           (actor_id, action, entity_type, entity_id, payload_diff, request_id, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          actor?.id ?? null,
          action,
          entityType,
          entityId ?? null,
          JSON.stringify(diff),
          actor?.requestId ?? null,
          actor?.ip ?? null,
        ],
      );
    },
  });
}
