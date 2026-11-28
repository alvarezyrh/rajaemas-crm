import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLeadRepository } from '../src/modules/leads/lead.repository.js';
import {
  createAreaRepository,
  createProductRepository,
} from '../src/modules/masterdata/masterdata.repository.js';

function queryCapture() {
  const calls = [];
  return {
    calls,
    db: {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [] };
      },
    },
  };
}

describe('repository search queries', () => {
  it('treats LIKE metacharacters literally in lead names', async () => {
    const { calls, db } = queryCapture();
    const repository = createLeadRepository(db);

    await repository.search({ name: 'A%_\\', limit: 10, offset: 0 });

    assert.deepEqual(calls[0].params, ['%A\\%\\_\\\\%', 10, 0]);
  });

  it('treats LIKE metacharacters literally in master data and product searches', async () => {
    const { calls, db } = queryCapture();

    await createAreaRepository(db).list({ q: 'A%_\\' });
    await createProductRepository(db).list({ q: 'A%_\\' });

    assert.deepEqual(calls[0].params, ['%a\\%\\_\\\\%']);
    assert.deepEqual(calls[1].params, ['%a\\%\\_\\\\%']);
  });
});
