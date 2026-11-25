import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// i18n.js runs in the browser; give it the few globals it touches.
let t;
let setLang;
before(async () => {
  const store = new Map([['rei.crm.lang', 'id']]);
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  globalThis.document = { documentElement: {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.CustomEvent = class {};
  ({ t, setLang } = await import('../public/assets/js/i18n.js'));
});

describe('English ⇄ Indonesian', () => {
  it('translates fixed UI text and server messages', () => {
    assert.equal(t('Customers'), 'Nasabah');
    assert.equal(t('Sign out'), 'Keluar');
    assert.equal(t('Incorrect email or password'), 'Email atau kata sandi salah');
    assert.equal(t('  Sign in '), '  Masuk ', 'surrounding spaces are kept');
  });

  it('translates dynamic text through patterns', () => {
    assert.equal(t('Page 2 of 13 · 246 customers'), 'Halaman 2 dari 13 · 246 nasabah');
    assert.equal(t('In-store + Mobile app'), 'Toko + Aplikasi');
    assert.equal(t('Mobile app only'), 'Hanya Aplikasi');
    assert.equal(t('fullName: must be at least 2 characters'), 'fullName: minimal 2 karakter');
    assert.equal(t('Customer not found'), 'Nasabah tidak ditemukan');
    assert.equal(
      t('26 Nov 2026, 09.00 · Appraisal · JKT01'),
      '26 Nov 2026, 09.00 · Taksiran · JKT01',
    );
    assert.equal(t('Bandung, 21 Jan 1981 (age 45)'), 'Bandung, 21 Jan 1981 (usia 45)');
  });

  it('leaves data (names, numbers, codes) untouched', () => {
    for (const data of [
      'Ayu Saputra',
      'JKT01',
      '+62 ••• •••• 0216',
      'Rp 7.400.000',
      'Jl. Merdeka No. 1',
    ]) {
      assert.equal(t(data), data);
    }
  });

  it('English mode is a pass-through', () => {
    setLang('en');
    assert.equal(t('Customers'), 'Customers');
    setLang('id');
  });
});
