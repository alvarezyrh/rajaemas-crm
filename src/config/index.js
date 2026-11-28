import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BONUS_RULES } from '../shared/bonus.js';
import { DEFAULT_LOYAL_RULES } from '../shared/loyalty.js';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function decimal(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function key32(env, name) {
  const key = Buffer.from(required(env, name), 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64). Run: npm run keys`);
  return key;
}

function workers(raw) {
  if (raw === 'auto') return availableParallelism();
  const n = Number.parseInt(raw ?? '1', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

/** Reads and validates configuration once at startup (fail fast). */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';

  return deepFreeze({
    env: nodeEnv,
    isProduction: nodeEnv === 'production',
    http: {
      host: env.HOST ?? '0.0.0.0',
      port: integer(env, 'PORT', 3000),
      bodyLimitBytes: integer(env, 'BODY_LIMIT_BYTES', 256 * 1024),
      requestTimeoutMs: integer(env, 'REQUEST_TIMEOUT_MS', 30_000),
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 65_000,
      shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 15_000),
      trustProxy: env.TRUST_PROXY === 'true',
      publicDir: path.join(ROOT_DIR, 'public'),
      vendorDir: {
        fontawesome: path.join(ROOT_DIR, 'node_modules', '@fortawesome', 'fontawesome-free'),
        fontDisplay: path.join(
          ROOT_DIR,
          'node_modules',
          '@fontsource',
          'cormorant-garamond',
          'files',
        ),
        fontText: path.join(ROOT_DIR, 'node_modules', '@fontsource-variable', 'manrope', 'files'),
      },
    },
    db: {
      url: required(env, 'DATABASE_URL'),
      poolMax: integer(env, 'DB_POOL_MAX', 10),
      statementTimeoutMs: integer(env, 'DB_STATEMENT_TIMEOUT_MS', 10_000),
    },
    redisUrl: env.REDIS_URL || null,
    security: {
      piiKey: key32(env, 'PII_ENCRYPTION_KEY'),
      blindIndexKey: key32(env, 'BLIND_INDEX_KEY'),
      tokenSecret: key32(env, 'TOKEN_SECRET'),
      tokenTtlSec: integer(env, 'TOKEN_TTL_SEC', 8 * 60 * 60),
      webhookSecret: required(env, 'WEBHOOK_SECRET'),
    },
    rateLimit: {
      globalPerMinute: integer(env, 'RATE_LIMIT_PER_MINUTE', 300),
      loginPerMinute: integer(env, 'LOGIN_RATE_LIMIT_PER_MINUTE', 10),
    },
    appointments: {
      slotMinutes: 30,
      slotCapacity: integer(env, 'APPOINTMENT_SLOT_CAPACITY', 3),
    },
    // PROVISIONAL business numbers — see shared/bonus.js and shared/loyalty.js.
    bonus: {
      buyPercent: decimal(env, 'BONUS_BUY_PERCENT', DEFAULT_BONUS_RULES.buyPercent),
      sellPercent: decimal(env, 'BONUS_SELL_PERCENT', DEFAULT_BONUS_RULES.sellPercent),
      capIdr: integer(env, 'BONUS_CAP_IDR', DEFAULT_BONUS_RULES.capIdr),
      roundTo: integer(env, 'BONUS_ROUND_TO', DEFAULT_BONUS_RULES.roundTo),
    },
    loyalty: {
      minTransactions: integer(env, 'LOYAL_MIN_TRANSACTIONS', DEFAULT_LOYAL_RULES.minTransactions),
      minAmount: integer(env, 'LOYAL_MIN_AMOUNT', DEFAULT_LOYAL_RULES.minAmount),
      windowDays: integer(env, 'LOYAL_WINDOW_DAYS', DEFAULT_LOYAL_RULES.windowDays),
      tiers: (env.LOYAL_TIERS ?? DEFAULT_LOYAL_RULES.tiers.join(','))
        .split(',')
        .map((tier) => tier.trim())
        .filter(Boolean),
    },
    integrations: {
      // Partner APIs on private/internal addresses (and plain http) are refused in
      // production unless explicitly allowed; development allows localhost mocks.
      allowPrivateHosts:
        env.INTEGRATION_ALLOW_PRIVATE_HOSTS === undefined ||
        env.INTEGRATION_ALLOW_PRIVATE_HOSTS === ''
          ? nodeEnv !== 'production'
          : env.INTEGRATION_ALLOW_PRIVATE_HOSTS === 'true',
    },
    cluster: { workers: workers(env.CLUSTER_WORKERS) },
    log: { level: env.LOG_LEVEL ?? 'info' },
  });
}
