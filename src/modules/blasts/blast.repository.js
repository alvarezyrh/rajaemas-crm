const CHANNELS = new Set(['STORE', 'MOBILE_APP', 'ECOMMERCE']);

function criteriaWhere(criteria, params) {
  const where = ['c.marketing_consent IS TRUE', 'c.phone_encrypted IS NOT NULL'];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (criteria.city) where.push(`lower(c.city) = lower(${bind(criteria.city)})`);
  if (criteria.tierCode) where.push(`c.tier_code = ${bind(criteria.tierCode)}`);
  const channelFilters = [];
  for (const channel of criteria.channels ?? []) {
    if (channel === 'MULTI') {
      channelFilters.push(
        '(SELECT count(*) FROM customer_channels ch WHERE ch.customer_id = c.customer_id) > 1',
      );
    } else if (channel === 'NONE') {
      channelFilters.push(
        'NOT EXISTS (SELECT 1 FROM customer_channels ch WHERE ch.customer_id = c.customer_id)',
      );
    } else if (CHANNELS.has(channel)) {
      channelFilters.push(
        `EXISTS (SELECT 1 FROM customer_channels ch
         WHERE ch.customer_id = c.customer_id AND ch.channel = ${bind(channel)})`,
      );
    }
  }
  if (channelFilters.length) where.push(`(${channelFilters.join(' OR ')})`);
  if (criteria.lastTransactionDays) {
    where.push(
      `EXISTS (SELECT 1 FROM gold_transactions g
       WHERE g.customer_id = c.customer_id
         AND g.occurred_at >= now() - (${bind(criteria.lastTransactionDays)} * interval '1 day'))`,
    );
  }
  return where.join(' AND ');
}

