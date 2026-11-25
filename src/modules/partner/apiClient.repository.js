const toClient = (row) =>
  row && {
    id: row.client_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    isActive: row.is_active,
    lastUsedAt: row.last_used_at,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };

/** API clients: machine credentials for other company systems (APPS, STORE). */
export function createApiClientRepository(db) {
  return Object.freeze({
    async list() {
      const { rows } = await db.query(
        `SELECT k.*, u.full_name AS created_by_name
         FROM api_clients k LEFT JOIN users u ON u.user_id = k.created_by
         ORDER BY k.is_active DESC, k.name`,
      );
      return rows.map(toClient);
    },

    async insert({ name, keyPrefix, keyHash, scopes, createdBy }) {
      const { rows } = await db.query(
        `INSERT INTO api_clients (name, key_prefix, key_hash, scopes, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, keyPrefix, keyHash, scopes, createdBy],
      );
      return toClient(rows[0]);
    },

    /** Includes the hash: only for verifying a presented key. */
    async findActiveByPrefix(keyPrefix) {
      const { rows } = await db.query(
        'SELECT * FROM api_clients WHERE key_prefix = $1 AND is_active',
        [keyPrefix],
      );
      return rows[0] ? { ...toClient(rows[0]), keyHash: rows[0].key_hash } : null;
    },

    async revoke(id) {
      const { rows } = await db.query(
        `UPDATE api_clients SET is_active = false, revoked_at = now()
         WHERE client_id = $1 AND is_active RETURNING *`,
        [id],
      );
      return toClient(rows[0]) ?? null;
    },

    /** Records use at most once a minute per client (keeps hot paths write-free). */
    async touchUsed(id) {
      await db.query(
        `UPDATE api_clients SET last_used_at = now()
         WHERE client_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
        [id],
      );
    },
  });
}
