import { outletScopeSql, toNumber } from '../../shared/sql.js';

const TICKET = `
  q.ticket_id, q.ticket_no, q.branch_id, b.branch_code, b.name AS branch_name, b.timezone,
  q.customer_id, c.full_name AS customer_name, q.cs_id, u.full_name AS cs_name,
  q.taken_at, q.served_at, q.closed_at, q.status,
  EXISTS (SELECT 1 FROM cs_ratings r WHERE r.qms_ticket_id = q.ticket_id) AS is_rated,
  EXTRACT(EPOCH FROM (q.served_at - q.taken_at))::int AS wait_seconds`;
const TICKET_FROM = `
  FROM qms_tickets q
  LEFT JOIN branches b ON b.branch_id = q.branch_id
  LEFT JOIN customers c ON c.customer_id = q.customer_id
  LEFT JOIN users u ON u.user_id = q.cs_id`;

const toTicket = (row) => ({
  id: row.ticket_id,
  ticketNo: row.ticket_no,
  branchId: row.branch_id,
  branchCode: row.branch_code,
  branchName: row.branch_name,
  timezone: row.timezone,
  customerId: row.customer_id,
  customerName: row.customer_name,
  csId: row.cs_id,
  csName: row.cs_name,
  takenAt: row.taken_at,
  servedAt: row.served_at,
  closedAt: row.closed_at,
  status: row.status,
  isRated: row.is_rated,
  waitSeconds: row.wait_seconds,
});

/** Day boundaries follow the outlet's own time zone (WIB/WITA/WIT). */
function sameLocalDay(column) {
  return `(${column} AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date`;
}