function toBlast(row) {
  if (!row) return null;
  return {
    id: row.blast_id,
    name: row.name,
    templateName: row.template_name,
    languageCode: row.language_code,
    personalizeName: row.personalize_name,
    criteria: row.criteria,
    status: row.status,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentCount: Number(row.sent_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
  };
}

export function createBlastRepository(db) {
  return Object.freeze({
    async countEligible(criteria) {
      const params = [];
      const where = criteriaWhere(criteria, params);
      const { rows } = await db.query(
        `SELECT count(*)::int AS count
         FROM customers c
         WHERE ${where}`,
        params,
      );
      return rows[0].count;
    },

    async list() {
      const { rows } = await db.query(
        `SELECT d.*,
                count(*) FILTER (WHERE r.status IN ('SENT', 'DELIVERED', 'READ'))::int AS sent_count,
                count(*) FILTER (WHERE r.status = 'FAILED')::int AS failed_count,
                count(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped_count
         FROM dynamic_blasts d
         LEFT JOIN blast_recipients r ON r.blast_id = d.blast_id
         GROUP BY d.blast_id
         ORDER BY d.created_at DESC, d.blast_id`,
      );
      return rows.map(toBlast);
    },

    async findById(id) {
      const { rows } = await db.query(
        `SELECT d.*,
                count(*) FILTER (WHERE r.status IN ('SENT', 'DELIVERED', 'READ'))::int AS sent_count,
                count(*) FILTER (WHERE r.status = 'FAILED')::int AS failed_count,
                count(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped_count
         FROM dynamic_blasts d
         LEFT JOIN blast_recipients r ON r.blast_id = d.blast_id
         WHERE d.blast_id = $1
         GROUP BY d.blast_id`,
        [id],
      );
      return toBlast(rows[0]) ?? null;
    },

    async createDraft(input, actorId) {
      const { rows } = await db.query(
        `INSERT INTO dynamic_blasts
           (name, template_name, language_code, personalize_name, criteria, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING blast_id`,
        [
          input.name,
          input.templateName,
          input.languageCode,
          input.personalizeName,
          JSON.stringify(input.criteria),
          actorId,
        ],
      );
      return rows[0].blast_id;
    },

    async schedule(id, scheduledAt, criteria) {
      const params = [id];
      const where = criteriaWhere(criteria, params);
      await db.query(
        `INSERT INTO blast_recipients (blast_id, customer_id)
         SELECT $1, c.customer_id
         FROM customers c
         WHERE ${where}
         ON CONFLICT (blast_id, customer_id) DO NOTHING`,
        params,
      );
      const { rows } = await db.query(
        `UPDATE dynamic_blasts
         SET status = 'SCHEDULED', scheduled_at = $2
         WHERE blast_id = $1 AND status = 'DRAFT'
         RETURNING blast_id`,
        [id, scheduledAt],
      );
      return rows.length > 0;
    },

    async claimDue(limit = 10) {
      const { rows } = await db.query(
        `WITH due AS (
           SELECT blast_id FROM dynamic_blasts
           WHERE status = 'SCHEDULED' AND scheduled_at <= now()
           ORDER BY scheduled_at, blast_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         ), started AS (
           UPDATE dynamic_blasts d
           SET status = 'RUNNING'
           FROM due
           WHERE d.blast_id = due.blast_id
           RETURNING d.blast_id
         )
         INSERT INTO blast_runs (blast_id)
         SELECT blast_id FROM started
         RETURNING blast_id, blast_run_id`,
        [limit],
      );
      return rows;
    },

    async workSnapshot() {
      const { rows } = await db.query(
        `SELECT EXISTS (
           SELECT 1 FROM dynamic_blasts
           WHERE (status = 'SCHEDULED' AND scheduled_at <= now()) OR status = 'RUNNING'
         ) AS has_pending_work`,
      );
      return { hasPendingWork: rows[0].has_pending_work };
    },

    async activeRuns() {
      const { rows } = await db.query(
        `SELECT d.blast_id, d.template_name, d.language_code, d.personalize_name,
                r.blast_run_id
         FROM dynamic_blasts d
         JOIN blast_runs r ON r.blast_id = d.blast_id AND r.status = 'RUNNING'
         WHERE d.status = 'RUNNING'
         ORDER BY r.started_at, d.blast_id`,
      );
      return rows;
    },

    async failInterruptedRecipients() {
      const { rowCount } = await db.query(
        `UPDATE blast_recipients
         SET status = 'FAILED', error_code = 'UNKNOWN_DELIVERY'
         WHERE status = 'SENDING' AND sending_at < now() - interval '10 minutes'`,
      );
      return rowCount;
    },

    async skipRevokedQueued(blastId) {
      const { rowCount } = await db.query(
        `UPDATE blast_recipients r
         SET status = 'SKIPPED', error_code = 'CONSENT_REVOKED'
         FROM customers c
         WHERE r.blast_id = $1 AND r.customer_id = c.customer_id
           AND r.status = 'QUEUED' AND c.marketing_consent IS NOT TRUE`,
        [blastId],
      );
      return rowCount;
    },

    async claimQueued(blastId, runId, limit) {
      const { rows } = await db.query(
        `WITH candidates AS (
           SELECT r.blast_recipient_id, r.customer_id, c.phone_encrypted, c.full_name
           FROM blast_recipients r
           JOIN customers c ON c.customer_id = r.customer_id
           WHERE r.blast_id = $1 AND r.status = 'QUEUED'
             AND c.marketing_consent IS TRUE AND c.phone_encrypted IS NOT NULL
           ORDER BY r.queued_at, r.blast_recipient_id
           FOR UPDATE OF r SKIP LOCKED
           LIMIT $3
         )
         UPDATE blast_recipients r
         SET status = 'SENDING', blast_run_id = $2, attempts = attempts + 1
           , sending_at = now()
         FROM candidates c
         WHERE r.blast_recipient_id = c.blast_recipient_id
         RETURNING r.blast_recipient_id, r.customer_id, c.phone_encrypted, c.full_name`,
        [blastId, runId, limit],
      );
      return rows.map((row) => ({
        id: row.blast_recipient_id,
        customerId: row.customer_id,
        phoneEncrypted: row.phone_encrypted,
        fullName: row.full_name,
      }));
    },

    async isConsented(customerId) {
      const { rows } = await db.query(
        `SELECT marketing_consent IS TRUE AS consented
         FROM customers WHERE customer_id = $1`,
        [customerId],
      );
      return rows[0]?.consented === true;
    },

    async markSkipped(recipientId) {
      await db.query(
        `UPDATE blast_recipients
         SET status = 'SKIPPED', error_code = 'CONSENT_REVOKED'
         WHERE blast_recipient_id = $1 AND status = 'SENDING'`,
        [recipientId],
      );
    },

    async markSent(recipientId, messageId) {
      await db.query(
        `UPDATE blast_recipients
         SET status = 'SENT', provider_message_id = $2, sent_at = now(), error_code = NULL
         WHERE blast_recipient_id = $1 AND status = 'SENDING'`,
        [recipientId, messageId],
      );
    },

    async markFailed(recipientId, code) {
      await db.query(
        `UPDATE blast_recipients
         SET status = 'FAILED', error_code = $2
         WHERE blast_recipient_id = $1 AND status = 'SENDING'`,
        [recipientId, code],
      );
    },

    async updateProviderStatus(messageId, status) {
      const { rowCount } = await db.query(
        `UPDATE blast_recipients
         SET status = CASE
           WHEN $2 = 'READ' THEN 'READ'
           WHEN $2 = 'DELIVERED' AND status <> 'READ' THEN 'DELIVERED'
           WHEN $2 = 'FAILED' AND status NOT IN ('DELIVERED', 'READ') THEN 'FAILED'
           ELSE status
         END,
         delivered_at = CASE WHEN $2 IN ('DELIVERED', 'READ') THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
         read_at = CASE WHEN $2 = 'READ' THEN COALESCE(read_at, now()) ELSE read_at END,
         error_code = CASE WHEN $2 = 'FAILED' THEN 'META_DELIVERY_FAILED' ELSE error_code END
         WHERE provider_message_id = $1`,
        [messageId, status],
      );
      return rowCount > 0;
    },

    async finishIfDrained(blastId, runId) {
      const { rows } = await db.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('QUEUED', 'SENDING'))::int AS pending,
           count(*) FILTER (WHERE status IN ('SENT', 'DELIVERED', 'READ'))::int AS sent,
           count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped
         FROM blast_recipients WHERE blast_id = $1`,
        [blastId],
      );
      if (rows[0].pending > 0) return false;
      await db.query(
        `UPDATE blast_runs
         SET status = 'SUCCEEDED', sent_count = $2, failed_count = $3,
             skipped_count = $4, finished_at = now()
         WHERE blast_run_id = $1 AND status = 'RUNNING'`,
        [runId, rows[0].sent, rows[0].failed, rows[0].skipped],
      );
      await db.query(
        `UPDATE dynamic_blasts SET status = 'COMPLETED'
         WHERE blast_id = $1 AND status = 'RUNNING'`,
        [blastId],
      );
      return true;
    },

    async cancel(id) {
      const { rows } = await db.query(
        `UPDATE dynamic_blasts SET status = 'CANCELLED'
         WHERE blast_id = $1 AND status IN ('DRAFT', 'SCHEDULED')
         RETURNING blast_id`,
        [id],
      );
      if (!rows.length) return false;
      await db.query(
        `UPDATE blast_recipients
         SET status = 'SKIPPED', error_code = 'BLAST_CANCELLED'
         WHERE blast_id = $1 AND status = 'QUEUED'`,
        [id],
      );
      return true;
    },
  });
}
