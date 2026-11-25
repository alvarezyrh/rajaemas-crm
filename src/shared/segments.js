/**
 * Channel-based customer clusters (pure domain logic, no I/O).
 * Membership comes from the channels a customer has used; one customer can
 * belong to more than one cluster.
 */
export const SEGMENTS = Object.freeze(['STORE', 'MOBILE_APP', 'ECOMMERCE']);

/** Customer-list filters: one cluster, multi-channel, or unclustered. */
export const SEGMENT_FILTERS = Object.freeze([...SEGMENTS, 'MULTI', 'NONE']);

/** Valid transaction sides per channel (from the customer's point of view). */
export const ALLOWED_SIDES = Object.freeze({
  STORE: Object.freeze(['BUY', 'SELL']),
  MOBILE_APP: Object.freeze(['BUY', 'SELL']),
  ECOMMERCE: Object.freeze(['BUY']),
});

/** One bit per cluster, for overlap counts (Venn diagram). */
export const SEGMENT_BIT = Object.freeze({ STORE: 1, MOBILE_APP: 2, ECOMMERCE: 4 });

export const maskOf = (channels) =>
  channels.reduce((mask, channel) => mask | (SEGMENT_BIT[channel] ?? 0), 0);

export const channelsOfMask = (mask) => SEGMENTS.filter((s) => (mask & SEGMENT_BIT[s]) !== 0);

/**
 * Builds the 7 overlap regions + "unclustered" from counts per mask.
 * @param {Record<number, number>} countsByMask
 */
export function overlapRegions(countsByMask) {
  const regions = [];
  for (let mask = 1; mask <= 7; mask += 1) {
    regions.push({ mask, channels: channelsOfMask(mask), customers: countsByMask[mask] ?? 0 });
  }
  return { regions, unclustered: countsByMask[0] ?? 0 };
}

export const isSideAllowed = (channel, side) => ALLOWED_SIDES[channel]?.includes(side) ?? false;
