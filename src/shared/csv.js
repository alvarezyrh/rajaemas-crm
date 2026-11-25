/**
 * CSV writing (RFC 4180) with spreadsheet formula-injection protection:
 * a cell that starts with = + - @ (or tab/CR) is prefixed with a quote so
 * Excel/Sheets show it as text instead of running it.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells) => `${cells.map(csvCell).join(',')}\r\n`;

/** UTF-8 byte-order mark so Excel opens the file with the right encoding. */
export const CSV_BOM = '\uFEFF';
