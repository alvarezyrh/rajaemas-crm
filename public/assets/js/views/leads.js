/** Leads — the acquisition funnel in front of Customer 360. */
import { api } from '../api.js';
import { formDialog, h, icon, kpiCard, openModal, table, toast } from '../dom.js';
import { badge, date, LABELS, number } from '../format.js';

/** Next actions per status (mirrors the server-side state machine). */
const NEXT_ACTIONS = {
  NEW: [
    ['CONTACTED', 'Contact', 'comments'],
    ['QUALIFIED', 'Qualify', 'circle-check'],
    ['LOST', 'Lost', 'ban'],
  ],
  CONTACTED: [
    ['QUALIFIED', 'Qualify', 'circle-check'],
    ['LOST', 'Lost', 'ban'],
  ],
  QUALIFIED: [['LOST', 'Lost', 'ban']],
};

const TERMINAL = new Set(['CONVERTED', 'LOST', 'EXPIRED']);
const percent = (rate) => `${(rate * 100).toFixed(1)}%`;

export async function renderLeads(view, { branches, can }) {
  const kpis = h('div', { class: 'kpis' });
  const results = h('div', { class: 'card' });
  const channels = h('div', { class: 'card' });

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name…',
    'aria-label': 'Search leads',
  });
  const statusFilter = h(
    'select',
    { class: 'select', 'aria-label': 'Status' },
    h('option', { value: '' }, 'All statuses'),
    Object.entries(LABELS.lead).map(([value, [label]]) => h('option', { value }, label)),
  );
  const channelFilter = h(
    'select',
    { class: 'select', 'aria-label': 'Channel' },
    h('option', { value: '' }, 'All channels'),
  );

  async function setStatus(lead, status) {
    // Losing a lead needs a reason, and the server enforces it.
    if (status === 'LOST') return lose(lead);
    try {
      await api(`/leads/${lead.id}`, { method: 'PATCH', body: { status } });
      toast(`${lead.fullName}: ${LABELS.lead[status][0]}`);
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function lose(lead) {
    return formDialog({
      title: `Mark ${lead.fullName} as lost`,
      fields: [
        {
          name: 'lostReason',
          label: 'Reason',
          required: true,
          max: 120,
          placeholder: 'No response after three attempts',
        },
      ],
      submitLabel: 'Mark as lost',
      onSubmit: (values) =>
        api(`/leads/${lead.id}`, { method: 'PATCH', body: { status: 'LOST', ...values } }),
    })
      .then((result) => {
        if (!result) return;
        toast(`${lead.fullName}: lost`);
        return load();
      })
      .catch((error) => toast(error.message, 'error'));
  }

  function convert(lead) {
    const confirm = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary',
        onclick: async () => {
          confirm.disabled = true;
          try {
            const { data } = await api(`/leads/${lead.id}/convert`, { method: 'POST' });
            modal.close();
            await load();
            toast(
              data.alreadyConverted
                ? 'This lead was already converted'
                : `${lead.fullName} is now a customer`,
            );
            if (data.customerId) location.hash = `#/customers/${data.customerId}`;
          } catch (error) {
            toast(error.message, 'error');
            confirm.disabled = false;
          }
        },
      },
      icon('handshake'),
      'Convert to customer',
    );
    const modal = openModal({
      title: 'Convert Lead',
      body: h(
        'p',
        {},
        `Create a customer profile for `,
        h('strong', {}, lead.fullName),
        `? If the phone number already belongs to a customer, that profile is linked instead of duplicated.`,
      ),
      actions: [
        h(
          'button',
          { type: 'button', class: 'btn btn--ghost', onclick: () => modal.close() },
          'Cancel',
        ),
        confirm,
      ],
    });
  }

  function edit(lead, references) {
    return formDialog({
      title: `Edit Lead — ${lead.fullName}`,
      fields: [
        { name: 'fullName', label: 'Full name', required: true, max: 120, value: lead.fullName },
        {
          name: 'referenceId',
          label: 'Acquisition channel',
          type: 'select',
          options: references.map((r) => ({ value: r.id, label: r.name })),
          value: lead.referenceId ?? '',
        },
        {
          name: 'branchId',
          label: 'Outlet',
          type: 'select',
          options: branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
          value: lead.branchId ?? '',
        },
        { name: 'notes', label: 'Notes', type: 'textarea', max: 500, value: lead.notes ?? '' },
      ],
      submitLabel: 'Save changes',
      onSubmit: (values) => api(`/leads/${lead.id}`, { method: 'PATCH', body: values }),
    })
      .then((result) => {
        if (!result) return;
        toast('Lead updated');
        return load();
      })
      .catch((error) => toast(error.message, 'error'));
  }

  async function create(references) {
    const result = await formDialog({
      title: 'Add Lead',
      fields: [
        { name: 'fullName', label: 'Full name', required: true, max: 120 },
        {
          name: 'phone',
          label: 'Phone number',
          required: true,
          inputmode: 'tel',
          placeholder: '0812 3456 7890',
        },
        { name: 'email', label: 'Email', type: 'email', max: 160 },
        {
          name: 'referenceId',
          label: 'Acquisition channel',
          type: 'select',
          options: references.map((r) => ({ value: r.id, label: r.name })),
        },
        {
          name: 'branchId',
          label: 'Outlet',
          type: 'select',
          options: branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
          value: branches.length === 1 ? branches[0].id : '',
        },
        { name: 'notes', label: 'Notes', type: 'textarea', max: 500 },
      ],
      submitLabel: 'Create lead',
      onSubmit: (values) => api('/leads', { method: 'POST', body: values }),
    });
    if (!result) return;
    toast('Lead created');
    await load();
  }

  const columns = (references) => [
    {
      label: 'Name',
      render: (l) =>
        h(
          'span',
          {},
          h('strong', {}, l.fullName),
          l.convertedCustomerId &&
            h(
              'a',
              { class: 'muted', href: `#/customers/${l.convertedCustomerId}` },
              ' · customer profile',
            ),
        ),
    },
    { label: 'Phone', render: (l) => h('span', { class: 'num' }, l.phone ?? l.phoneMasked) },
    { label: 'Channel', render: (l) => l.referenceName ?? '—' },
    { label: 'Outlet', render: (l) => l.branchCode ?? l.areaCode ?? '—' },
    { label: 'Status', render: (l) => badge('lead', l.status) },
    { label: 'Owner', render: (l) => l.ownerName ?? '—' },
    { label: 'Created', render: (l) => date(l.createdAt) },
    {
      label: 'Actions',
      render: (l) =>
        TERMINAL.has(l.status)
          ? h('span', { class: 'muted' }, l.status === 'LOST' ? l.lostReason : '—')
          : h(
              'div',
              { class: 'btn-group' },
              (NEXT_ACTIONS[l.status] ?? []).map(([status, label, iconName]) =>
                can('lead:write')
                  ? h(
                      'button',
                      {
                        class: 'btn btn--ghost btn--sm',
                        onclick: () => setStatus(l, status),
                      },
                      icon(iconName),
                      label,
                    )
                  : null,
              ),
              can('lead:convert') &&
                h(
                  'button',
                  { class: 'btn btn--gold btn--sm', onclick: () => convert(l) },
                  icon('handshake'),
                  'Convert',
                ),
              can('lead:write') &&
                h(
                  'button',
                  { class: 'btn btn--ghost btn--sm', onclick: () => edit(l, references) },
                  icon('pen'),
                  'Edit',
                ),
            ),
    },
  ];

  /** Acquisition channels are master data; fetched once and reused for filter and forms. */
  let referenceCache = null;
  async function loadReferences() {
    if (referenceCache) return referenceCache;
    referenceCache = (await api('/references')).data;
    channelFilter.append(...referenceCache.map((r) => h('option', { value: r.id }, r.name)));
    return referenceCache;
  }

  async function load() {
    const references = await loadReferences();

    const [list, summary] = await Promise.all([
      api('/leads', {
        query: {
          q: search.value.trim() || undefined,
          status: statusFilter.value || undefined,
          referenceId: channelFilter.value || undefined,
          pageSize: 50,
        },
      }),
      api('/leads/summary'),
    ]);

    const s = summary.data;
    kpis.replaceChildren(
      kpiCard('users', 'Leads in period', number(s.total)),
      kpiCard('comments', 'Open leads', number(s.openLeads)),
      kpiCard('handshake', 'Converted', number(s.byStatus.CONVERTED)),
      kpiCard('crown', 'Conversion rate', percent(s.conversionRate)),
      kpiCard(
        'history',
        'Avg. days to convert',
        s.avgDaysToConvert === null ? '—' : s.avgDaysToConvert.toFixed(1),
      ),
    );

    results.replaceChildren(
      table(columns(references), list.data, { emptyText: 'No leads match these filters' }),
    );

    channels.replaceChildren(
      h('div', { class: 'card__header' }, h('h2', {}, icon('filter'), 'Lead Summary by Channel')),
      h(
        'div',
        { class: 'card__body' },
        table(
          [
            { label: 'Channel', render: (r) => r.name },
            { label: 'Leads', align: 'right', render: (r) => number(r.leads) },
            { label: 'Converted', align: 'right', render: (r) => number(r.converted) },
            {
              label: 'Conversion',
              align: 'right',
              render: (r) => (r.leads ? percent(r.converted / r.leads) : '—'),
            },
          ],
          s.byReference,
          { emptyText: 'No leads in this period' },
        ),
      ),
    );
  }

  const reload = () => load().catch((error) => toast(error.message, 'error'));
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(reload, 200);
  });
  statusFilter.addEventListener('change', reload);
  channelFilter.addEventListener('change', reload);

  view.replaceChildren(
    kpis,
    h(
      'div',
      { class: 'toolbar' },
      search,
      statusFilter,
      channelFilter,
      h('div', { class: 'spacer' }),
      can('lead:write') &&
        h(
          'button',
          {
            class: 'btn btn--gold',
            onclick: () =>
              loadReferences()
                .then((references) => create(references))
                .catch((error) => toast(error.message, 'error')),
          },
          icon('user-plus'),
          'Add Lead',
        ),
    ),
    results,
    channels,
  );
  await load();
}
