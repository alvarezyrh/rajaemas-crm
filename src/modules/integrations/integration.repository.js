import { toNumber } from '../../shared/sql.js';

const toSource = (row) =>
  row && {
    id: row.source_id,
    name: row.name,
    endpointUrl: row.endpoint_url,
    authHeader: row.auth_header,
    hasToken: row.auth_token_encrypted !== null,
    channel: row.channel,
    listPath: row.list_path,
    fieldMap: row.field_map,
    targetType: row.target_type,
    datasetName: row.dataset_name,
    recordCount: toNumber(row.record_count ?? 0),
    pagination: row.pagination,
    pageSize: row.page_size,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRun: row.last_run ?? null,
  };

const toRun = (row) =>
  row && {
    id: row.run_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    status: row.status,
    fetched: toNumber(row.fetched),
    created: toNumber(row.created),
    matched: toNumber(row.matched),
    enriched: toNumber(row.enriched),
    skipped: toNumber(row.skipped),
    errorMessage: row.error_message,
    errors: row.errors,
    startedByName: row.started_by_name ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };

const LAST_RUN = `(
  SELECT json_build_object('id', r.run_id, 'status', r.status, 'fetched', r.fetched,
         'created', r.created, 'matched', r.matched, 'enriched', r.enriched, 'skipped', r.skipped,
         'errorMessage', r.error_message, 'startedAt', r.started_at, 'finishedAt', r.finished_at)
  FROM integration_runs r WHERE r.source_id = s.source_id
  ORDER BY r.started_at DESC LIMIT 1) AS last_run`;

