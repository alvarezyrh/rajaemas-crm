import { toNumber } from '../../shared/sql.js';

const COLUMNS = `
  l.lead_id, l.full_name, l.phone_encrypted, l.phone_last4, l.email, l.status, l.notes,
  l.reference_id, r.code AS reference_code, r.name AS reference_name, r.channel_type,
  l.area_id, ar.area_code, ar.name AS area_name,
  l.branch_id, b.branch_code, b.name AS branch_name,
  l.owner_id, o.full_name AS owner_name,
  l.lost_reason, l.converted_customer_id, l.converted_at, l.created_at, l.updated_at`;
const FROM = `
  FROM leads l
  LEFT JOIN acquisition_references r ON r.reference_id = l.reference_id
  LEFT JOIN areas ar ON ar.area_id = l.area_id
  LEFT JOIN branches b ON b.branch_id = l.branch_id
  LEFT JOIN users o ON o.user_id = l.owner_id`;

/**
 * Leads belong to an outlet and/or an area, so the scope filter covers both:
 * outlet staff see leads of their outlet, area managers everything tagged with
 * their area or with one of its outlets. Values are bound; only column names
 * (constants) are interpolated.
 */
function leadScope(scope, params) {
  if (scope?.branchId) {
    params.push(scope.branchId);
    return `(l.branch_id = $${params.length})`;
  }
  if (scope?.areaId) {
    params.push(scope.areaId);
    const p = `$${params.length}`;
    return `(l.area_id = ${p} OR l.branch_id IN (SELECT branch_id FROM branches WHERE area_id = ${p}))`;
  }
  return 'TRUE';
}

/**
 * The ciphertext is handed to the service, which decides whether the caller may
 * see the plain number (same rule as the CSV export). It never leaves the API.
 */
