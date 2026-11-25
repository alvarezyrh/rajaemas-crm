const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function normalize(fields) {
  if (!fields) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, code: value.code, stack: value.stack }
        : value;
  }
  return out;
}

/** Dependency-free structured JSON logger: one JSON line per event. */
export function createLogger({ level = 'info', bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...bindings,
      ...normalize(fields),
    });
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };

  return Object.freeze({
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level, bindings: { ...bindings, ...extra } }),
  });
}
