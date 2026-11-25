import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createPartnerService,
  decodeCursor,
  encodeCursor,
  generateApiKey,
} from '../src/modules/partner/partner.service.js';
import {
  normalizeBirthDate,
  normalizeGender,
  normalizeKyc,
  normalizeNik,
  normalizePostalCode,
} from '../src/shared/kyc.js';

describe('Identity (KTP) normalisation', () => {
  it('accepts NIK with separators and checks the province code', () => {
    assert.equal(normalizeNik('3171-0101-9001-0001'), '3171010190010001');
    assert.equal(normalizeNik('3171 0101 9001 0001'), '3171010190010001');
    assert.equal(normalizeNik('0071010190010001'), undefined); // province 00
    assert.equal(normalizeNik('317101019001000'), undefined); // 15 digits
    assert.equal(normalizeNik('31710101900100AB'), undefined);
  });

  it('reads gender in English and Indonesian', () => {
    for (const v of ['M', 'male', 'L', 'Laki-laki', 'pria'])
      assert.equal(normalizeGender(v), 'M', v);
    for (const v of ['F', 'Female', 'P', 'Perempuan', 'wanita'])
      assert.equal(normalizeGender(v), 'F', v);
    assert.equal(normalizeGender('X'), undefined);
  });

  it('reads birth dates in ISO and KTP order, rejecting impossible ones', () => {
    const today = new Date('2026-11-26T00:00:00Z');
    assert.equal(normalizeBirthDate('1990-08-17', today), '1990-08-17');
    assert.equal(normalizeBirthDate('17-08-1990', today), '1990-08-17');
    assert.equal(normalizeBirthDate('7/8/1990', today), '1990-08-07');
    assert.equal(normalizeBirthDate('1990-08-17T00:00:00Z', today), '1990-08-17');
    assert.equal(normalizeBirthDate('31-02-1990', today), undefined);
    assert.equal(normalizeBirthDate('2030-01-01', today), undefined);
    assert.equal(normalizeBirthDate('1890-01-01', today), undefined);
  });

  it('keeps good fields and reports bad ones', () => {
    assert.equal(normalizePostalCode(' 10110 '), '10110');
    assert.equal(normalizePostalCode('1011'), undefined);
    const { values, rejected } = normalizeKyc({
      nik: 'bad',
      city: '  Bandung ',
      postalCode: '40111',
      gender: '',
    });
    assert.deepEqual(values, { city: 'Bandung', postalCode: '40111' });
    assert.deepEqual(rejected, ['nik']);
  });
});

describe('Partner API credentials', () => {
  it('generates unique keys and stores only a hash', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.match(a.key, /^rei_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.key, b.key);
    assert.equal(a.hash.length, 64);
    assert.ok(!a.hash.includes(a.key.split('_')[2]));
  });

  it('authenticates only the exact, active key', async () => {
    const { key, prefix, hash } = generateApiKey();
    const touched = [];
    const client = {
      id: 'k1',
      name: 'STORE',
      keyPrefix: prefix,
      keyHash: hash,
      scopes: ['customers:read'],
    };
    const uow = {
      repos: {
        apiClients: {
          findActiveByPrefix: async (p) => (p === prefix ? client : null),
          touchUsed: async (id) => touched.push(id),
        },
      },
    };
    const partner = createPartnerService({ uow, pii: {}, blindIndex: () => '' });
    const ok = await partner.authenticate(key);
    assert.equal(ok.id, 'k1');
    assert.equal(ok.keyHash, undefined, 'the hash never leaves the service');
    assert.deepEqual(touched, ['k1']);
    const tampered = `${key.slice(0, -1)}${key.endsWith('x') ? 'y' : 'x'}`;
    await assert.rejects(partner.authenticate(tampered), /Invalid or revoked/);
    await assert.rejects(partner.authenticate('not-a-key'), /Invalid or revoked/);
  });

  it('round-trips cursors and rejects tampered ones', () => {
    const row = {
      cursorAt: '2026-11-26T03:04:05.123456Z',
      id: '9a15ada1-0804-4ba0-9229-984f24eaacd0',
    };
    assert.deepEqual(decodeCursor(encodeCursor(row)), { updatedAt: row.cursorAt, id: row.id });
    assert.equal(decodeCursor('garbage'), null);
    assert.equal(decodeCursor(Buffer.from('{"u":"x","i":"1"}').toString('base64url')), null);
  });
});
