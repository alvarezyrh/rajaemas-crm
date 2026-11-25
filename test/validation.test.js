import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/core/errors.js';
import { v, validate } from '../src/core/validation.js';
import { createCustomerSchema } from '../src/modules/customers/customer.schema.js';

const failures = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 422);
    return err.details;
  }
  assert.fail('expected a validation failure');
};

describe('validate', () => {
  it('menyanitasi teks dan menerapkan default', () => {
    const schema = v.object({
      name: v.string({ required: true }),
      page: v.integer({ default: 1 }),
    });
    assert.deepEqual(validate(schema, { name: '  Siti\u0000 ' }), { name: 'Siti', page: 1 });
  });

  it('rejects unknown fields (strict schema)', () => {
    const details = failures(() =>
      validate(v.object({ a: v.string() }), { a: 'x', role: 'HQ_STAFF' }),
    );
    assert.deepEqual(details, [{ field: 'role', message: 'unknown field' }]);
  });

  it('converts numbers from the query string', () => {
    const schema = v.object({ page: v.integer({ min: 1 }), price: v.number() });
    assert.deepEqual(validate(schema, { page: '3', price: '1500.5' }), { page: 3, price: 1500.5 });
  });

  it('collects every error at once', () => {
    const schema = v.object({ a: v.string({ required: true }), b: v.uuid({ required: true }) });
    assert.equal(failures(() => validate(schema, { b: 'bukan-uuid' })).length, 2);
  });

  it('memvalidasi tanggal kalender', () => {
    const schema = v.object({ d: v.date() });
    assert.equal(validate(schema, { d: '2026-02-28' }).d, '2026-02-28');
    failures(() => validate(schema, { d: '2026-02-30' }));
  });

  it('the customer schema normalises phone and email', () => {
    const value = validate(createCustomerSchema, {
      fullName: 'Budi',
      phone: '0812-3456-7890',
      email: 'Budi@Mail.COM',
    });
    assert.equal(value.phone, '+6281234567890');
    assert.equal(value.email, 'budi@mail.com');
    assert.equal(value.preferredChannel, 'WHATSAPP');
    failures(() => validate(createCustomerSchema, { fullName: 'Budi', phone: '12345' }));
  });
});