export function createIntegrationRepository(db) {
  return Object.freeze({
    async list() {
      const { rows } = await db.query(
        `SELECT s.*, ${LAST_RUN},
                (SELECT count(*) FROM integration_dataset_records d
                 WHERE d.source_id = s.source_id) AS record_count
         FROM integration_sources s ORDER BY s.name`,
      );
      return rows.map(toSource);
    },

    async findById(id) {
      const { rows } = await db.query(
        `SELECT s.*, ${LAST_RUN},
                (SELECT count(*) FROM integration_dataset_records d
                 WHERE d.source_id = s.source_id) AS record_count
         FROM integration_sources s WHERE s.source_id = $1`,
        [id],
      );
      return toSource(rows[0]) ?? null;
    },

    /** Encrypted token, only for building the outbound request. */
    async findToken(id) {
      const { rows } = await db.query(
        'SELECT auth_token_encrypted FROM integration_sources WHERE source_id = $1',
        [id],
      );
      return rows[0]?.auth_token_encrypted ?? null;
    },

    async insert(s) {
      const { rows } = await db.query(
        `INSERT INTO integration_sources
           (name, endpoint_url, auth_header, auth_token_encrypted, channel, list_path,
            field_map, pagination, page_size, is_active, created_by, target_type, dataset_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          s.name,
          s.endpointUrl,
          s.authHeader,
          s.authTokenEncrypted,
          s.channel,
          s.listPath,
          JSON.stringify(s.fieldMap),
          s.pagination,
          s.pageSize,
          s.isActive,
          s.createdBy,
          s.targetType,
          s.datasetName,
        ],
      );
      return toSource(rows[0]);
    },

    /** `authTokenEncrypted: undefined` keeps the stored token. */
    async update(id, s) {
      const { rows } = await db.query(
        `UPDATE integration_sources SET
           name = $2, endpoint_url = $3, auth_header = $4,
           auth_token_encrypted = CASE WHEN $5::boolean THEN $6 ELSE auth_token_encrypted END,
           channel = $7, list_path = $8, field_map = $9, pagination = $10, page_size = $11,
           is_active = $12, target_type = $13, dataset_name = $14
         WHERE source_id = $1
         RETURNING *`,
        [
          id,
          s.name,
          s.endpointUrl,
          s.authHeader,
          s.authTokenEncrypted !== undefined,
          s.authTokenEncrypted ?? null,
          s.channel,
          s.listPath,
          JSON.stringify(s.fieldMap),
          s.pagination,
          s.pageSize,
          s.isActive,
          s.targetType,
          s.datasetName,
        ],
      );
      return toSource(rows[0]) ?? null;
    },

    async remove(id) {
      const { rowCount } = await db.query('DELETE FROM integration_sources WHERE source_id = $1', [
        id,
      ]);
      return rowCount > 0;
    },

    /** Marks syncs stuck by a crash/restart as failed so a new one can start. */
    async failStaleRuns(olderThanMinutes) {
      await db.query(
        `UPDATE integration_runs SET status = 'FAILED', finished_at = now(),
           error_message = 'Interrupted (server restarted or timed out)'
         WHERE status = 'RUNNING' AND started_at < now() - make_interval(mins => $1::int)`,
        [olderThanMinutes],
      );
    },

    /** @returns {Promise<object|null>} null when a sync for this source is already running. */
    async startRun(sourceId, startedBy) {
      const { rows } = await db.query(
        `INSERT INTO integration_runs (source_id, started_by) VALUES ($1, $2)
         ON CONFLICT (source_id) WHERE status = 'RUNNING' DO NOTHING
         RETURNING *`,
        [sourceId, startedBy],
      );
      return toRun(rows[0]) ?? null;
    },

    async finishRun(
      runId,
      { status, fetched, created, matched, enriched, skipped, errorMessage = null, errors = [] },
    ) {
      await db.query(
        `UPDATE integration_runs SET status = $2, fetched = $3, created = $4, matched = $5,
           enriched = $6, skipped = $7, error_message = $8, errors = $9, finished_at = now()
         WHERE run_id = $1`,
        [
          runId,
          status,
          fetched,
          created,
          matched,
          enriched,
          skipped,
          errorMessage?.slice(0, 500) ?? null,
          JSON.stringify(errors),
        ],
      );
    },

    async findRun(runId) {
      const { rows } = await db.query(
        `SELECT r.*, s.name AS source_name, u.full_name AS started_by_name
         FROM integration_runs r
         JOIN integration_sources s ON s.source_id = r.source_id
         LEFT JOIN users u ON u.user_id = r.started_by
         WHERE r.run_id = $1`,
        [runId],
      );
      return toRun(rows[0]) ?? null;
    },

    async recentRuns(limit) {
      const { rows } = await db.query(
        `SELECT r.*, s.name AS source_name, u.full_name AS started_by_name
         FROM integration_runs r
         JOIN integration_sources s ON s.source_id = r.source_id
         LEFT JOIN users u ON u.user_id = r.started_by
         ORDER BY r.started_at DESC
         LIMIT $1`,
        [limit],
      );
      return rows.map(toRun);
    },

    async findDatasetRecord(sourceId, externalKeyHash) {
      const { rows } = await db.query(
        `SELECT payload_encrypted FROM integration_dataset_records
         WHERE source_id = $1 AND external_key_hash = $2`,
        [sourceId, externalKeyHash],
      );
      return rows[0]?.payload_encrypted ?? null;
    },

    async upsertDatasetRecord(sourceId, externalKeyHash, payloadEncrypted) {
      const inserted = await db.query(
        `INSERT INTO integration_dataset_records (source_id, external_key_hash, payload_encrypted)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_id, external_key_hash) DO NOTHING`,
        [sourceId, externalKeyHash, payloadEncrypted],
      );
      if (inserted.rowCount > 0) return true;
      await db.query(
        `UPDATE integration_dataset_records SET payload_encrypted = $3
         WHERE source_id = $1 AND external_key_hash = $2`,
        [sourceId, externalKeyHash, payloadEncrypted],
      );
      return false;
    },

    async listDatasetRecords(sourceId, { limit, offset }) {
      const { rows } = await db.query(
        `SELECT record_id, external_key_hash, payload_encrypted, created_at, updated_at
         FROM integration_dataset_records
         WHERE source_id = $1
         ORDER BY updated_at DESC
         LIMIT $2 OFFSET $3`,
        [sourceId, limit, offset],
      );
      return rows;
    },
  });
}