function periodClause(where, params, { from, to }, column) {
  if (from) {
    params.push(from);
    where.push(`(${column} AT TIME ZONE b.timezone)::date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`(${column} AT TIME ZONE b.timezone)::date <= $${params.length}::date`);
  }
}

export function createQmsRepository(db) {
  return Object.freeze({
    /** Queue number for today at that outlet, e.g. `A-013`. */
    async nextTicketNo(branchId) {
      const { rows } = await db.query(
        `SELECT (SELECT count(*)::int FROM qms_tickets q2
                  WHERE q2.branch_id = b.branch_id AND ${sameLocalDay('q2.taken_at')}) AS used
         FROM branches b WHERE b.branch_id = $1`,
        [branchId],
      );
      return rows[0] ? `A-${String(rows[0].used + 1).padStart(3, '0')}` : null;
    },

    async insertTicket({ branchId, customerId, csId, ticketNo }) {
      const { rows } = await db.query(
        `INSERT INTO qms_tickets (ticket_no, branch_id, customer_id, cs_id, status)
         VALUES ($1, $2, $3, $4, 'WAITING') RETURNING ticket_id`,
        [ticketNo, branchId, customerId ?? null, csId ?? null],
      );
      return rows[0].ticket_id;
    },

    async findTicketById(id, scope) {
      const params = [id];
      const where = outletScopeSql('q.branch_id', scope, params);
      const { rows } = await db.query(
        `SELECT ${TICKET} ${TICKET_FROM} WHERE q.ticket_id = $1 AND ${where}`,
        params,
      );
      return rows[0] ? toTicket(rows[0]) : null;
    },

    async lockTicket(id) {
      const { rows } = await db.query(
        `SELECT ${TICKET} ${TICKET_FROM} WHERE q.ticket_id = $1 FOR UPDATE OF q`,
        [id],
      );
      return rows[0] ? toTicket(rows[0]) : null;
    },

    async updateTicket(id, { status, csId, served, closed }) {
      const sets = [];
      const params = [id];
      if (status) {
        params.push(status);
        sets.push(`status = $${params.length}`);
      }
      if (csId !== undefined) {
        params.push(csId);
        sets.push(`cs_id = $${params.length}`);
      }
      if (served) sets.push('served_at = COALESCE(served_at, now())');
      if (closed) sets.push('closed_at = now()');
      if (sets.length === 0) return false;
      const { rowCount } = await db.query(
        `UPDATE qms_tickets SET ${sets.join(', ')} WHERE ticket_id = $1`,
        params,
      );
      return rowCount === 1;
    },

    async listTickets({ scope, status, todayOnly = true, limit = 200 }) {
      const params = [];
      const where = [outletScopeSql('q.branch_id', scope, params)];
      if (status) {
        params.push(status);
        where.push(`q.status = $${params.length}`);
      }
      if (todayOnly) where.push(sameLocalDay('q.taken_at'));
      params.push(limit);
      const { rows } = await db.query(
        `SELECT ${TICKET} ${TICKET_FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY q.taken_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toTicket);
    },

    /** QMS Summary: queue volume and waiting time per outlet. */
    async ticketSummary({ scope, from, to }) {
      const params = [];
      const where = [outletScopeSql('q.branch_id', scope, params)];
      periodClause(where, params, { from, to }, 'q.taken_at');
      const { rows } = await db.query(
        `SELECT q.branch_id, b.branch_code, b.name AS branch_name,
                count(*) AS tickets,
                count(*) FILTER (WHERE q.status = 'WAITING')   AS waiting,
                count(*) FILTER (WHERE q.status = 'SERVING')   AS serving,
                count(*) FILTER (WHERE q.status = 'DONE')      AS done,
                count(*) FILTER (WHERE q.status = 'CANCELLED') AS cancelled,
                -- avg()/max() ignore NULLs, so tickets not yet served drop out by themselves.
                round(avg(EXTRACT(EPOCH FROM (q.served_at - q.taken_at)))) AS avg_wait_seconds,
                max(EXTRACT(EPOCH FROM (q.served_at - q.taken_at)))::int AS max_wait_seconds
         ${TICKET_FROM}
         WHERE ${where.join(' AND ')}
         GROUP BY q.branch_id, b.branch_code, b.name
         ORDER BY b.branch_code`,
        params,
      );
      return rows.map((row) => ({
        branchId: row.branch_id,
        branchCode: row.branch_code,
        branchName: row.branch_name,
        tickets: toNumber(row.tickets),
        waiting: toNumber(row.waiting),
        serving: toNumber(row.serving),
        done: toNumber(row.done),
        cancelled: toNumber(row.cancelled),
        avgWaitSeconds: row.avg_wait_seconds === null ? null : toNumber(row.avg_wait_seconds),
        maxWaitSeconds: row.max_wait_seconds,
      }));
    },

    async insertRating({ transactionId, qmsTicketId, csId, branchId, score, comment, ratedAt }) {
      const { rows } = await db.query(
        `INSERT INTO cs_ratings
           (transaction_id, qms_ticket_id, cs_id, branch_id, score, comment, rated_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
         RETURNING rating_id`,
        [
          transactionId ?? null,
          qmsTicketId ?? null,
          csId,
          branchId,
          score,
          comment ?? null,
          ratedAt ?? null,
        ],
      );
      return rows[0].rating_id;
    },

    /** CS Rating Summary: per staff member, with the score distribution. */
    async ratingSummary({ scope, from, to }) {
      const params = [];
      const where = [outletScopeSql('r.branch_id', scope, params)];
      if (from) {
        params.push(from);
        where.push(`r.rated_at >= $${params.length}::date`);
      }
      if (to) {
        params.push(to);
        where.push(`r.rated_at < ($${params.length}::date + 1)`);
      }
      const { rows } = await db.query(
        `SELECT r.cs_id, u.full_name AS cs_name, b.branch_code,
                count(*) AS ratings, round(avg(r.score)::numeric, 2) AS avg_score,
                count(*) FILTER (WHERE r.score = 5) AS score_5,
                count(*) FILTER (WHERE r.score = 4) AS score_4,
                count(*) FILTER (WHERE r.score = 3) AS score_3,
                count(*) FILTER (WHERE r.score = 2) AS score_2,
                count(*) FILTER (WHERE r.score = 1) AS score_1
         FROM cs_ratings r
         JOIN users u ON u.user_id = r.cs_id
         LEFT JOIN branches b ON b.branch_id = r.branch_id
         WHERE ${where.join(' AND ')}
         GROUP BY r.cs_id, u.full_name, b.branch_code
         ORDER BY avg_score DESC NULLS LAST, ratings DESC`,
        params,
      );
      return rows.map((row) => ({
        csId: row.cs_id,
        csName: row.cs_name,
        branchCode: row.branch_code,
        ratings: toNumber(row.ratings),
        avgScore: toNumber(row.avg_score),
        distribution: {
          5: toNumber(row.score_5),
          4: toNumber(row.score_4),
          3: toNumber(row.score_3),
          2: toNumber(row.score_2),
          1: toNumber(row.score_1),
        },
      }));
    },
  });
}
