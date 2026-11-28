import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQmsRepository } from '../src/modules/qms/qms.repository.js';

test('QMS ticket list reports whether a service rating already exists', async () => {
  let statement;
  const repository = createQmsRepository({
    async query(sql) {
      statement = sql;
      return {
        rows: [
          {
            ticket_id: 'ticket-1',
            ticket_no: 'A-001',
            branch_id: 'branch-1',
            branch_code: 'JKT01',
            branch_name: 'Jakarta',
            timezone: 'Asia/Jakarta',
            customer_id: null,
            customer_name: null,
            cs_id: 'staff-1',
            cs_name: 'CS',
            taken_at: new Date('2026-11-28T01:00:00Z'),
            served_at: new Date('2026-11-28T01:05:00Z'),
            closed_at: new Date('2026-11-28T01:10:00Z'),
            status: 'DONE',
            is_rated: true,
            wait_seconds: 300,
          },
        ],
      };
    },
  });

  const [ticket] = await repository.listTickets({ scope: {}, todayOnly: false });

  assert.equal(ticket.isRated, true);
  assert.match(
    statement,
    /EXISTS \(SELECT 1 FROM cs_ratings r WHERE r\.qms_ticket_id = q\.ticket_id\)/,
  );
});
