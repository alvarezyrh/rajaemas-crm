/**
 * Outbound HTTP for partner APIs, hardened against SSRF and slow/huge responses:
 *  - https only (http allowed only when private hosts are allowed, i.e. development)
 *  - the hostname must not resolve to a private, loopback, or link-local address
 *  - redirects are refused (they could point somewhere internal)
 *  - hard timeout and a response-size cap
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export class FetchError extends Error {}

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast & reserved
  );
}

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateV4(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80')
  );
}

/** Throws FetchError when the URL is not allowed. */
export async function assertSafeUrl(rawUrl, { allowPrivateHosts }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError('Invalid URL');
  }
  if (url.username || url.password)
    throw new FetchError('Put credentials in the auth header, not the URL');
  if (url.protocol !== 'https:' && !(allowPrivateHosts && url.protocol === 'http:')) {
    throw new FetchError('The endpoint must use https');
  }
  if (allowPrivateHosts) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new FetchError(`Cannot resolve host "${url.hostname}"`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new FetchError('The endpoint points to a private or internal network address');
  }
  return url;
}

/** GET a JSON document from a partner API. */
export async function fetchJson(rawUrl, { headers = {}, allowPrivateHosts = false } = {}) {
  const url = await assertSafeUrl(rawUrl, { allowPrivateHosts });

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'RajaEmas-CRM/1.0', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FetchError(
      err.name === 'TimeoutError'
        ? 'The partner API did not respond in time'
        : 'Could not connect to the partner API',
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new FetchError('The partner API answered with a redirect, which is not allowed');
  if (!response.ok) throw new FetchError(`The partner API answered HTTP ${response.status}`);

  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new FetchError('The response is larger than 10 MB');

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new FetchError('The response is larger than 10 MB');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new FetchError('The partner API did not return valid JSON');
  }
}
