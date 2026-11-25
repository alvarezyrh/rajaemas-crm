import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pointsForAmount, tierForPoints } from '../src/shared/loyalty.js';
import { normalizeIndonesianPhone } from '../src/shared/phone.js';
import { escapeLike } from '../src/shared/sql.js';

describe('normalizeIndonesianPhone', () => {
  it('normalises common formats to E.164', () => {
    for (const input of [
      '081234567890',
      '6281234567890',
      '+62 812-3456-7890',
      '81234567890',
      '(0812) 3456 7890',
    ]) {
      assert.equal(normalizeIndonesianPhone(input), '+6281234567890', input);
    }
  });

  it('rejects numbers that are not Indonesian mobiles', () => {
    for (const input of ['12345', '+1 555 0100', '0212345678', 'abc', '08123']) {
      assert.equal(normalizeIndonesianPhone(input), undefined, input);
    }
  });
});

describe('Loyalitas', () => {
  it('1 point per Rp100,000, rounded down', () => {
    assert.equal(pointsForAmount(14_550_000), 145);
    assert.equal(pointsForAmount(99_999), 0);
  });

  it('menentukan tier berdasarkan ambang poin', () => {
    assert.equal(tierForPoints(0), 'REGULER');
    assert.equal(tierForPoints(250), 'SILVER');
    assert.equal(tierForPoints(1_000), 'GOLD');
    assert.equal(tierForPoints(9_999), 'PLATINUM');
  });
});

describe('escapeLike', () => {
  it('meng-escape wildcard LIKE', () => {
    assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  });
});
