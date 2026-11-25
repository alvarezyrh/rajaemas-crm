import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compose } from '../src/core/http/pipeline.js';
import { Router } from '../src/core/http/router.js';

const noop = () => {};

describe('Router', () => {
  it('mencocokkan rute statis dan parameter', () => {
    const router = new Router()
      .get('/api/v1/customers', noop)
      .get('/api/v1/customers/:id/timeline', noop);
    assert.ok(router.match('GET', '/api/v1/customers').handlers);
    assert.deepEqual(router.match('GET', '/api/v1/customers/abc/timeline').params, { id: 'abc' });
  });

  it('prefers static segments over parameters, with backtracking', () => {
    const fixed = () => 'fixed';
    const router = new Router()
      .get('/items/special', fixed)
      .get('/items/:id', noop)
      .get('/items/:id/detail', noop);
    assert.equal(router.match('GET', '/items/special').handlers[0], fixed);
    assert.deepEqual(router.match('GET', '/items/special/detail').params, { id: 'special' });
  });

  it('membedakan 404 (null) dan 405 (handlers undefined)', () => {
    const router = new Router().post('/x', noop);
    assert.equal(router.match('GET', '/y'), null);
    const match = router.match('GET', '/x');
    assert.equal(match.handlers, undefined);
    assert.deepEqual(match.allowed, ['POST']);
  });

  it('HEAD falls back to the GET handler', () => {
    const router = new Router().get('/x', noop);
    assert.ok(router.match('HEAD', '/x').handlers);
  });

  it('decodes parameters and rejects broken encoding', () => {
    const router = new Router().get('/a/:name', noop);
    assert.equal(router.match('GET', '/a/Siti%20R').params.name, 'Siti R');
    assert.equal(router.match('GET', '/a/%E0%A4%A'), null);
  });

  it('rejects duplicate routes and conflicting parameter names at registration', () => {
    const router = new Router().get('/a/:id', noop);
    assert.throws(() => router.get('/a/:id', noop), /Duplicate route/);
    assert.throws(() => router.get('/a/:slug/x', noop), /Conflicting parameters/);
  });
});

describe('compose', () => {
  it('menjalankan middleware berurutan (onion model)', async () => {
    const order = [];
    const run = compose([
      async (_ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      },
      async (_ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      },
    ]);
    await run({});
    assert.deepEqual(order, [1, 2, 3, 4]);
  });

  it('rejects next() called twice', async () => {
    const run = compose([
      async (_ctx, next) => {
        await next();
        await next();
      },
    ]);
    await assert.rejects(run({}), /more than once/);
  });
});
