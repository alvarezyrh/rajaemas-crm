const toBranch = (row) => ({
  id: row.branch_id,
  code: row.branch_code,
  name: row.name,
  region: row.region,
  areaId: row.area_id ?? null,
  areaCode: row.area_code ?? null,
  areaName: row.area_name ?? null,
  googlePlaceId: row.google_place_id ?? null,
  address: row.address ?? null,
  city: row.city ?? null,
  province: row.province ?? null,
  timezone: row.timezone,
  isActive: row.is_active,
});

const COLUMNS = `
  b.branch_id, b.branch_code, b.name, b.region, b.area_id, a.area_code, a.name AS area_name,
  b.google_place_id, b.address, b.city, b.province, b.timezone, b.is_active`;
const FROM = `FROM branches b LEFT JOIN areas a ON a.area_id = b.area_id`;

export function createBranchRepository(db) {
  return Object.freeze({
    async listActive() {
      const { rows } = await db.query(
        `SELECT ${COLUMNS} ${FROM} WHERE b.is_active ORDER BY b.branch_code`,
      );
      return rows.map(toBranch);
    },

    /** Outlet directory narrowed by scope: one outlet, one area, or all. */
    async list({ includeInactive = false, areaId = null, branchId = null } = {}) {
      const params = [];
      const where = [];
      if (!includeInactive) where.push('b.is_active');
      if (branchId) {
        params.push(branchId);
        where.push(`b.branch_id = $${params.length}`);
      }
      if (areaId) {
        params.push(areaId);
        where.push(`b.area_id = $${params.length}`);
      }
      const { rows } = await db.query(
        `SELECT ${COLUMNS} ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY b.branch_code`,
        params,
      );
      return rows.map(toBranch);
    },

    async findById(id) {
      const { rows } = await db.query(`SELECT ${COLUMNS} ${FROM} WHERE b.branch_id = $1`, [id]);
      return rows[0] ? toBranch(rows[0]) : null;
    },

    /** Area membership check used to keep area managers inside their area. */
    async isInArea(branchId, areaId) {
      const { rowCount } = await db.query(
        'SELECT 1 FROM branches WHERE branch_id = $1 AND area_id = $2',
        [branchId, areaId],
      );
      return rowCount === 1;
    },

    async update(id, fields) {
      const columns = {
        name: 'name',
        region: 'region',
        areaId: 'area_id',
        googlePlaceId: 'google_place_id',
        address: 'address',
        city: 'city',
        province: 'province',
        timezone: 'timezone',
        isActive: 'is_active',
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
        `UPDATE branches SET ${set.join(', ')} WHERE branch_id = $1`,
        params,
      );
      return rowCount === 1;
    },

    /** Locks an active branch row for the transaction (serialises slot booking). */
    async lockActive(branchId) {
      const { rowCount } = await db.query(
        'SELECT 1 FROM branches WHERE branch_id = $1 AND is_active FOR UPDATE',
        [branchId],
      );
      return rowCount === 1;
    },
  });
}
