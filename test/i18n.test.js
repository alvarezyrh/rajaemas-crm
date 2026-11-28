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

  it('translates every API Gateway target and field label', () => {
    const labels = [
      'Customer profiles',
      'Product catalog',
      'Leads',
      'Appointments',
      'Transactions',
      'Custom JSON dataset (including stock/QMS snapshots)',
      'Customer field mapping',
      'Field for customer name',
      'Field for phone number',
      'Field for email (optional)',
      'Field for account ID (optional)',
      'Identity (KTP) fields — optional',
      'Field for NIK',
      'Field for place of birth',
      'Field for date of birth',
      'Field for gender',
      'Field for street address',
      'Field for city / regency',
      'Field for province',
      'Field for postal code',
      'Field for occupation',
      'Product catalog mapping (does not import stock quantities)',
      'Field for SKU',
      'Field for product name',
      'Field for category code (optional)',
      'Field for karat (optional)',
      'Field for base weight in grams (optional)',
      'Field for bullion flag (optional)',
      'Lead field mapping',
      'Field for lead name',
      'Field for acquisition channel code (optional)',
      'Field for outlet code (optional)',
      'Field for area code (optional)',
      'Field for notes (optional)',
      'Appointment field mapping (customer must already exist in CRM)',
      'Field for stable external record ID',
      'Field for customer account ID (optional)',
      'Field for customer phone (optional)',
      'Field for outlet code',
      'Field for service type',
      'Field for scheduled date/time',
      'Transaction field mapping (customer must already exist in CRM)',
      'Field for transaction type code',
      'Field for invoice number (optional)',
      'Field for description (optional)',
      'Field for transaction date/time (optional)',
      'Path to transaction item list',
      'Field path for item description',
      'Field path for item weight in grams',
      'Field path for item unit price',
      'Field path for karat (optional)',
      'Field path for product SKU (optional)',
      'Custom dataset mapping (encrypted JSON records)',
      'Dataset name',
      'Source name',
      'Endpoint URL (GET, returns JSON)',
      'Auth header (optional)',
      'Auth token',
      'Where the record list is in the response (empty = the response itself)',
      'Paging & status',
      'Pagination',
      'None — one request returns everything',
      'Pages — adds ?page=1&pageSize=N',
      'Page size',
      'Active (can be synced)',
      'Imported cluster / account ID channel (required when mapped)',
      'Channel for customer account ID (required when mapped)',
    ];

    for (const label of labels)
      assert.notEqual(t(label), label, `Missing Indonesian translation: ${label}`);
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