const toLead = (row) => ({
  id: row.lead_id,
  fullName: row.full_name,
  phoneEncrypted: row.phone_encrypted,
  phoneLast4: row.phone_last4,
  email: row.email,
  status: row.status,
  notes: row.notes,
  referenceId: row.reference_id,
  referenceCode: row.reference_code,
  referenceName: row.reference_name,
  channelType: row.channel_type,
  areaId: row.area_id,
  areaCode: row.area_code,
  areaName: row.area_name,
  branchId: row.branch_id,
  branchCode: row.branch_code,
  branchName: row.branch_name,
  ownerId: row.owner_id,
  ownerName: row.owner_name,
  lostReason: row.lost_reason,
  convertedCustomerId: row.converted_customer_id,
  convertedAt: row.converted_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createLeadRepository(db) {
  return Object.freeze({
    async search({ scope, status, referenceId, name, phoneHash, limit, offset }) {
      const params = [];
      const where = [leadScope(scope, params)];
      if (status) {
        params.push(status);
        where.push(`l.status = $${params.length}`);
      }
      if (referenceId) {
        params.push(referenceId);
        where.push(`l.reference_id = $${params.length}`);
      }
      if (phoneHash) {
        params.push(phoneHash);
        where.push(`l.phone_hash = $${params.length}`);
      }
      if (name) {
        params.push(`%${name}%`);
        where.push(`l.full_name ILIKE $${params.length}`);
      }
      params.push(limit, offset);
      const limitParam = `$${params.length - 1}`;
      const offsetParam = `$${params.length}`;

      const { rows } = await db.query(
        `SELECT ${COLUMNS}, count(*) OVER () AS total_count ${FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY l.created_at DESC, l.lead_id
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );
      return { items: rows.map(toLead), total: rows.length ? Number(rows[0].total_count) : 0 };
    },

    async findById(id, scope) {
      const params = [id];
      const scopeSql = leadScope(scope, params);
      const { rows } = await db.query(
        `SELECT ${COLUMNS} ${FROM} WHERE l.lead_id = $1 AND ${scopeSql}`,
        params,
      );
      return rows[0] ? toLead(rows[0]) : null;
    },

    /** Row for the conversion flow: encrypted phone, no masking decisions. */
    async findRawById(id, { forUpdate = false } = {}) {
      const { rows } = await db.query(
        `SELECT lead_id, full_name, phone_hash, phone_encrypted, phone_last4, email,
                reference_id, area_id, branch_id, status, converted_customer_id
         FROM leads WHERE lead_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
        [id],
      );
      return rows[0] ?? null;
    },

    /** Any lead on this number that is still in the funnel (duplicate guard). */
    async findActiveIdByPhoneHash(phoneHash) {
      const { rows } = await db.query(
        `SELECT lead_id FROM leads
          WHERE phone_hash = $1 AND status NOT IN ('CONVERTED', 'LOST', 'EXPIRED')`,
        [phoneHash],
      );
      return rows[0]?.lead_id ?? null;
    },

    async insert(record) {
      const { rows } = await db.query(
        `INSERT INTO leads
           (full_name, phone_hash, phone_encrypted, phone_last4, email, reference_id,
            area_id, branch_id, status, notes, owner_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING lead_id`,
        [
          record.fullName,
          record.phoneHash,
          record.phoneEncrypted,
          record.phoneLast4,
          record.email ?? null,
          record.referenceId ?? null,
          record.areaId ?? null,
          record.branchId ?? null,
          record.status ?? 'NEW',
          record.notes ?? null,
          record.ownerId ?? null,
          record.createdBy ?? null,
        ],
      );
      return rows[0].lead_id;
    },

    /** Status machine transitions; only the columns present in `fields` change. */
    async update(id, fields) {
      const columns = {
        status: 'status',
        notes: 'notes',
        ownerId: 'owner_id',
        referenceId: 'reference_id',
        branchId: 'branch_id',
        areaId: 'area_id',
        email: 'email',
        fullName: 'full_name',
        lostReason: 'lost_reason',
      };
      const keys = Object.keys(fields).filter(
        (key) => fields[key] !== undefined && Object.hasOwn(columns, key),
      );
      if (keys.length === 0) return false;
      const params = [id];
      const set = keys.map((key) => {
        params.push(fields[key]);
        return `${columns[key]} = $${params.length}`;
      });
      const { rowCount } = await db.query(
        `UPDATE leads SET ${set.join(', ')} WHERE lead_id = $1`,
        params,
      );
      return rowCount === 1;
    },

    async markConverted(id, customerId, at) {
      const { rowCount } = await db.query(
        `UPDATE leads
            SET status = 'CONVERTED', converted_customer_id = $2, converted_at = $3,
                lost_reason = NULL
          WHERE lead_id = $1`,
        [id, customerId, at],
      );
      return rowCount === 1;
    },

    /** Lead Summary: totals per status, per channel and per area. */
    async summary({ scope, from, to }) {
      const params = [];
      const where = [leadScope(scope, params)];
      if (from) {
        params.push(from);
        where.push(`l.created_at >= $${params.length}::date`);
      }
      if (to) {
        params.push(to);
        where.push(`l.created_at < ($${params.length}::date + 1)`);
      }
      const filter = where.join(' AND ');

      const { rows: totals } = await db.query(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE l.status = 'NEW')       AS new,
                count(*) FILTER (WHERE l.status = 'CONTACTED') AS contacted,
                count(*) FILTER (WHERE l.status = 'QUALIFIED') AS qualified,
                count(*) FILTER (WHERE l.status = 'CONVERTED') AS converted,
                count(*) FILTER (WHERE l.status = 'LOST')      AS lost,
                count(*) FILTER (WHERE l.status = 'EXPIRED')   AS expired,
                avg(EXTRACT(EPOCH FROM (l.converted_at - l.created_at)) / 86400)
                  FILTER (WHERE l.status = 'CONVERTED')        AS avg_days_to_convert
         ${FROM} WHERE ${filter}`,
        params,
      );

      const { rows: byReference } = await db.query(
        `SELECT COALESCE(r.code, 'UNKNOWN') AS code, COALESCE(r.name, 'Tanpa kanal') AS name,
                count(*) AS leads,
                count(*) FILTER (WHERE l.status = 'CONVERTED') AS converted
         ${FROM} WHERE ${filter}
         GROUP BY 1, 2 ORDER BY leads DESC`,
        params,
      );

      const { rows: byArea } = await db.query(
        `SELECT COALESCE(ar.area_code, 'UNKNOWN') AS code, COALESCE(ar.name, 'Tanpa area') AS name,
                count(*) AS leads,
                count(*) FILTER (WHERE l.status = 'CONVERTED') AS converted
         ${FROM} WHERE ${filter}
         GROUP BY 1, 2 ORDER BY leads DESC`,
        params,
      );

      const t = totals[0];
      return {
        total: toNumber(t.total),
        byStatus: {
          NEW: toNumber(t.new),
          CONTACTED: toNumber(t.contacted),
          QUALIFIED: toNumber(t.qualified),
          CONVERTED: toNumber(t.converted),
          LOST: toNumber(t.lost),
          EXPIRED: toNumber(t.expired),
        },
        avgDaysToConvert: t.avg_days_to_convert === null ? null : Number(t.avg_days_to_convert),
        byReference: byReference.map((r) => ({
          code: r.code,
          name: r.name,
          leads: toNumber(r.leads),
          converted: toNumber(r.converted),
        })),
        byArea: byArea.map((r) => ({
          code: r.code,
          name: r.name,
          leads: toNumber(r.leads),
          converted: toNumber(r.converted),
        })),
      };
    },

    /**
     * Leads grouped by (area, channel) — the join key used by the advertising
     * summary to put spend next to the leads it produced.
     */
    async countsByAreaReference({ scope, from, to }) {
      const params = [];
      const where = [leadScope(scope, params)];
      if (from) {
        params.push(from);
        where.push(`l.created_at >= $${params.length}::date`);
      }
      if (to) {
        params.push(to);
        where.push(`l.created_at < ($${params.length}::date + 1)`);
      }
      const { rows } = await db.query(
        `SELECT l.area_id, l.reference_id,
                count(*) AS leads,
                count(*) FILTER (WHERE l.status = 'CONVERTED') AS converted
         ${FROM} WHERE ${where.join(' AND ')}
         GROUP BY 1, 2`,
        params,
      );
      return rows.map((r) => ({
        areaId: r.area_id,
        referenceId: r.reference_id,
        leads: toNumber(r.leads),
        converted: toNumber(r.converted),
      }));
    },
  });
}
