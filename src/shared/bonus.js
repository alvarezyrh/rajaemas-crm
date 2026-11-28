/**
 * Staff incentive on a gold transaction (pure domain logic, no I/O).
 *
 * ⚠ PROVISIONAL NUMBERS. The business rules were not supplied, so the defaults
 * below are a placeholder and every one of them is overridable through env
 * (see `config/index.js` → `config.bonus`, and `.env.example`). Confirm the real
 * percentages and ceiling before this feeds payroll.
 */
export const DEFAULT_BONUS_RULES = Object.freeze({
  /** Percent of the transaction amount when the customer BUYS gold. */
  buyPercent: 0.1,
  /** Percent of the transaction amount on a buyback (customer SELLS). */
  sellPercent: 0.25,
  /** Ceiling per transaction, in rupiah. */
  capIdr: 500_000,
  /** Rounded down to this unit so payouts are whole, predictable rupiah. */
  roundTo: 100,
});

/**
 * @param {{ amount: number|string, side: 'BUY'|'SELL', rules?: object }} input
 * @returns {number} the incentive in whole rupiah (never negative)
 */
export function bonusFor({ amount, side, rules = DEFAULT_BONUS_RULES }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const percent = side === 'SELL' ? rules.sellPercent : rules.buyPercent;
  const capped = Math.min((value * percent) / 100, rules.capIdr);
  if (capped <= 0) return 0;
  const unit = rules.roundTo > 0 ? rules.roundTo : 1;
  return Math.floor(capped / unit) * unit;
}

/** Human-readable description of the active rules, for the UI and reports. */
export function describeBonusRules(rules = DEFAULT_BONUS_RULES) {
  return {
    buyPercent: rules.buyPercent,
    sellPercent: rules.sellPercent,
    capIdr: rules.capIdr,
    roundTo: rules.roundTo,
    provisional: true,
  };
}
