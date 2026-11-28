import { escapeLike, outletScopeFilter } from '../../shared/sql.js';
import { DEFAULT_LOYAL_RULES, loyalSql } from '../../shared/loyalty.js';

// birth_date is read as text: the pg driver would turn a DATE into a local-midnight Date.
const COLUMNS = `
  c.customer_id, c.full_name, c.phone_last4, c.email, c.tier_code, c.loyalty_points,
  c.preferred_channel, c.marketing_consent, c.home_branch_id, b.branch_code AS home_branch_code,
  (c.nik_hash IS NOT NULL) AS has_nik, (c.address_encrypted IS NOT NULL) AS has_address,
  c.birth_place, c.birth_date::text AS birth_date, c.gender, c.city, c.province, c.postal_code,
  c.occupation, c.kyc_source, c.kyc_updated_at, c.created_at, c.updated_at,
  ARRAY(SELECT ch.channel FROM customer_channels ch
        WHERE ch.customer_id = c.customer_id ORDER BY ch.first_seen_at) AS channels`;

const PII_COLUMNS = 'c.phone_encrypted, c.nik_encrypted, c.address_encrypted';

/** Writable profile fields → columns. Only these keys ever reach SQL (no injection surface). */
const WRITABLE = Object.freeze({
  fullName: 'full_name',
  email: 'email',
  preferredChannel: 'preferred_channel',
  marketingConsent: 'marketing_consent',
  homeBranchId: 'home_branch_id',
  birthPlace: 'birth_place',
  birthDate: 'birth_date',
  gender: 'gender',
  addressEncrypted: 'address_encrypted',
  city: 'city',
  province: 'province',
  postalCode: 'postal_code',
  occupation: 'occupation',
  kycSource: 'kyc_source',
});
const KYC_KEYS = new Set([
  'nikHash',
  'birthPlace',
  'birthDate',
  'gender',
  'addressEncrypted',
  'city',
  'province',
  'postalCode',
  'occupation',
]);

const withEncrypted = (row) => ({
  ...toCustomer(row),
  encrypted: { phone: row.phone_encrypted, nik: row.nik_encrypted, address: row.address_encrypted },
});

const FROM = 'FROM customers c LEFT JOIN branches b ON b.branch_id = c.home_branch_id';

