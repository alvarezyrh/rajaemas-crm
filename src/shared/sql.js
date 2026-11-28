/** Escapes LIKE wildcards so user input is matched literally. */
export const escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

/** Default business time zone (WIB). */
export const BUSINESS_TZ = 'Asia/Jakarta';

/** Converts numeric/bigint columns (strings from the pg driver) to Number. */
export const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Builds an outlet-scope SQL fragment from a scope object (`shared/scope.js`):
 *
 *   { branchId }        → column = $n                       (outlet staff)
 *   { areaId }          → column IN (outlets of that area)   (area manager)
 *   { branchId, areaId }→ both, ANDed                        (narrowing inside an area)
 *   {}                  → TRUE                               (head office)
 *
 * Each scope value is pushed to `params` once, and the returned function can be
 * applied to as many columns as needed while reusing the same placeholders.
 * Only the column name is interpolated, and callers pass constant column names.
 */
export function outletScopeFilter(scope, params) {
  const clauses = [];
  if (scope?.branchId) {
    params.push(scope.branchId);
    const p = `$${params.length}`;
    clauses.push((column) => `${column} = ${p}`);
  }
  if (scope?.areaId) {
    params.push(scope.areaId);
    const p = `$${params.length}`;
    clauses.push((column) => `${column} IN (SELECT branch_id FROM branches WHERE area_id = ${p})`);
  }
  return (column) =>
    clauses.length === 0 ? 'TRUE' : `(${clauses.map((clause) => clause(column)).join(' AND ')})`;
}

/** Single-column shortcut for `outletScopeFilter`. */
export const outletScopeSql = (column, scope, params) => outletScopeFilter(scope, params)(column);
