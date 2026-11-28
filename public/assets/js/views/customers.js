import { api } from '../api.js';
import { formDialog, h, icon, table, toast } from '../dom.js';
import {
  badge,
  date,
  LABELS,
  number,
  options,
  segmentChips,
  SEGMENT_ORDER,
  SEGMENTS,
} from '../format.js';
import { exportCustomers, openImportDialog } from './customerCsv.js';
import { kycFields } from './customerForms.js';
import { overlapPanel, segmentCards } from './segments.js';

const PAGE_SIZE = 20;

/** Every cluster filter the list supports ('' = all customers). */
const FILTERS = [
  ['', 'All', 'users'],
  ...SEGMENT_ORDER.map((c) => [c, SEGMENTS[c].label, SEGMENTS[c].icon]),
  ['MULTI', 'Multi-channel', 'layers'],
  ['NONE', 'Unclustered', 'user-slash'],
];
const isFilter = (value) => FILTERS.some(([key]) => key === value);

const COLUMNS = [
  { label: 'Name', render: (c) => h('strong', {}, c.fullName) },
  { label: 'Phone', render: (c) => h('span', { class: 'num' }, c.phoneMasked) },
  { label: 'Clusters', render: (c) => segmentChips(c.channels, { compact: true }) },
  { label: 'Tier', render: (c) => badge('tier', c.tierCode) },
  {
    label: 'Points',
    align: 'right',
    render: (c) => h('span', { class: 'num' }, number(c.loyaltyPoints)),
  },
  { label: 'Branch', render: (c) => c.homeBranchCode ?? '—' },
  { label: 'Contact via', render: (c) => LABELS.channel[c.preferredChannel] },
  { label: 'Registered', render: (c) => date(c.createdAt) },
];

/** Digits → exact phone lookup; anything else → name search. */
const toQuery = (term) => (/^[+\d\s-]{6,}$/.test(term) ? { phone: term } : { q: term });

function openNewCustomerDialog({ user, branches }) {
  const fields = [
    { name: 'fullName', label: 'Full name', required: true },
    {
      name: 'phone',
      label: 'Phone number',
      required: true,
      type: 'tel',
      placeholder: '0812xxxxxxxx',
    },
    { name: 'email', label: 'Email', type: 'email' },
    {
      name: 'preferredChannel',
      label: 'Preferred contact',
      type: 'select',
      required: true,
      options: options(LABELS.channel),
      value: 'WHATSAPP',
    },
    !user.branchId && {
      name: 'homeBranchId',
      label: 'Home branch',
      type: 'select',
      options: branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
    },
    { name: 'marketingConsent', label: 'Customer agrees to receive promotions', type: 'checkbox' },
    { type: 'section', label: 'Identity (KTP) — optional' },
    ...kycFields(),
  ].filter(Boolean);

  return formDialog({
    title: 'Register New Customer',
    fields,
    submitLabel: 'Register',
    onSubmit: async (values) => (await api('/customers', { method: 'POST', body: values })).data,
  });
}

/**
 * Customers — one page for the customer list and customer clusters.
 * A single `segment` state drives the cluster cards, the filter tabs, the
 * URL (#/customers?seg=…) and the list query, so they can never disagree.
 */
