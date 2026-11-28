import { api } from '../api.js';
import { emptyState, h, icon, kpiCard } from '../dom.js';
import { badge, dateTime, LABELS, number, rupiah, rupiahCompact } from '../format.js';

const TIER_ORDER = ['PLATINUM', 'GOLD', 'SILVER', 'REGULER'];

function tierBars(tiers) {
  const total = Object.values(tiers).reduce((sum, n) => sum + n, 0);
  if (total === 0) return emptyState('No customers yet');

  return h(
    'div',
    { class: 'bars' },
    TIER_ORDER.map((code) => {
      const count = tiers[code] ?? 0;
      const fill = h('div', {
        class: `bar__fill${code === 'GOLD' ? ' bar__fill--gold' : ''}`,
        style: { width: `${(count / total) * 100}%` },
      });
      return h(
        'div',
        {},
        h(
          'div',
          { class: 'bar__head' },
          h('span', {}, LABELS.tier[code][0]),
          h('span', { class: 'num muted' }, number(count)),
        ),
        h('div', { class: 'bar__track' }, fill),
      );
    }),
  );
}

function upcomingList(items) {
  if (items.length === 0) return emptyState('No upcoming appointments');
  return h(
    'ul',
    { class: 'list' },
    items.map((a) =>
      h(
        'li',
        {},
        h(
          'div',
          {},
          h('a', { href: `#/customers/${a.customerId}` }, a.customerName),
          h(
            'div',
            { class: 'muted' },
            `${dateTime(a.scheduledAt)} · ${LABELS.service[a.serviceType]} · ${a.branchCode}`,
          ),
        ),
        badge('appointment', a.status),
      ),
    ),
  );
}

export async function renderOverview(view) {
  const { data } = await api('/dashboard/summary');
  const { kpi, tiers, upcoming } = data;

  view.replaceChildren(
    h(
      'div',
      { class: 'kpis' },
      kpiCard('users', 'Total customers', number(kpi.customers)),
      kpiCard('calendar-day', 'Appointments today', number(kpi.appointmentsToday)),
      kpiCard('gem', 'Open appraisals', number(kpi.openAppraisals)),
      kpiCard(
        'sack',
        'Buyback this month',
        rupiahCompact(kpi.buybackValueMonth),
        rupiah(kpi.buybackValueMonth),
      ),
      kpiCard('comments', 'Interactions (7 days)', number(kpi.interactions7d)),
    ),
    h(
      'div',
      { class: 'grid-2' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card__header' }, h('h2', {}, icon('crown'), 'Loyalty Tiers')),
        h('div', { class: 'card__body' }, tierBars(tiers)),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card__header' },
          h('h2', {}, icon('calendar'), 'Upcoming Appointments'),
          h('a', { class: 'link-icon', href: '#/appointments' }, 'View all', icon('forward')),
        ),
        h('div', { class: 'card__body' }, upcomingList(upcoming)),
      ),
    ),
  );
}
