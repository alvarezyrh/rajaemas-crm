/**
 * Uji integrasi lapisan HTTP (pipeline, envelope, keamanan, idempotensi)
 * with a real server and fake dependencies — no PostgreSQL needed.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/core/logger.js';
import { Router } from '../src/core/http/router.js';
import { idempotency } from '../src/middleware/idempotency.js';
import { createCache } from '../src/infra/cache.js';
import { createEventBus } from '../src/infra/eventBus.js';
import { createHealth } from '../src/modules/health/health.js';
import { hmacSha256Hex } from '../src/security/crypto.js';

const logger = createLogger({ level: 'error' });
const WEBHOOK_SECRET = 'test-secret';

/** Master-data stub: enough for route registration and permission checks. */
const stubEntity = {
  list: async () => [],
  get: async () => null,
  create: async () => ({}),
  update: async () => ({}),
};

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe('HTTP app', () => {
  let server;
  let base;
  let cache;
  const published = [];
  const commerce = [];

  before(async () => {
    cache = await createCache({ redisUrl: null, logger });
    const bus = createEventBus(logger);
    bus.subscribe('omnichannel.message.inbound', (e) => published.push(e));
    bus.subscribe('commerce.event', (e) => commerce.push(e));

    const container = {
      config: {
        isProduction: false,
        http: {
          bodyLimitBytes: 1024,
          trustProxy: false,
          publicDir: new URL('../public', import.meta.url).pathname,
          vendorDir: {
            fontawesome: new URL('../node_modules/@fortawesome/fontawesome-free', import.meta.url)
              .pathname,
            nunito: new URL('../node_modules/@fontsource-variable/nunito/files', import.meta.url)
              .pathname,
          },
        },
        rateLimit: { globalPerMinute: 1000, loginPerMinute: 5 },
        security: { webhookSecret: WEBHOOK_SECRET },
      },
      logger,
      cache,
      bus,
      uow: { repos: {} },
      services: {
        auth: {
          resolveSession: async (token) => ({
            id: 'u1',
            role: token === 'live' ? 'HQ_STAFF' : 'APPRAISER',
            branchId: 'b1',
            areaId: null,
            sessionId: 's1',
          }),
        },
        branches: {
          list: async () => [],
          get: async () => null,
          update: async () => null,
        },
        masterdata: {
          areas: stubEntity,
          references: stubEntity,
          productCategories: stubEntity,
          products: stubEntity,
          transactionTypes: stubEntity,
          csAssignments: {
            list: async () => [],
            create: async () => ({}),
            remove: async () => ({}),
          },
        },
        reports: {
          catalog: () => [{ name: 'lmrei', title: 'LM REI Dashboard', available: true }],
          definition: (name) => {
            if (name !== 'lmrei') throw new Error('unexpected report');
            return { permission: 'lmrei:read' };
          },
          run: async (_actor, name, query) => ({
            report: name,
            period: { from: query.from ?? null, to: query.to ?? null },
            totals: { settled: 1 },
          }),
        },
        liveOmset: {
          open: async () => ({
            snapshot: async () => ({
              generatedAt: '2026-11-28T04:08:00.000Z',
              totals: { transactionCount: 2, buyAmount: 1000, sellAmount: 250 },
              branches: [],
            }),
          }),
        },
        reviews: {
          outlet: async (_actor, id) => ({ branch: { id }, reviews: [] }),
        },
        metaGateway: {
          isWebhookConfigured: () => true,
          verifyWebhook: (mode, token) => mode === 'subscribe' && token === 'verify',
          verifySignature: (rawBody, signature) =>
            rawBody.toString() === '{"entry":[]}' && signature === 'sha256=valid',
        },
        blasts: {
          list: async () => [],
          preview: async () => ({ eligibleCustomers: 3 }),
          handleWebhook: async (body) => ({ entryCount: body.entry.length }),
        },
      },
      health: createHealth({ db: { ping: async () => {} }, cache }),
    };
    ({ server, base } = await startServer(createApp(container)));
  });

  after(async () => {
    server.close();
    await cache.close();
  });

  it('/healthz & /readyz', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual((await ready.json()).checks, {
      database: 'ok',
      cache: 'ok',
    });
  });

  it('memakai envelope standar + header keamanan + X-Request-ID', async () => {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.requestId, res.headers.get('x-request-id'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  });

  it('405 with an Allow header', async () => {
    const res = await fetch(`${base}/api/v1/webhooks/omnichannel`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  it('401 without a token; 403 when the role is not allowed', async () => {
    assert.equal((await fetch(`${base}/api/v1/customers`)).status, 401);
    const res = await fetch(`${base}/api/v1/customers`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer x',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(res.status, 403); // APPRAISER lacks customer:write
  });

  it('master data: an appraiser may read it but never write it', async () => {
    const auth = { authorization: 'Bearer x' };
    const read = await fetch(`${base}/api/v1/areas`, { headers: auth });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).data, []);

    for (const path of ['/api/v1/areas', '/api/v1/products', '/api/v1/cs-assignments']) {
      const write = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(write.status, 403, path); // APPRAISER lacks masterdata:manage / staffing:manage
    }
    const roles = await fetch(`${base}/api/v1/roles`, { headers: auth });
    assert.equal(roles.status, 403); // APPRAISER lacks role:read
  });

  it('an appraiser has no access to leads or advertising budgets', async () => {
    const auth = { authorization: 'Bearer x' };
    for (const path of ['/api/v1/leads', '/api/v1/advertising-budgets', '/api/v1/leads/summary']) {
      assert.equal((await fetch(`${base}${path}`, { headers: auth })).status, 403, path);
    }
  });

  it('serves the scoped generic reports endpoint with validated dates and meta', async () => {
    const auth = { authorization: 'Bearer x' };
    assert.equal((await fetch(`${base}/api/v1/reports`)).status, 401);

    const catalog = await fetch(`${base}/api/v1/reports`, { headers: auth });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).data[0].name, 'lmrei');

    const report = await fetch(`${base}/api/v1/reports/lmrei?from=2026-01-01`, {
      headers: auth,
    });
    const payload = await report.json();
    assert.equal(report.status, 200);
    assert.equal(payload.data.report, 'lmrei');
    assert.deepEqual(payload.meta, { report: 'lmrei' });

    const invalid = await fetch(`${base}/api/v1/reports/lmrei?from=not-a-date`, {
      headers: auth,
    });
    assert.equal(invalid.status, 422);
  });

  it('streams live omset only to permitted users and sends an initial snapshot', async () => {
    const path = `${base}/api/v1/live-omset/stream`;
    assert.equal((await fetch(path)).status, 401);
    assert.equal(
      (
        await fetch(path, {
          headers: { authorization: 'Bearer x' },
        })
      ).status,
      403,
    );

    const response = await fetch(path, {
      headers: { authorization: 'Bearer live', accept: 'text/event-stream' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const reader = response.body.getReader();
    let content = '';
    try {
      while (!content.includes('event: omset')) {
        const { done, value } = await reader.read();
        if (done) break;
        content += new TextDecoder().decode(value);
      }
      assert.match(content, /event: omset/);
      assert.match(content, /"transactionCount":2/);
    } finally {
      await reader.cancel();
    }
  });

  it('serves outlet reviews only to users with review permission', async () => {
    const path = `${base}/api/v1/reviews/outlets/00000000-0000-4000-8000-000000000001`;
    assert.equal((await fetch(path)).status, 401);
    assert.equal(
      (
        await fetch(path, {
          headers: { authorization: 'Bearer x' },
        })
      ).status,
      403,
    );
    const response = await fetch(path, {
      headers: { authorization: 'Bearer live' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.reviews.length, 0);
  });

  it('verifies Meta webhook challenge and rejects invalid signatures', async () => {
    const challenge = await fetch(
      `${base}/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=abc123`,
    );
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), 'abc123');

    const invalid = await fetch(`${base}/api/v1/webhooks/meta`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=bad',
      },
      body: '{"entry":[]}',
    });
    assert.equal(invalid.status, 401);

    const valid = await fetch(`${base}/api/v1/webhooks/meta`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=valid',
      },
      body: '{"entry":[]}',
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).data.entryCount, 0);
  });

  it('protects blast preview and returns only an audience count', async () => {
    const path = `${base}/api/v1/blasts`;
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path, { headers: { authorization: 'Bearer x' } })).status, 403);
    const list = await fetch(path, { headers: { authorization: 'Bearer live' } });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).data, []);

    const preview = await fetch(`${base}/api/v1/blasts/preview`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer live',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ criteria: { city: 'Jakarta' } }),
    });
    assert.equal(preview.status, 200);
    assert.deepEqual((await preview.json()).data, { eligibleCustomers: 3 });
  });

  it('rejects oversized payloads and the wrong content type', async () => {
    const big = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 'a'.repeat(2000) }),
    });
    assert.equal(big.status, 413);
    const wrongType = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      body: 'email=a',
    });
    assert.equal(wrongType.status, 415);
  });

  it('menyajikan dashboard statis & mencegah path traversal', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const traversal = await fetch(`${base}/assets/..%2f..%2fpackage.json`);
    assert.notEqual(traversal.status, 200);
  });

  it('webhook: rejects a bad signature, accepts a valid one, dedupes eventId', async () => {
    const body = JSON.stringify({
      eventId: 'evt-1',
      type: 'message.inbound',
      channel: 'WHATSAPP',
      from: '081234567890',
      text: 'Halo',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const send = (signature) =>
      fetch(`${base}/api/v1/webhooks/omnichannel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timestamp': ts,
          'x-signature': signature,
        },
        body,
      });

    assert.equal((await send('sha256=deadbeef')).status, 401);

    const signature = `sha256=${hmacSha256Hex(WEBHOOK_SECRET, `${ts}.`, body)}`;
    const first = await send(signature);
    assert.equal(first.status, 202);
    assert.equal((await first.json()).data.duplicate, false);
    assert.equal((await (await send(signature)).json()).data.duplicate, true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published.length, 1);
    assert.equal(published[0].from, '+6281234567890');
  });

  it('webhook commerce: validasi lintas-field, normalisasi, dan dedupe', async () => {
    const send = (payload) => {
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      return fetch(`${base}/api/v1/webhooks/commerce`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timestamp': ts,
          'x-signature': `sha256=${hmacSha256Hex(WEBHOOK_SECRET, `${ts}.`, body)}`,
        },
        body,
      });
    };
    const order = {
      eventId: 'com-1',
      type: 'order.completed',
      source: 'ECOMMERCE',
      accountId: 'web-1',
      phone: '0812 3456 7811',
      fullName: 'Pembeli Web',
      orderId: 'ORD-1',
      side: 'BUY',
      weightGram: 2,
      amount: 3_900_000,
    };

    const sell = await send({ ...order, eventId: 'com-x', side: 'SELL' });
    assert.equal(sell.status, 422);
    assert.deepEqual(
      (await sell.json()).error.details.map((d) => d.field),
      ['side'],
    );

    const missing = await send({
      ...order,
      eventId: 'com-y',
      orderId: undefined,
      amount: undefined,
    });
    assert.deepEqual((await missing.json()).error.details.map((d) => d.field).sort(), [
      'amount',
      'orderId',
    ]);

    const noPhone = await send({
      eventId: 'com-z',
      type: 'account.registered',
      source: 'MOBILE_APP',
      accountId: 'app-1',
    });
    assert.equal(noPhone.status, 422);

    const first = await send(order);
    assert.equal(first.status, 202);
    assert.equal((await first.json()).data.duplicate, false);
    assert.equal((await (await send(order)).json()).data.duplicate, true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commerce.length, 1);
    assert.equal(commerce[0].phone, '+6281234567811');
  });
});

describe('Idempotency middleware', () => {
  it('replays the response, rejects a different payload with the same key', async () => {
    const cache = await createCache({ redisUrl: null, logger });
    let executions = 0;
    const router = new Router().post('/pay', idempotency({ cache }), async (ctx) => {
      executions += 1;
      ctx.res.writeHead(201, { 'content-type': 'application/json' });
      ctx.response = {
        status: 201,
        payload: { success: true, n: executions },
      };
      ctx.res.end(JSON.stringify(ctx.response.payload));
    });

    const { createContext } = await import('../src/core/http/context.js');
    const { compose } = await import('../src/core/http/pipeline.js');
    const { jsonBody } = await import('../src/core/http/body.js');
    const { errorBoundary } = await import('../src/middleware/errorBoundary.js');
    const pipeline = compose([
      errorBoundary(),
      jsonBody({ limitBytes: 1024 }),
      async (ctx) => {
        const match = router.match(ctx.method, ctx.path);
        ctx.state.user = { id: 'u1' };
        await compose(match.handlers)(ctx);
      },
    ]);
    const { server, base } = await startServer((req, res) =>
      pipeline(createContext(req, res, { trustProxy: false, logger })),
    );

    const key = randomBytes(12).toString('hex');
    const post = (body, idemKey = key) =>
      fetch(`${base}/pay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idemKey,
        },
        body: JSON.stringify(body),
      });

    try {
      const first = await post({ amount: 1 });
      const replay = await post({ amount: 1 });
      assert.equal(first.status, 201);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.deepEqual(await replay.json(), await first.json());
      assert.equal(executions, 1);

      assert.equal((await post({ amount: 2 })).status, 422);
      assert.equal((await post({ amount: 1 }, 'pendek')).status, 400);
    } finally {
      server.close();
      await cache.close();
    }
  });
});
