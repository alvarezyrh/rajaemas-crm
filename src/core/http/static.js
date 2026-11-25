import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
});

/**
 * Static file server with path-traversal protection.
 * - `prefix`: only serves URLs starting with it (stripped before resolving).
 * - `spaFallback`: unknown paths without an extension are served index.html.
 */
export function createStaticHandler(rootDir, { prefix = '', spaFallback = true, maxAge = 0 } = {}) {
  const root = path.resolve(rootDir);

  async function resolveFile(urlPath) {
    const target = path.resolve(root, `.${path.posix.normalize(urlPath)}`);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    try {
      const info = await stat(target);
      return info.isFile() ? { file: target, size: info.size, mtimeMs: info.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  return async function serveStatic(ctx) {
    if (prefix && !ctx.path.startsWith(`${prefix}/`)) return false;
    const urlPath = prefix ? ctx.path.slice(prefix.length) : ctx.path;
    const requested = urlPath === '/' ? '/index.html' : urlPath;
    const found =
      (await resolveFile(requested)) ??
      (spaFallback && !path.extname(requested) && !urlPath.startsWith('/vendor/')
        ? await resolveFile('/index.html')
        : null);
    if (!found) return false;

    const ext = path.extname(found.file);
    // No build step (file names are not hashed) → maxAge 0: the browser always
    // revalidates via ETag, so changes show up immediately and unchanged files
    // are answered with a cheap 304.
    const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
    const cacheControl = ext === '.html' || maxAge === 0 ? 'no-cache' : `public, max-age=${maxAge}`;
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, { etag, 'cache-control': cacheControl });
      ctx.res.end();
      return true;
    }
    ctx.res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': found.size,
      'cache-control': cacheControl,
      etag,
    });
    if (ctx.method === 'HEAD') ctx.res.end();
    else await pipeline(createReadStream(found.file), ctx.res);
    return true;
  };
}
