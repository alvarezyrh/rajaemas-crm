import { escapeLike } from '../../shared/sql.js';

const toUser = (row) =>
  row && {
    id: row.user_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    branchId: row.branch_id,
    branchCode: row.branch_code,
    branchName: row.branch_name,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    passwordChangedAt: row.password_changed_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

/** Never hand the hash to anything that is not checking a password. */
export const withoutSecret = ({ passwordHash: _hash, ...user }) => user;

const SELECT = `
  SELECT u.user_id, u.email, u.full_name, u.role, u.branch_id, b.branch_code, b.name AS branch_name,
         u.password_hash, u.is_active, u.must_change_password, u.password_changed_at,
         u.last_login_at, u.created_at, u.updated_at
  FROM users u
  LEFT JOIN branches b ON b.branch_id = u.branch_id`;

export function createUserRepository(db) {
  return Object.freeze({
    async findByEmail(email) {
      const { rows } = await db.query(`${SELECT} WHERE u.email = lower($1)`, [email]);
      return toUser(rows[0]) ?? null;
    },

    async findById(id, { forUpdate = false } = {}) {
      const { rows } = await db.query(
        `${SELECT} WHERE u.user_id = $1 ${forUpdate ? 'FOR UPDATE OF u' : ''}`,
        [id],
      );
      return toUser(rows[0]) ?? null;
    },

    async list({ q, role, active }) {
      const params = [];
      const where = ['TRUE'];
      if (q) {
        params.push(`%${escapeLike(q)}%`);
        where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
      }
      if (role) {
        params.push(role);
        where.push(`u.role = $${params.length}`);
      }
      if (active !== undefined) {
        params.push(active);
        where.push(`u.is_active = $${params.length}`);
      }
      const { rows } = await db.query(
        `${SELECT} WHERE ${where.join(' AND ')} ORDER BY u.is_active DESC, u.full_name`,
        params,
      );
      return rows.map((row) => withoutSecret(toUser(row)));
    },

    async insert({ email, fullName, role, branchId, passwordHash }) {
      const { rows } = await db.query(
        `INSERT INTO users (email, full_name, role, branch_id, password_hash, must_change_password)
         VALUES (lower($1), $2, $3, $4, $5, true)
         RETURNING user_id`,
        [email, fullName, role, branchId, passwordHash],
      );
      return rows[0].user_id;
    },

    async update(id, { fullName, role, branchId, isActive }) {
      await db.query(
        'UPDATE users SET full_name = $2, role = $3, branch_id = $4, is_active = $5 WHERE user_id = $1',
        [id, fullName, role, branchId, isActive],
      );
    },

    async updateName(id, fullName) {
      await db.query('UPDATE users SET full_name = $2 WHERE user_id = $1', [id, fullName]);
    },

    async setPassword(id, passwordHash, { mustChange }) {
      await db.query(
        `UPDATE users SET password_hash = $2, must_change_password = $3, password_changed_at = now()
         WHERE user_id = $1`,
        [id, passwordHash, mustChange],
      );
    },

    async touchLogin(id) {
      await db.query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [id]);
    },

    /** Active head-office accounts other than `excludeId` (to keep at least one). */
    async countOtherActiveHq(excludeId) {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM users WHERE role = 'HQ_STAFF' AND is_active AND user_id <> $1",
        [excludeId],
      );
      return rows[0].n;
    },
  });
}
