/** Advertising — acquisition budgets per area × channel × month, plus the summary. */
import { api } from '../api.js';
import { formDialog, h, icon, kpiCard, table, toast } from '../dom.js';
import { date, number, rupiah } from '../format.js';

const percent = (rate) => `${(rate * 100).toFixed(1)}%`;
/** `<input type="month">` gives YYYY-MM; the API wants a full date. */
const toMonthStart = (value) => (value ? `${value}-01` : undefined);
const toMonthInput = (iso) => (iso ? iso.slice(0, 7) : '');

export async function renderAdvertising(view, { can }) {
  const kpis = h('div', { class: 'kpis' });
  const summaryCard = h('div', { class: 'card' });
  const budgetCard = h('div', { class: 'card' });

  const from = h('input', { class: 'input', type: 'month', 'aria-label': 'From month' });
  const to = h('input', { class: 'input', type: 'month', 'aria-label': 'To month' });
  const groupBy = h(
    'select',
    { class: 'select', 'aria-label': 'Group by' },
    h('option', { value: 'reference' }, 'By channel'),
    h('option', { value: 'area' }, 'By area'),
  );

  let areas = [];
  let references = [];
  async function loadMasterData() {
    if (areas.length && references.length) return;
    [areas, references] = await Promise.all([
      (await api('/areas')).data,
      (await api('/references')).data,
    ]);
  }

  function budgetFields(budget) {
    return [
      {
        name: 'areaId',
        label: 'Area',
        type: 'select',
        required: true,
        options: areas.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
        value: budget?.areaId ?? '',
      },
      {
        name: 'referenceId',
        label: 'Channel',
        type: 'select',
        required: true,
        options: references.map((r) => ({ value: r.id, label: r.name })),
        value: budget?.referenceId ?? '',
      },
      {
        name: 'periodMonth',
        label: 'Month',
        type: 'month',
        required: true,
        value: toMonthInput(budget?.periodMonth),
      },
      {
        name: 'spendAmount',
        label: 'Spend (IDR)',
        type: 'number',
        required: true,
        min: 0,
        step: '1000',
        inputmode: 'numeric',
        value: budget?.spendAmount ?? '',
      },
      { name: 'notes', label: 'Notes', max: 300, value: budget?.notes ?? '' },
    ];
  }

  /** `type: 'month'` is not a dom.js control type, so the value is read as text. */
  const normalize = (values) => ({
    ...values,
    periodMonth: toMonthStart(values.periodMonth),
    spendAmount: values.spendAmount === undefined ? undefined : Number(values.spendAmount),
  });

  async function addBudget() {
    await loadMasterData();
    const result = await formDialog({
      title: 'Add Advertising Budget',
      fields: budgetFields(null),
      submitLabel: 'Create',
      onSubmit: (values) =>
        api('/advertising-budgets', { method: 'POST', body: normalize(values) }),
    });
    if (!result) return;
    toast('Budget created');
    await load();
  }

  async function editBudget(budget) {
    await loadMasterData();
    const result = await formDialog({
      title: `Edit Budget — ${budget.areaCode} · ${budget.referenceCode}`,
      fields: budgetFields(budget),
      submitLabel: 'Save changes',
      onSubmit: (values) =>
        api(`/advertising-budgets/${budget.id}`, { method: 'PATCH', body: normalize(values) }),
    });
    if (!result) return;
    toast('Budget updated');
    await load();
  }

  const period = () => ({ from: toMonthStart(from.value), to: toMonthStart(to.value) });

  async function load() {
    const [summary, budgets] = await Promise.all([
      api('/advertising/summary', { query: { ...period(), groupBy: groupBy.value } }),
      api('/advertising-budgets', { query: period() }),
    ]);
    const s = summary.data;
    const label = (row) =>
      groupBy.value === 'area' ? (row.areaName ?? row.key) : (row.referenceName ?? row.key);

    kpis.replaceChildren(
      kpiCard('sack', 'Spend in period', rupiah(s.totals.spend)),
      kpiCard('users', 'Leads', number(s.totals.leads)),
      kpiCard('handshake', 'Converted', number(s.totals.converted)),
      kpiCard(
        'coins',
        'Cost per lead',
        s.totals.costPerLead === null ? '—' : rupiah(s.totals.costPerLead),
        s.totals.costPerLead === null ? 'Area spend vs outlet leads' : undefined,
      ),
    );

    summaryCard.replaceChildren(
      h(
        'div',
        { class: 'card__header' },
        h('h2', {}, icon('filter'), 'Advertising Summary'),
        // Only worth explaining when the two sides are not the same population.
        !s.comparable && h('span', { class: 'muted' }, 'Area spend, outlet leads — ratios hidden'),
      ),
      h(
        'div',
        { class: 'card__body' },
        table(
          [
            { label: groupBy.value === 'area' ? 'Area' : 'Channel', render: label },
            { label: 'Spend', align: 'right', render: (r) => rupiah(r.spend) },
            { label: 'Leads', align: 'right', render: (r) => number(r.leads) },
            { label: 'Converted', align: 'right', render: (r) => number(r.converted) },
            { label: 'Conversion', align: 'right', render: (r) => percent(r.conversionRate) },
            {
              label: 'Cost / lead',
              align: 'right',
              render: (r) => (r.costPerLead === null ? '—' : rupiah(r.costPerLead)),
            },
            {
              label: 'Cost / conversion',
              align: 'right',
              render: (r) => (r.costPerConversion === null ? '—' : rupiah(r.costPerConversion)),
            },
          ],
          s.rows,
          { emptyText: 'No spend or leads in this period' },
        ),
      ),
    );

    budgetCard.replaceChildren(
      h(
        'div',
        { class: 'card__header' },
        h('h2', {}, icon('sack'), 'Budgets'),
        can('budget:manage') &&
          h(
            'button',
            {
              class: 'btn btn--gold btn--sm',
              onclick: () => addBudget().catch((error) => toast(error.message, 'error')),
            },
            icon('plus'),
            'Add Budget',
          ),
      ),
      h(
        'div',
        { class: 'card__body' },
        table(
          [
            { label: 'Month', render: (b) => b.periodMonth.slice(0, 7) },
            { label: 'Area', render: (b) => `${b.areaCode} — ${b.areaName}` },
            { label: 'Channel', render: (b) => b.referenceName },
            { label: 'Spend', align: 'right', render: (b) => rupiah(b.spendAmount) },
            { label: 'Notes', render: (b) => b.notes ?? '—' },
            { label: 'Updated', render: (b) => date(b.updatedAt) },
            can('budget:manage') && {
              label: 'Actions',
              render: (b) =>
                h(
                  'button',
                  {
                    class: 'btn btn--ghost btn--sm',
                    onclick: () => editBudget(b).catch((error) => toast(error.message, 'error')),
                  },
                  icon('pen'),
                  'Edit',
                ),
            },
          ].filter(Boolean),
          budgets.data,
          { emptyText: 'No budgets in this period' },
        ),
      ),
    );
  }

  const reload = () => load().catch((error) => toast(error.message, 'error'));
  from.addEventListener('change', reload);
  to.addEventListener('change', reload);
  groupBy.addEventListener('change', reload);

  view.replaceChildren(
    kpis,
    h('div', { class: 'toolbar' }, h('label', {}, 'From'), from, h('label', {}, 'To'), to, groupBy),
    summaryCard,
    budgetCard,
  );
  await load();
}
