import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv, toCustomerRows } from '../public/assets/js/csv.js';
import { phoneForSpreadsheet } from '../src/modules/customers/customer.transfer.js';
import {
  assertSafeUrl,
  FetchError,
  isPrivateAddress,
} from '../src/modules/integrations/fetcher.js';
import {
  extractList,
  getPath,
  mapRecord,
  ShapeError,
} from '../src/modules/integrations/mapping.js';
import { can, Permissions as P } from '../src/security/rbac.js';
import { csvCell } from '../src/shared/csv.js';
import { normalizeIndonesianPhone } from '../src/shared/phone.js';

const FIELDS = {
  fullName: 'name',
  phone: 'contact.phone',
  email: 'contact.email',
  accountId: 'id',
};

describe('Partner API mapping', () => {
  it('reads dot paths without walking into prototypes', () => {
    assert.equal(getPath({ a: { b: 1 } }, 'a.b'), 1);
    assert.equal(getPath({ a: {} }, 'a.b.c'), undefined);
    assert.equal(getPath({}, 'constructor'), undefined);
    assert.equal(getPath({}, '__proto__.polluted'), undefined);
  });

  it('extracts the list or explains what is wrong', () => {
    assert.deepEqual(extractList({ data: { items: [1] } }, 'data.items'), [1]);
    assert.deepEqual(extractList([1, 2], ''), [1, 2]);
    assert.throws(() => extractList({ data: {} }, 'data.items'), ShapeError);
  });

  it('maps a record, normalising phone and email', () => {
    const result = mapRecord(
      { id: 7, name: ' Ayu ', contact: { phone: '0812-3456-7890', email: 'AYU@X.COM' } },
      FIELDS,
    );
    assert.deepEqual(result, {
      ok: true,
      value: {
        fullName: 'Ayu',
        phone: '+6281234567890',
        email: 'ayu@x.com',
        accountId: '7',
        kyc: {},
      },
      rejected: [],
    });
  });

  it('maps identity (KTP) fields and drops only the invalid ones', () => {
    const fields = {
      ...FIELDS,
      nik: 'ktp.nik',
      birthDate: 'ktp.dob',
      gender: 'ktp.sex',
      city: 'ktp.city',
      postalCode: 'ktp.zip',
    };
    const record = {
      id: 1,
      name: 'Ayu Lestari',
      contact: { phone: '081234567890' },
      ktp: {
        nik: '3171 0101 9001 0001',
        dob: '17-08-1990',
        sex: 'P',
        city: ' Jakarta  Pusat ',
        zip: 1234,
      },
    };
    const { value, rejected } = mapRecord(record, fields);
    assert.deepEqual(value.kyc, {
      nik: '3171010190010001',
      birthDate: '1990-08-17',
      gender: 'F',
      city: 'Jakarta Pusat',
    });
    assert.deepEqual(rejected, ['postalCode']);
  });

  it('skips records it cannot use, with a reason', () => {
    assert.match(
      mapRecord({ name: 'A B', contact: { phone: '123' } }, FIELDS).reason,
      /invalid phone/,
    );
    assert.match(
      mapRecord({ name: 'A B', contact: {} }, FIELDS).reason,
      /no phone number or account id/,
    );
    assert.equal(mapRecord('text', FIELDS).ok, false);
    // an account id alone is enough to match a customer already linked to that app
    assert.equal(mapRecord({ id: 'x1', contact: {} }, FIELDS).ok, true);
    // a bad email does not reject the record
    assert.equal(
      mapRecord({ name: 'A B', contact: { phone: '081234567890', email: 'nope' } }, FIELDS).value
        .email,
      null,
    );
  });
});

describe('Partner API SSRF guard', () => {
  it('classifies private, loopback and link-local addresses', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.5.4',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      assert.equal(isPrivateAddress(ip), false, ip);
  });

  it('refuses unsafe URLs when private hosts are not allowed', async () => {
    for (const url of [
      'http://example.com/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://10.1.2.3/',
      'https://user:pw@example.com/',
      'ftp://example.com/',
      'not a url',
    ]) {
      await assert.rejects(assertSafeUrl(url, { allowPrivateHosts: false }), FetchError, url);
    }
    await assert.doesNotReject(assertSafeUrl('https://8.8.8.8/api', { allowPrivateHosts: false }));
    await assert.doesNotReject(
      assertSafeUrl('http://127.0.0.1:4010/api', { allowPrivateHosts: true }),
    );
  });

  it('only head office manages integrations', () => {
    assert.equal(can('HQ_STAFF', P.INTEGRATION_MANAGE), true);
    for (const role of ['BRANCH_HEAD', 'APPRAISER', 'CUSTOMER_SERVICE'])
      assert.equal(can(role, P.INTEGRATION_MANAGE), false, role);
  });
});

describe('Customer CSV', () => {
  it('neutralises spreadsheet formulas and quotes special characters', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+1+1'), "'+1+1");
    assert.equal(csvCell('@cmd'), "'@cmd");
    assert.equal(csvCell('Sari, Dewi'), '"Sari, Dewi"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell('0812-3456-7801'), '0812-3456-7801');
  });

  it('exports phones in a spreadsheet-safe format that re-imports unchanged', () => {
    for (const e164 of ['+6281234567801', '+628123456789', '+62812345678901']) {
      const cell = phoneForSpreadsheet(e164);
      assert.match(cell, /^08\d{2}-\d{4}-\d+$/);
      assert.equal(normalizeIndonesianPhone(cell), e164);
    }
  });

  it('parses quoted fields, CRLF, BOM and semicolon files', () => {
    assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, ""y""",2\r\n\r\n'), [
      ['a', 'b'],
      ['x, "y"', '2'],
    ]);
    assert.deepEqual(parseCsv('a;b\n1;2'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
    assert.deepEqual(parseCsv('a,b\n"multi\nline",2'), [
      ['a', 'b'],
      ['multi\nline', '2'],
    ]);
  });

  it('maps common header spellings and reports missing required columns', () => {
    const { rows, mapped, ignored, missing } = toCustomerRows(
      parseCsv('Nama;No HP;Cabang;Notes\nAyu;0812;JKT01;x\n'),
    );
    assert.deepEqual(missing, []);
    assert.deepEqual(Object.keys(mapped), ['fullName', 'phone', 'homeBranchCode']);
    assert.deepEqual(ignored, ['Notes']);
    assert.deepEqual(rows, [{ row: 2, fullName: 'Ayu', phone: '0812', homeBranchCode: 'JKT01' }]);
    assert.deepEqual(toCustomerRows(parseCsv('email\nx@y.z')).missing, ['fullName', 'phone']);
  });

  it("strips the formula guard from the CRM's own exports on re-import", () => {
    const { rows } = toCustomerRows(parseCsv("full_name,phone\n'=Ayu,0812-3456-7801\n"));
    assert.equal(rows[0].fullName, '=Ayu');
  });
});
