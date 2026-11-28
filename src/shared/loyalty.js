/** Loyalty rules (pure domain logic, no I/O — easy to test). */
export const RUPIAH_PER_POINT = 100_000;

export const TIERS = Object.freeze([
  { code: 'PLATINUM', minPoints: 5_000 },
  { code: 'GOLD', minPoints: 1_000 },
  { code: 'SILVER', minPoints: 250 },
  { code: 'REGULER', minPoints: 0 },
]);

export const pointsForAmount = (amount) => Math.max(0, Math.floor(amount / RUPIAH_PER_POINT));

export const tierForPoints = (points) => TIERS.find((tier) => points >= tier.minPoints).code;

/**
 * "Loyal Customer" (menu Loyal Customer pada dokumen arsitektur).
 *
 * ⚠ PROVISIONAL NUMBERS — the threshold was not supplied. A customer counts as
 * loyal when they transact often enough AND large enough inside a rolling window,
 * or when their tier is already high. Overridable through env (see
 * `config/index.js` → `config.loyalty`).
 *
 * Derived, never stored: a flag column would have to be maintained on every
 * transaction and would drift. Phase D replaces the per-row subquery with a
 * read-model aggregate.
 */
export const DEFAULT_LOYAL_RULES = Object.freeze({
  minTransactions: 3,
  minAmount: 10_000_000,
  windowDays: 365,
  tiers: Object.freeze(['GOLD', 'PLATINUM']),
});

/**
 * @param {{ transactions?: number, amount?: number, tierCode?: string, rules?: object }} input
 */
export function isLoyal({ transactions = 0, amount = 0, tierCode, rules = DEFAULT_LOYAL_RULES }) {
  if (tierCode && rules.tiers.includes(tierCode)) return true;
  return transactions >= rules.minTransactions && amount >= rules.minAmount;
}

/**
 * SQL fragment for the derived flag. Every threshold — including the tier list —
 * is bound as a parameter; nothing from configuration is interpolated.
 * Used on a `customers c` alias; `params` is the query's parameter array.
 */
export function loyalSql(rules, params) {
  params.push(rules.tiers, rules.windowDays, rules.minTransactions, rules.minAmount);
  const tiers = `$${params.length - 3}::text[]`;
  const days = `$${params.length - 2}`;
  const minTx = `$${params.length - 1}`;
  const minAmount = `$${params.length}`;
  return `(c.tier_code = ANY(${tiers}) OR EXISTS (
    SELECT 1 FROM (
      SELECT count(*) AS n, COALESCE(sum(g.amount), 0) AS total
      FROM gold_transactions g
      WHERE g.customer_id = c.customer_id
        AND g.occurred_at >= now() - make_interval(days => ${days}::int)
    ) w WHERE w.n >= ${minTx}::int AND w.total >= ${minAmount}::numeric))`;
}
