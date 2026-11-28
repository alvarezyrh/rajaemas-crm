import { escapeLike, toNumber } from '../../shared/sql.js';

/**
 * Master Data repositories: areas, acquisition references, product categories,
 * products, transaction types and CS assignments.
 *
 * Every entity is soft-deactivated (`is_active = false`) rather than deleted, so
 * historical rows keep their references. `cs_assignments` is the exception: an
 * assignment is a period of time, and ending it is a real delete.
 */

/** `SET col = $n` from a whitelist; keys not in `columns` are ignored. */
function setClause(columns, fields, params) {
  const keys = Object.keys(fields).filter(
    (key) => fields[key] !== undefined && Object.hasOwn(columns, key),
  );
  const set = keys.map((key) => {
    params.push(fields[key]);
    return `${columns[key]} = $${params.length}`;
  });
  return { keys, set };
}

/** Builds list/insert/update for a simple `code + name + is_active` table. */
function simpleEntity(db, { table, pk, columns, map, order = 'code' }) {
  const code = columns.code;
  const select = `SELECT ${pk}, ${Object.values(columns).join(', ')}, created_at, updated_at
                  FROM ${table}`;
  return Object.freeze({
    async list({ includeInactive = false, q = null } = {}) {
      const params = [];
      const where = [];
      if (!includeInactive) where.push('is_active');
      if (q) {
        params.push(`%${escapeLike(q.toLowerCase())}%`);
        where.push(`(lower(name) LIKE $${params.length} OR lower(${code}) LIKE $${params.length})`);
      }
      const { rows } = await db.query(
        `${select} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
        params,
      );
      return rows.map(map);
    },

    async findById(id) {
      const { rows } = await db.query(`${select} WHERE ${pk} = $1`, [id]);
      return rows[0] ? map(rows[0]) : null;
    },

    async findByCode(value) {
      const { rows } = await db.query(`${select} WHERE ${code} = $1`, [value]);
      return rows[0] ? map(rows[0]) : null;
    },

    async insert(fields) {
      const params = [];
      const keys = Object.keys(columns).filter((key) => fields[key] !== undefined);
      const values = keys.map((key) => {
        params.push(fields[key]);
        return `$${params.length}`;
      });
      const { rows } = await db.query(
        `INSERT INTO ${table} (${keys.map((k) => columns[k]).join(', ')})
         VALUES (${values.join(', ')}) RETURNING ${pk}`,
        params,
      );
      return rows[0][pk];
    },

    async update(id, fields) {
      const params = [id];
      const { set } = setClause(columns, fields, params);
      if (set.length === 0) return false;
      const { rowCount } = await db.query(
        `UPDATE ${table} SET ${set.join(', ')} WHERE ${pk} = $1`,
        params,
      );
      return rowCount === 1;
    },
  });
}

const AREA_COLUMNS = {
  code: 'area_code',
  name: 'name',
  province: 'province',
  city: 'city',
  regionCode: 'region_code',
  isActive: 'is_active',
};

export function createAreaRepository(db) {
  return simpleEntity(db, {
    table: 'areas',
    pk: 'area_id',
    columns: AREA_COLUMNS,
    order: 'area_code',
    map: (row) => ({
      id: row.area_id,
      code: row.area_code,
      name: row.name,
      province: row.province,
      city: row.city,
      regionCode: row.region_code,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  });
}

const REFERENCE_COLUMNS = {
  code: 'code',
  name: 'name',
  channelType: 'channel_type',
  isActive: 'is_active',
};

export function createReferenceRepository(db) {
  return simpleEntity(db, {
    table: 'acquisition_references',
    pk: 'reference_id',
    columns: REFERENCE_COLUMNS,
    map: (row) => ({
      id: row.reference_id,
      code: row.code,
      name: row.name,
      channelType: row.channel_type,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  });
}

const CATEGORY_COLUMNS = { code: 'code', name: 'name', isActive: 'is_active' };

export function createProductCategoryRepository(db) {
  return simpleEntity(db, {
    table: 'product_categories',
    pk: 'category_id',
    columns: CATEGORY_COLUMNS,
    map: (row) => ({
      id: row.category_id,
      code: row.code,
      name: row.name,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  });
}

export function createTransactionTypeRepository(db) {
  return simpleEntity(db, {
    table: 'transaction_types',
    pk: 'type_id',
    columns: {
      code: 'code',
      name: 'name',
      side: 'side',
      isBullion: 'is_bullion',
      requiresAppraisal: 'requires_appraisal',
      isActive: 'is_active',
    },
    map: (row) => ({
      id: row.type_id,
      code: row.code,
      name: row.name,
      side: row.side,
      isBullion: row.is_bullion,
      requiresAppraisal: row.requires_appraisal,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  });
}

const PRODUCT_COLUMNS = `
  p.product_id, p.sku, p.name, p.category_id, c.code AS category_code, c.name AS category_name,
  p.karat, p.base_weight_gram, p.is_bullion, p.is_active, p.created_at, p.updated_at`;
const PRODUCT_FROM = `FROM products p LEFT JOIN product_categories c ON c.category_id = p.category_id`;

const toProduct = (row) => ({
  id: row.product_id,
  sku: row.sku,
  name: row.name,
  categoryId: row.category_id,
  categoryCode: row.category_code,
  categoryName: row.category_name,
  karat: toNumber(row.karat),
  baseWeightGram: toNumber(row.base_weight_gram),
  isBullion: row.is_bullion,
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Products carry a category join and extra numeric columns, so they are written out. */
export function createProductRepository(db) {
  const columns = {
    sku: 'sku',
    name: 'name',
    categoryId: 'category_id',
    karat: 'karat',
    baseWeightGram: 'base_weight_gram',
    isBullion: 'is_bullion',
    isActive: 'is_active',
  };

  return Object.freeze({
    async list({ includeInactive = false, q = null, categoryId = null, bullion } = {}) {
      const params = [];
      const where = [];
      if (!includeInactive) where.push('p.is_active');
      if (categoryId) {
        params.push(categoryId);
        where.push(`p.category_id = $${params.length}`);
      }
      if (bullion !== undefined) {
        params.push(bullion);
        where.push(`p.is_bullion = $${params.length}`);
      }
      if (q) {
        params.push(`%${escapeLike(q.toLowerCase())}%`);
        where.push(`(lower(p.name) LIKE $${params.length} OR lower(p.sku) LIKE $${params.length})`);
      }
      const { rows } = await db.query(
        `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY p.sku`,
        params,
      );
      return rows.map(toProduct);
    },

    async findById(id) {
      const { rows } = await db.query(
        `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.product_id = $1`,
        [id],
      );
      return rows[0] ? toProduct(rows[0]) : null;
    },

    async insert(fields) {
      const params = [];
      const keys = Object.keys(columns).filter((key) => fields[key] !== undefined);
      const values = keys.map((key) => {
        params.push(fields[key]);
        return `$${params.length}`;
      });
      params.push(fields.createdBy ?? null);
      const { rows } = await db.query(
        `INSERT INTO products (${keys.map((k) => columns[k]).join(', ')}, created_by)
         VALUES (${values.join(', ')}, $${params.length})
         RETURNING product_id`,
        params,
      );
      return rows[0].product_id;
    },

    async update(id, fields) {
      const params = [id];
      const { set } = setClause(columns, fields, params);
      if (set.length === 0) return false;
      const { rowCount } = await db.query(
        `UPDATE products SET ${set.join(', ')} WHERE product_id = $1`,
        params,
      );
      return rowCount === 1;
    },
  });
}

const CS_COLUMNS = `
  ca.assignment_id, ca.user_id, u.full_name, u.email, ca.branch_id, b.branch_code, b.name AS branch_name,
  ca.is_primary, ca.valid_from::text AS valid_from, ca.valid_to::text AS valid_to, ca.created_at`;
const CS_FROM = `
  FROM cs_assignments ca
  JOIN users u ON u.user_id = ca.user_id
  JOIN branches b ON b.branch_id = ca.branch_id`;

export function createCsAssignmentRepository(db) {
  return Object.freeze({
    async list({ branchId = null, userId = null, activeOn = null } = {}) {
      const params = [];
      const where = [];
      if (branchId) {
        params.push(branchId);
        where.push(`ca.branch_id = $${params.length}`);
      }
      if (userId) {
        params.push(userId);
        where.push(`ca.user_id = $${params.length}`);
      }
      if (activeOn) {
        params.push(activeOn);
        where.push(
          `ca.valid_from <= $${params.length}::date AND (ca.valid_to IS NULL OR ca.valid_to >= $${params.length}::date)`,
        );
      }
      const { rows } = await db.query(
        `SELECT ${CS_COLUMNS} ${CS_FROM}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY b.branch_code, ca.valid_from DESC`,
        params,
      );
      return rows.map((row) => ({
        id: row.assignment_id,
        userId: row.user_id,
        userName: row.full_name,
        userEmail: row.email,
        branchId: row.branch_id,
        branchCode: row.branch_code,
        branchName: row.branch_name,
        isPrimary: row.is_primary,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        createdAt: row.created_at,
      }));
    },

    async insert({ userId, branchId, isPrimary, validFrom, validTo }) {
      const { rows } = await db.query(
        `INSERT INTO cs_assignments (user_id, branch_id, is_primary, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5) RETURNING assignment_id`,
        [userId, branchId, isPrimary ?? false, validFrom, validTo ?? null],
      );
      return rows[0].assignment_id;
    },

    /** Ends an assignment; returns false when the row is already gone. */
    async remove(id) {
      const { rowCount } = await db.query('DELETE FROM cs_assignments WHERE assignment_id = $1', [
        id,
      ]);
      return rowCount === 1;
    },

    /** A second "primary" CS at the same outlet would make ownership ambiguous. */
    async countPrimary(branchId, excludeId = null) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM cs_assignments
          WHERE branch_id = $1 AND is_primary AND valid_to IS NULL
            AND ($2::uuid IS NULL OR assignment_id <> $2)`,
        [branchId, excludeId],
      );
      return rows[0].n;
    },
  });
}
