export function createInteractionRepository(db) {
  return Object.freeze({
    /**
     * @returns {string | null} the new interaction id; null when `externalRef` was already recorded
     *   (idempotensi pemrosesan webhook).
     */
    async insert({
      customerId,
      branchId,
      channel,
      direction,
      summary,
      externalRef,
      handledBy,
      occurredAt,
    }) {
      const { rows } = await db.query(
        `INSERT INTO customer_interactions
           (customer_id, branch_id, channel, direction, summary, external_ref, handled_by, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))
         ON CONFLICT (external_ref) DO NOTHING
         RETURNING interaction_id`,
        [
          customerId,
          branchId ?? null,
          channel,
          direction,
          summary,
          externalRef ?? null,
          handledBy ?? null,
          occurredAt ?? null,
        ],
      );
      return rows[0]?.interaction_id ?? null;
    },
  });
}
