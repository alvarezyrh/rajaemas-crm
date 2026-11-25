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
