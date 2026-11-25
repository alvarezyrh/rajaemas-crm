const TOKEN_KEY = 'rei.crm.token';

/** The token is kept per tab (sessionStorage) and is gone when the tab closes. */
export const session = {
  get token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable — the session lives in memory only */
    }
  },
};

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * REST client for /api/v1. `idempotent: true` adds a unique Idempotency-Key
 * for transactional endpoints.
 */
export async function api(path, { method = 'GET', body, query, idempotent = false } = {}) {
  const url = new URL(`/api/v1${path}`, location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const headers = { accept: 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotent) headers['idempotency-key'] = crypto.randomUUID();

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Unable to reach the server');
  }

  const payload = await response.json().catch(() => null);
  if (response.status === 401 && session.token && path !== '/auth/login') {
    session.token = null;
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (response.status === 403 && payload?.code === 'PASSWORD_CHANGE_REQUIRED') {
    window.dispatchEvent(new Event('auth:password-change'));
  }
  if (!response.ok || !payload?.success) {
    throw new ApiError(payload?.error?.message ?? `Request failed (HTTP ${response.status})`, {
      status: response.status,
      code: payload?.code,
      details: payload?.error?.details,
    });
  }
  return payload;
}

/**
 * Downloads a file endpoint (e.g. CSV export). The token travels in the
 * Authorization header, so the file is fetched first and then saved locally.
 */
export async function download(path, { query } = {}) {
  const url = new URL(`/api/v1${path}`, location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  let response;
  try {
    response = await fetch(url, {
      headers: session.token ? { authorization: `Bearer ${session.token}` } : {},
    });
  } catch {
    throw new ApiError('Unable to reach the server');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(payload?.error?.message ?? `Download failed (HTTP ${response.status})`, {
      status: response.status,
    });
  }
  const filename =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  saveBlob(await response.blob(), filename);
}

/** Saves a Blob as a file via a temporary object URL. */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