export async function renderCustomers(view, ctx) {
  const canSeeClusters = ctx.can('segment:read');
  let segment = isFilter(ctx.params[0]) ? ctx.params[0] : '';
  let page = 1;
  let term = '';
  let activeDays = 30;
  let summary = null;
  let listRequest = 0;

  const cardsSlot = h('div');
  const overlapSlot = h('div', { class: 'card__body' });
  const results = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter by cluster' });
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name or phone number…',
    'aria-label': 'Search customers',
  });

  const fail = (error) => toast(error.message, 'error');

  function renderTabs() {
    tabs.replaceChildren(
      ...FILTERS.map(([key, label, iconName]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `tab${SEGMENTS[key] ? ` tab--${SEGMENTS[key].key}` : ''}`,
            'aria-selected': key === segment ? 'true' : 'false',
            onclick: () => setSegment(key),
          },
          icon(iconName),
          label,
        ),
      ),
    );
  }

  function renderCards() {
    if (summary)
      cardsSlot.replaceChildren(
        segmentCards(summary, segment, (c) => setSegment(segment === c ? '' : c)),
      );
  }

  function setSegment(next) {
    if (next === segment) return;
    segment = next;
    page = 1;
    history.replaceState(null, '', segment ? `#/customers?seg=${segment}` : '#/customers');
    renderTabs();
    renderCards();
    loadList().catch(fail);
  }

  async function loadSummary() {
    ({ data: summary } = await api('/segments/summary', { query: { activeDays } }));
    renderCards();
    if (overlap.open) overlapSlot.replaceChildren(overlapPanel(summary));
  }

  async function loadList() {
    const request = ++listRequest; // ignore responses that arrive after a newer request
    const { data, meta } = await api('/customers', {
      query: {
        ...(term ? toQuery(term) : {}),
        segment: segment || undefined,
        page,
        pageSize: PAGE_SIZE,
      },
    });
    if (request !== listRequest) return;
    results.replaceChildren(
      table(COLUMNS, data, {
        emptyText: term ? 'No matching customers' : 'No customers in this view',
        onRowClick: (c) => (location.hash = `#/customers/${c.id}`),
      }),
      meta.total > 0 &&
        h(
          'div',
          { class: 'pager' },
          h(
            'span',
            {},
            `Page ${meta.page} of ${meta.totalPages} · ${number(meta.total)} customers`,
          ),
          h(
            'div',
            { class: 'btn-group' },
            h(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                disabled: page <= 1,
                onclick: () => {
                  page -= 1;
                  loadList().catch(fail);
                },
              },
              icon('prev'),
              'Previous',
            ),
            h(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                disabled: page >= meta.totalPages,
                onclick: () => {
                  page += 1;
                  loadList().catch(fail);
                },
              },
              'Next',
              icon('next'),
            ),
          ),
        ),
    );
  }

  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = search.value.trim();
      if (next.length === 1 || next === term) return;
      term = next;
      page = 1;
      loadList().catch(fail);
    }, 200);
  });

  const addButton =
    ctx.can('customer:write') &&
    h(
      'button',
      {
        class: 'btn btn--gold',
        onclick: async () => {
          const customer = await openNewCustomerDialog(ctx);
          if (customer) {
            toast(`${customer.fullName} registered`);
            location.hash = `#/customers/${customer.id}`;
          }
        },
      },
      icon('plus'),
      'New Customer',
    );

  const importButton =
    ctx.can('customer:write') &&
    h(
      'button',
      {
        class: 'btn btn--ghost',
        onclick: () =>
          openImportDialog({
            onImported: (count) => {
              if (count > 0) toast(`${number(count)} customers imported`);
              page = 1;
              // Imported profiles have no cluster yet, so show "All" where they are visible.
              if (segment) setSegment('');
              else loadList().catch(fail);
              if (canSeeClusters) loadSummary().catch(fail);
            },
          }),
      },
      icon('upload'),
      'Import CSV',
    );
  const exportButton = h(
    'button',
    {
      class: 'btn btn--ghost',
      title: 'Exports the customers in the current search and cluster filter',
      onclick: () =>
        exportCustomers(exportButton, {
          ...(term ? toQuery(term) : {}),
          segment: segment || undefined,
        }),
    },
    icon('download'),
    'Export CSV',
  );

  // Channel overlap is rendered only when opened — nothing is drawn up front.
  const period = h(
    'select',
    { class: 'select select--sm', 'aria-label': 'Activity period' },
    [7, 30, 90].map((d) =>
      h('option', { value: d, selected: d === activeDays }, `Active in ${d} days`),
    ),
  );
  period.addEventListener('change', () => {
    activeDays = Number(period.value);
    loadSummary().catch(fail);
  });
  const overlap = h(
    'details',
    { class: 'card disclosure' },
    h(
      'summary',
      { class: 'card__header' },
      h('h2', {}, icon('segments'), 'Channel overlap'),
      h('span', { class: 'muted' }, 'Customer distribution by channel combination'),
    ),
    overlapSlot,
  );
  overlap.addEventListener('toggle', () => {
    if (overlap.open && summary) overlapSlot.replaceChildren(overlapPanel(summary));
  });

  renderTabs();
  view.replaceChildren(
    canSeeClusters &&
      h(
        'section',
        { class: 'cluster-overview', 'aria-label': 'Customer clusters' },
        h(
          'div',
          { class: 'section-head' },
          h('h2', {}, 'Customer clusters'),
          h('span', { class: 'muted' }, 'A customer can belong to more than one cluster.'),
          h('div', { class: 'spacer' }),
          period,
        ),
        cardsSlot,
        overlap,
      ),
    h(
      'div',
      { class: 'toolbar' },
      search,
      h('div', { class: 'spacer' }),
      importButton,
      exportButton,
      addButton,
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card__header card__header--tabs' }, tabs),
      results,
    ),
  );
  await Promise.all([loadList(), canSeeClusters ? loadSummary() : null]);
}
