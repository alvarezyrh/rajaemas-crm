import { Errors } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Pembangun skema deklaratif. Contoh:
 *   v.object({ name: v.string({ required: true, max: 120 }) })
 * Objects are strict: unknown fields are rejected unless `allowUnknown` is set.
 */
export const v = Object.freeze({
  string: (opts = {}) => ({ ...opts, type: 'string' }),
  integer: (opts = {}) => ({ ...opts, type: 'integer' }),
  number: (opts = {}) => ({ ...opts, type: 'number' }),
  boolean: (opts = {}) => ({ ...opts, type: 'boolean' }),
  oneOf: (values, opts = {}) => ({ ...opts, type: 'enum', values }),
  uuid: (opts = {}) => ({ ...opts, type: 'uuid' }),
  datetime: (opts = {}) => ({ ...opts, type: 'datetime' }),
  date: (opts = {}) => ({ ...opts, type: 'date' }),
  object: (shape, opts = {}) => ({ ...opts, type: 'object', shape }),
});

const isEmpty = (value) => value === undefined || value === null || value === '';

function inRange(rule, n, fail) {
  if (rule.min !== undefined && n < rule.min) return fail(`must be at least ${rule.min}`);
  if (rule.max !== undefined && n > rule.max) return fail(`must be at most ${rule.max}`);
  return n;
}

const checkers = {
  string(rule, value, fail) {
    if (typeof value !== 'string') return fail('must be text');
    const s = value.replace(CONTROL_CHARS, '').normalize('NFC').trim();
    if (rule.min !== undefined && s.length < rule.min)
      return fail(`must be at least ${rule.min} characters`);
    if (rule.max !== undefined && s.length > rule.max)
      return fail(`must be at most ${rule.max} characters`);
    if (rule.pattern && !rule.pattern.test(s)) return fail(rule.message ?? 'invalid format');
    if (!rule.transform) return s;
    const out = rule.transform(s);
    return out === undefined ? fail(rule.message ?? 'invalid format') : out;
  },
  integer(rule, value, fail) {
    const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(n) ? inRange(rule, n, fail) : fail('must be a whole number');
  },
  number(rule, value, fail) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n)
      ? inRange(rule, n, fail)
      : fail('must be a number');
  },
  boolean(rule, value, fail) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    return fail('must be true or false');
  },
  enum(rule, value, fail) {
    return rule.values.includes(value) ? value : fail(`must be one of: ${rule.values.join(', ')}`);
  },
  uuid(rule, value, fail) {
    return typeof value === 'string' && UUID.test(value)
      ? value.toLowerCase()
      : fail('must be a UUID');
  },
  datetime(rule, value, fail) {
    if (typeof value !== 'string' || !ISO_DATETIME.test(value)) {
      return fail('must be an ISO 8601 date-time with a time zone');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fail('invalid date');
    if (rule.future && date.getTime() <= Date.now()) return fail('must be in the future');
    return date;
  },
  date(rule, value, fail) {
    if (typeof value !== 'string' || !ISO_DATE.test(value))
      return fail('must use the YYYY-MM-DD format');
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
      ? value
      : fail('invalid date');
  },
  object(rule, value, fail, path, errors) {
    if (typeof value !== 'object' || Array.isArray(value)) return fail('must be an object');
    const out = {};
    for (const [key, child] of Object.entries(rule.shape)) {
      const result = run(child, value[key], path ? `${path}.${key}` : key, errors);
      if (result !== undefined) out[key] = result;
    }
    if (!rule.allowUnknown) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(rule.shape, key)) {
          errors.push({ field: path ? `${path}.${key}` : key, message: 'unknown field' });
        }
      }
    }
    return out;
  },
};

function run(rule, value, path, errors) {
  if (isEmpty(value)) {
    if (rule.required) errors.push({ field: path, message: 'is required' });
    return rule.default;
  }
  const fail = (message) => {
    errors.push({ field: path || '(root)', message });
    return undefined;
  };
  return checkers[rule.type](rule, value, fail, path, errors);
}

/** Validates and sanitises input; throws a 422 listing every failing field. */
export function validate(schema, input) {
  const errors = [];
  const value = run(schema, input ?? {}, '', errors);
  if (errors.length > 0) throw Errors.validation(errors);
  return value;
}
