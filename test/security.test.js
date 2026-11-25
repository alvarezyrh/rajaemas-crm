import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyWebhookSignature } from '../src/modules/webhooks/signature.js';
import {
  createBlindIndexer,
  createPiiCipher,
  hashPassword,
  hmacSha256Hex,
  verifyPassword,
} from '../src/security/crypto.js';
import { can, Permissions, Roles } from '../src/security/rbac.js';
import { createTokenService } from '../src/security/token.js';
import { resolveBranchId } from '../src/shared/scope.js';

describe('Enkripsi PII (AES-256-GCM)', () => {
  const cipher = createPiiCipher(randomBytes(32));

  it('round-trip dan IV acak per enkripsi', () => {
    const a = cipher.encrypt('3174012345678901', 'customers.nik');
    const b = cipher.encrypt('3174012345678901', 'customers.nik');
    assert.notEqual(a, b);
    assert.equal(cipher.decrypt(a, 'customers.nik'), '3174012345678901');
  });

  it('fails when the context (AAD) differs or the ciphertext is altered', () => {
    const token = cipher.encrypt('+628123', 'customers.phone');
    assert.throws(() => cipher.decrypt(token, 'customers.nik'));
    const parts = token.split('.');
    parts[4] = Buffer.from('xxxxxxx').toString('base64url');
    assert.throws(() => cipher.decrypt(parts.join('.'), 'customers.phone'));
  });

  it('blind index deterministik dan terpisah per domain', () => {
    const index = createBlindIndexer(randomBytes(32));
    assert.equal(index('phone', '+62812'), index('phone', '+62812'));
    assert.notEqual(index('phone', '+62812'), index('nik', '+62812'));
  });
});

describe('Password (scrypt)', () => {
  it('verifies only the correct password', async () => {
    const stored = await hashPassword('rahasia-kuat-123');
    assert.equal(await verifyPassword('rahasia-kuat-123', stored), true);
    assert.equal(await verifyPassword('salah-total-123', stored), false);
    assert.equal(await verifyPassword('apa saja', 'bukan-format'), false);
  });
});

describe('Token akses', () => {
  const secret = randomBytes(32);

  it('menerbitkan dan memverifikasi klaim', () => {
    const tokens = createTokenService({ secret, ttlSec: 60 });
    const claims = tokens.verify(tokens.issue({ sub: 'u1', role: 'HQ_STAFF' }));
    assert.equal(claims.sub, 'u1');
  });

  it('rejects expired, wrongly signed or tampered tokens', () => {
    let now = Date.now();
    const tokens = createTokenService({ secret, ttlSec: 60, clock: () => now });
    const token = tokens.issue({ sub: 'u1', role: 'APPRAISER' });

    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u1', role: 'HQ_STAFF', iss: 'rajaemas-crm', exp: 9e9 }),
    ).toString('base64url');
    assert.equal(tokens.verify(`${header}.${forged}.${signature}`), null);
    assert.equal(createTokenService({ secret: randomBytes(32), ttlSec: 60 }).verify(token), null);

    now += 61_000;
    assert.equal(tokens.verify(token), null);
  });
});

describe('RBAC & branch scope', () => {
  it('appraisers can neither reveal PII nor approve buybacks', () => {
    assert.equal(can(Roles.APPRAISER, Permissions.CUSTOMER_PII_REVEAL), false);
    assert.equal(can(Roles.APPRAISER, Permissions.APPRAISAL_APPROVE), false);
    assert.equal(can(Roles.BRANCH_HEAD, Permissions.APPRAISAL_APPROVE), true);
    assert.equal(can('ROLE_TIDAK_ADA', Permissions.CUSTOMER_READ), false);
  });

  it('branch staff are locked to their own branch', () => {
    const branchStaff = { branchId: 'b1' };
    assert.equal(resolveBranchId(branchStaff, undefined), 'b1');
    assert.throws(() => resolveBranchId(branchStaff, 'b2'), /outside your branch scope/);
    assert.equal(resolveBranchId({ branchId: null }, 'b2'), 'b2');
    assert.throws(() => resolveBranchId({ branchId: null }, undefined), /validation failed/);
  });
});

describe('Tanda tangan webhook', () => {
  const secret = 'webhook-secret';
  const rawBody = Buffer.from('{"eventId":"e1"}');
  const now = 1_750_000_000_000;
  const ts = String(now / 1000);
  const sign = (body) => `sha256=${hmacSha256Hex(secret, `${ts}.`, body)}`;

  it('accepts a valid signature', () => {
    assert.equal(
      verifyWebhookSignature({ secret, rawBody, signature: sign(rawBody), timestamp: ts, now }),
      true,
    );
  });

  it('rejects an altered body, an empty signature, or an expired timestamp (replay)', () => {
    const signature = sign(rawBody);
    assert.equal(
      verifyWebhookSignature({ secret, rawBody: Buffer.from('{}'), signature, timestamp: ts, now }),
      false,
    );
    assert.equal(
      verifyWebhookSignature({ secret, rawBody, signature: undefined, timestamp: ts, now }),
      false,
    );
    assert.equal(
      verifyWebhookSignature({ secret, rawBody, signature, timestamp: ts, now: now + 600_000 }),
      false,
    );
  });
});
