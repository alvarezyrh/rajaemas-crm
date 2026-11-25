const toBranch = (row) => ({
  id: row.branch_id,
  code: row.branch_code,
  name: row.name,
  region: row.region,
});

export function createBranchRepository(db) {
  return Object.freeze({
    async listActive() {
      const { rows } = await db.query(
        `SELECT branch_id, branch_code, name, region
         FROM branches WHERE is_active ORDER BY branch_code`,
      );
      return rows.map(toBranch);
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