const toCustomer = (row) =>
  row && {
    id: row.customer_id,
    fullName: row.full_name,
    phoneLast4: row.phone_last4,
    email: row.email,
    tierCode: row.tier_code,
    loyaltyPoints: row.loyalty_points,
    preferredChannel: row.preferred_channel,
    marketingConsent: row.marketing_consent,
    homeBranchId: row.home_branch_id,
    homeBranchCode: row.home_branch_code,
    hasNik: row.has_nik,
    hasAddress: row.has_address,
    birthPlace: row.birth_place,
    birthDate: row.birth_date,
    gender: row.gender,
    city: row.city,
    province: row.province,
    postalCode: row.postal_code,
    occupation: row.occupation,
    kycSource: row.kyc_source,
    kycUpdatedAt: row.kyc_updated_at,
    // Derived, not stored. `null` means the query did not compute it (e.g. partner pulls).
    isLoyal: row.is_loyal ?? null,
    channels: row.channels ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

/**
 * RBAC clause: outlet staff only see customers registered at their outlet (or
 * with an appointment / appraisal / transaction there); area managers see every
 * outlet in their area. Values are always bound ($n) — see `outletScopeFilter`.
 */
export function customerBranchScope(scope, params) {
  const outlet = outletScopeFilter(scope, params);
  const home = outlet('c.home_branch_id');
  if (home === 'TRUE') return 'TRUE';
  return `(${home}
    OR EXISTS (SELECT 1 FROM branch_appointments a WHERE a.customer_id = c.customer_id AND ${outlet('a.branch_id')})
    OR EXISTS (SELECT 1 FROM appraisal_records r WHERE r.customer_id = c.customer_id AND ${outlet('r.branch_id')})
    OR EXISTS (SELECT 1 FROM gold_transactions g WHERE g.customer_id = c.customer_id AND ${outlet('g.branch_id')}))`;
}

/** Cluster filter. Constant SQL fragments; only the channel value is bound as a parameter. */
function segmentClause(segment, params) {
  if (!segment) return null;
  if (segment === 'NONE') {
    return 'NOT EXISTS (SELECT 1 FROM customer_channels ch WHERE ch.customer_id = c.customer_id)';
  }
  if (segment === 'MULTI') {
    return '(SELECT count(*) FROM customer_channels ch WHERE ch.customer_id = c.customer_id) > 1';
  }
  params.push(segment);
  return `EXISTS (SELECT 1 FROM customer_channels ch
    WHERE ch.customer_id = c.customer_id AND ch.channel = $${params.length})`;
}

export function createCustomerRepository(db) {
  return Object.freeze({
    /** `withEncryptedPhone` is for audited exports only; the ciphertext never leaves the service. */
    async search({
      phoneHash,
      name,
      segment,
      scope,
      loyal,
      loyalRules = DEFAULT_LOYAL_RULES,
      limit,
      offset,
      withEncryptedPhone = false,
    }) {
      const params = [];
      // The derived "loyal" flag is fully parameterised, so it claims its placeholders first.
      const loyalExpr = loyalSql(loyalRules, params);
      const where = [customerBranchScope(scope, params)];
      const bySegment = segmentClause(segment, params);
      if (bySegment) where.push(bySegment);
      if (loyal === true) where.push(loyalExpr);
      if (loyal === false) where.push(`NOT ${loyalExpr}`);
      if (phoneHash) {
        params.push(phoneHash);
        where.push(`c.phone_hash = $${params.length}`);
      }
      if (name) {
        params.push(`%${escapeLike(name)}%`);
        where.push(`c.full_name ILIKE $${params.length}`);
      }
      params.push(limit, offset);

      const { rows } = await db.query(
        `SELECT ${COLUMNS}${withEncryptedPhone ? ', c.phone_encrypted, c.address_encrypted' : ''},
                ${loyalExpr} AS is_loyal,
                count(*) OVER () AS total_count ${FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY c.created_at DESC, c.customer_id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const items = rows.map((row) =>
        withEncryptedPhone
          ? {
              ...toCustomer(row),
              phoneEncrypted: row.phone_encrypted,
              addressEncrypted: row.address_encrypted,
            }
          : toCustomer(row),
      );
      return { items, total: rows.length ? Number(rows[0].total_count) : 0 };
    },

    async findById(id, scope = null, loyalRules = DEFAULT_LOYAL_RULES) {
      const params = [id];
      const filter = customerBranchScope(scope, params);
      const loyalExpr = loyalSql(loyalRules, params);
      const { rows } = await db.query(
        `SELECT ${COLUMNS}, ${loyalExpr} AS is_loyal ${FROM}
         WHERE c.customer_id = $1 AND ${filter}`,
        params,
      );
      return toCustomer(rows[0]) ?? null;
    },

    async findIdByNikHash(nikHash) {
      const { rows } = await db.query('SELECT customer_id FROM customers WHERE nik_hash = $1', [
        nikHash,
      ]);
      return rows[0]?.customer_id ?? null;
    },

    async findIdByPhoneHash(phoneHash) {
      const { rows } = await db.query('SELECT customer_id FROM customers WHERE phone_hash = $1', [
        phoneHash,
      ]);
      return rows[0]?.customer_id ?? null;
    },

    async findEncryptedPii(id, scope = null) {
      const params = [id];
      const filter = customerBranchScope(scope, params);
      const { rows } = await db.query(
        `SELECT ${PII_COLUMNS} FROM customers c WHERE c.customer_id = $1 AND ${filter}`,
        params,
      );
      return rows[0] ? withEncrypted(rows[0]).encrypted : null;
    },

    async insert(record) {
      const columns = [
        'phone_hash',
        'phone_encrypted',
        'phone_last4',
        'nik_hash',
        'nik_encrypted',
        'created_by',
      ];
      const values = [
        record.phoneHash,
        record.phoneEncrypted,
        record.phoneLast4,
        record.nikHash ?? null,
        record.nikEncrypted ?? null,
        record.createdBy,
      ];
      for (const [key, column] of Object.entries(WRITABLE)) {
        if (record[key] === undefined) continue;
        columns.push(column);
        values.push(record[key]);
      }
      const placeholders = values.map((_, i) => `$${i + 1}`);
      if (
        Object.keys(record).some(
          (key) => KYC_KEYS.has(key) && record[key] !== null && record[key] !== undefined,
        )
      ) {
        columns.push('kyc_updated_at');
        placeholders.push('now()');
      }

      const { rows } = await db.query(
        // Read the inserted row from the CTE (not the table): it is in the same snapshot.
        `WITH inserted AS (
           INSERT INTO customers (${columns.join(', ')})
           VALUES (${placeholders.join(', ')})
           RETURNING *
         )
         SELECT ${COLUMNS}
         FROM inserted c LEFT JOIN branches b ON b.branch_id = c.home_branch_id`,
        values,
      );
      return toCustomer(rows[0]);
    },

    /**
     * Updates profile fields. With `onlyBlank`, a value is written only where the
     * column is still empty — used for data from other systems, which must never
     * overwrite what staff or an earlier source already recorded.
     * @returns {Promise<boolean>} whether anything actually changed
     */
    async update(id, changes, { onlyBlank = false } = {}) {
      const params = [id];
      const sets = [];
      const differs = [];
      const bind = (value) => {
        params.push(value);
        return `$${params.length}`;
      };
      for (const [key, column] of Object.entries(WRITABLE)) {
        if (changes[key] === undefined) continue;
        const p = bind(changes[key]);
        // kyc_source is metadata: it follows a real change but never counts as one.
        if (key === 'kycSource') {
          sets.push(`${column} = ${p}`);
          continue;
        }
        sets.push(onlyBlank ? `${column} = COALESCE(${column}, ${p})` : `${column} = ${p}`);
        // onlyBlank callers never pass nulls, so "still empty" is the whole condition.
        differs.push(
          onlyBlank
            ? `${column} IS NULL`
            : `${column} IS DISTINCT FROM ${p}${column === 'birth_date' ? '::date' : ''}`,
        );
      }
      if (changes.nikHash !== undefined) {
        const [hash, enc] = [bind(changes.nikHash), bind(changes.nikEncrypted)];
        sets.push(onlyBlank ? `nik_hash = COALESCE(nik_hash, ${hash})` : `nik_hash = ${hash}`);
        sets.push(
          onlyBlank
            ? `nik_encrypted = CASE WHEN nik_hash IS NULL THEN ${enc} ELSE nik_encrypted END`
            : `nik_encrypted = ${enc}`,
        );
        differs.push(onlyBlank ? '(nik_hash IS NULL)' : `nik_hash IS DISTINCT FROM ${hash}`);
      }
      if (differs.length === 0) return false;
      if (Object.keys(changes).some((key) => KYC_KEYS.has(key)))
        sets.push('kyc_updated_at = now()');

      // Skip the write — and the updated_at bump partner pulls rely on — when nothing changes.
      const { rowCount } = await db.query(
        `UPDATE customers SET ${sets.join(', ')}
         WHERE customer_id = $1 AND (${differs.join(' OR ')})`,
        params,
      );
      return rowCount > 0;
    },

    /** @returns {{ loyaltyPoints: number, tierCode: string }} the balance after adding. */
    async addLoyaltyPoints(id, points) {
      const { rows } = await db.query(
        `UPDATE customers SET loyalty_points = loyalty_points + $2
         WHERE customer_id = $1
         RETURNING loyalty_points, tier_code`,
        [id, points],
      );
      return { loyaltyPoints: rows[0].loyalty_points, tierCode: rows[0].tier_code };
    },

    async updateTier(id, tierCode) {
      await db.query('UPDATE customers SET tier_code = $2 WHERE customer_id = $1', [id, tierCode]);
    },

    /**
     * Records where a customer came from (lead + acquisition channel). The first
     * attribution wins: an existing value is never overwritten, so a later
     * conversion cannot rewrite history.
     */
    async linkAcquisition(id, { leadId, referenceId }) {
      await db.query(
        `UPDATE customers
            SET lead_id = COALESCE(lead_id, $2),
                acquisition_reference_id = COALESCE(acquisition_reference_id, $3)
          WHERE customer_id = $1`,
        [id, leadId ?? null, referenceId ?? null],
      );
    },

    /**
     * Keyset page for partner pulls, oldest change first. The cursor is the
     * (updated_at, customer_id) of the last row, kept at microsecond precision.
     */
    async changedSince({ after, updatedSince, limit, withPii }) {
      const params = [];
      const where = [];
      if (after) {
        params.push(after.updatedAt, after.id);
        where.push(
          `(c.updated_at, c.customer_id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      if (updatedSince) {
        params.push(updatedSince);
        where.push(`c.updated_at > $${params.length}`);
      }
      params.push(limit);
      const { rows } = await db.query(
        `SELECT ${COLUMNS}${withPii ? `, ${PII_COLUMNS}` : ''},
                to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
         ${FROM}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY c.updated_at, c.customer_id
         LIMIT $${params.length}`,
        params,
      );
      return rows.map((row) => ({
        ...(withPii ? withEncrypted(row) : toCustomer(row)),
        cursorAt: row.cursor_at,
      }));
    },

    async findForPartner(id, { withPii }) {
      const { rows } = await db.query(
        `SELECT ${COLUMNS}${withPii ? `, ${PII_COLUMNS}` : ''} ${FROM} WHERE c.customer_id = $1`,
        [id],
      );
      if (!rows[0]) return null;
      return withPii ? withEncrypted(rows[0]) : toCustomer(rows[0]);
    },

    /** Unified history: interactions, appointments, appraisals and transactions. */
    async timeline(customerId, limit) {
      const { rows } = await db.query(
        `SELECT * FROM (
           SELECT 'INTERACTION' AS kind, i.interaction_id AS id, i.occurred_at AS at,
                  i.channel AS label, i.summary AS detail, b.branch_code
           FROM customer_interactions i
           LEFT JOIN branches b ON b.branch_id = i.branch_id
           WHERE i.customer_id = $1
           UNION ALL
           SELECT 'APPOINTMENT', a.appointment_id, a.scheduled_at,
                  a.status, a.service_type, b.branch_code
           FROM branch_appointments a
           JOIN branches b ON b.branch_id = a.branch_id
           WHERE a.customer_id = $1
           UNION ALL
           SELECT 'APPRAISAL', r.appraisal_id, r.created_at, r.status,
                  concat(r.item_description, ' · ', trim_scale(r.weight_gram), ' g · ',
                         trim_scale(r.purity_karat), 'K'),
                  b.branch_code
           FROM appraisal_records r
           JOIN branches b ON b.branch_id = r.branch_id
           WHERE r.customer_id = $1
           UNION ALL
           SELECT 'TRANSACTION', g.transaction_id, g.occurred_at, g.channel,
                  concat(CASE g.side WHEN 'BUY' THEN 'Buy' ELSE 'Sell' END, ' · ',
                         COALESCE(g.description || ' · ', ''), trim_scale(g.weight_gram), ' g · Rp ',
                         replace(to_char(g.amount, 'FM999,999,999,990'), ',', '.')),
                  b.branch_code
           FROM gold_transactions g
           LEFT JOIN branches b ON b.branch_id = g.branch_id
           WHERE g.customer_id = $1
         ) t
         ORDER BY at DESC
         LIMIT $2`,
        [customerId, limit],
      );
      return rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        at: row.at,
        label: row.label,
        detail: row.detail,
        branchCode: row.branch_code,
      }));
    },
  });
}
