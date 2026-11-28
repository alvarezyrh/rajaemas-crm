/**
 * Customer-cluster components used by the Customers page:
 * cluster cards (also act as a filter) and the channel-overlap panel.
 */
import { h, icon } from '../dom.js';
import { number, rupiah, rupiahCompact, segmentChips, SEGMENTS } from '../format.js';

const pct = (n) => `${Math.round(n * 100)}%`;

/* ---------------------------------------------------------------------- */
/* Cluster cards                                                           */
/* ---------------------------------------------------------------------- */
function segmentCard(segment, activeDays, selected, onSelect) {
  const meta = SEGMENTS[segment.channel];
  const stats = [
    [`Active in ${activeDays} days`, number(segment.activeCustomers)],
    ['Transactions', number(segment.transactions)],
    ['Bought', rupiahCompact(segment.buyAmount), rupiah(segment.buyAmount)],
    segment.channel === 'ECOMMERCE'
      ? [
          'Avg. per customer',
          rupiahCompact(segment.customers ? segment.buyAmount / segment.customers : 0),
        ]
      : ['Sold', rupiahCompact(segment.sellAmount), rupiah(segment.sellAmount)],
  ];

  return h(
    'button',
    {
      type: 'button',
      class: `card seg-card seg-card--${meta.key}`,
      'aria-pressed': selected ? 'true' : 'false',
      title: selected ? 'Show all customers' : `Show ${meta.label} customers`,
      dataset: { seg: segment.channel },
      onclick: () => onSelect(segment.channel),
    },
    h(
      'span',
      { class: 'seg-card__head' },
      h('span', { class: 'seg-card__icon' }, icon(meta.icon)),
      h(
        'span',
        {},
        h('span', { class: 'seg-card__name' }, meta.label),
        h('span', { class: 'seg-card__long' }, meta.hint),
      ),
    ),
    h(
      'span',
      { class: 'seg-card__count' },
      h('span', { class: 'seg-card__value' }, number(segment.customers)),
      h('span', { class: 'seg-card__unit' }, segment.customers === 1 ? 'customer' : 'customers'),
      h('span', { class: 'seg-card__share' }, `${pct(segment.share)} of total`),
    ),
    h(
      'span',
      { class: 'seg-card__track', 'aria-hidden': 'true' },
      h('span', { class: 'seg-card__fill', style: { width: pct(segment.share) } }),
    ),
    h(
      'span',
      { class: 'seg-card__stats' },
      stats.map(([label, value, full]) =>
        h(
          'span',
          { class: 'seg-card__stat', title: full ?? undefined },
          h('span', {}, label),
          h('strong', { class: 'num' }, value),
        ),
      ),
    ),
  );
}

export function segmentCards(summary, selected, onSelect) {
  return h(
    'div',
    { class: 'seg-cards' },
    summary.segments.map((s) =>
      segmentCard(s, summary.activeDays, s.channel === selected, onSelect),
    ),
  );
}

/* ---------------------------------------------------------------------- */
/* Channel-overlap panel: simple bars for each channel combination         */
/* ---------------------------------------------------------------------- */
const regionTitle = (channels) =>
  channels.length === 1
    ? `${SEGMENTS[channels[0]].label} only`
    : channels.map((c) => SEGMENTS[c].label).join(' + ');

function overlapBarChart(overlap, total) {
  const rows = [...overlap.regions]
    .sort((a, b) => a.channels.length - b.channels.length || a.mask - b.mask)
    .map((region) => ({
      label: regionTitle(region.channels),
      chips: segmentChips(region.channels, { compact: true }),
      value: region.customers,
    }));
  rows.push({
    label: 'Unclustered',
    chips: h(
      'span',
      { class: 'seg-chips' },
      h('span', { class: 'seg-chip seg-chip--none seg-chip--icon' }, icon('user-slash')),
    ),
    value: overlap.unclustered,
  });

  return h(
    'ul',
    { class: 'comp', 'aria-label': 'Customer distribution by channel combination' },
    rows.map((row) => {
      const share = total ? pct(row.value / total) : '0%';
      return h(
        'li',
        {},
        row.chips,
        h('span', { class: 'comp__label' }, row.label),
        h(
          'span',
          { class: 'comp__track', 'aria-hidden': 'true' },
          h('span', { class: 'comp__fill', style: { width: share } }),
        ),
        h('span', { class: 'comp__value num' }, number(row.value)),
        h('span', { class: 'comp__pct num muted' }, share),
      );
    }),
  );
}

export function overlapPanel(summary) {
  return h(
    'div',
    { class: 'overlap-chart' },
    overlapBarChart(summary.overlap, summary.totalCustomers),
  );
}
