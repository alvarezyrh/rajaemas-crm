import { api } from '../api.js';
import { emptyState, errorAlert, h, icon, kpiCard, table } from '../dom.js';
import { number, rupiah } from '../format.js';

const moneyField = /amount|bonus|spend|cost/i;
const dateValue = (offsetDays) => {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
};
const labelOf = (key) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
const displayValue = (key, value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') return moneyField.test(key) ? rupiah(value) : number(value);
  return String(value);
};

function reportRows(rows) {
  if (rows.length === 0) return emptyState('No data in this period');
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return table(
    keys.map((key) => ({
      label: labelOf(key),
      align: typeof rows.find((row) => row[key] !== undefined)?.[key] === 'number' ? 'right' : '',
      render: (row) => displayValue(key, row[key]),
    })),
    rows,
    { emptyText: 'No data in this period' },
  );
}

function reportSummary(totals) {
  const entries = Object.entries(totals ?? {}).filter(
    ([, value]) => typeof value === 'number' && Number.isFinite(value),
  );
  if (entries.length === 0) return null;
  return h(
    'div',
    { class: 'kpis report-kpis' },
    entries
      .slice(0, 6)
      .map(([key, value]) => kpiCard('chart', labelOf(key), displayValue(key, value))),
  );
}

export async function renderReports(view) {
  view.replaceChildren(emptyState('Loading reports…'));
  try {
    const { data: catalog } = await api('/reports');
    const available = catalog.filter((report) => report.available);
    if (available.length === 0) {
      view.replaceChildren(
        emptyState(
          catalog.length ? 'No reports are available for this account' : 'No reports available',
        ),
      );
      return;
    }

    const reportSelect = h(
      'select',
      { class: 'select', 'aria-label': 'Report' },
      catalog.map((report) =>
        h(
          'option',
          { value: report.name, disabled: !report.available },
          `${report.title}${report.available ? '' : ' — Coming soon'}`,
        ),
      ),
    );
    const from = h('input', {
      class: 'input',
      type: 'date',
      value: dateValue(-29),
      'aria-label': 'From date',
    });
    const to = h('input', {
      class: 'input',
      type: 'date',
      value: dateValue(0),
      'aria-label': 'To date',
    });
    const groupBy = h('select', { class: 'select', 'aria-label': 'Group by' });
    const result = h('div', { class: 'reports-result' });
    const unavailable = catalog.filter((report) => !report.available);
    const form = h(
      'form',
      { class: 'card reports-controls' },
      h(
        'div',
        { class: 'reports-controls__fields' },
        h('label', {}, 'Report', reportSelect),
        h('label', {}, 'From date', from),
        h('label', {}, 'To date', to),
        h('label', {}, 'Group by', groupBy),
        h('button', { class: 'btn btn--primary', type: 'submit' }, icon('filter'), 'Run report'),
      ),
    );

    function syncGroupOptions() {
      const selected = catalog.find((report) => report.name === reportSelect.value);
      groupBy.replaceChildren(
        h('option', { value: '' }, 'Default grouping'),
        ...(selected?.groups ?? []).map((group) => h('option', { value: group }, labelOf(group))),
      );
      groupBy.value = selected?.defaultGroupBy ?? '';
    }

    async function loadReport(event) {
      event?.preventDefault();
      result.replaceChildren(emptyState('Loading report…'));
      try {
        const selected = catalog.find((report) => report.name === reportSelect.value);
        const response = await api(`/reports/${selected.name}`, {
          query: {
            from: from.value,
            to: to.value,
            groupBy: groupBy.value,
          },
        });
        const data = response.data;
        const content = [
          h('div', { class: 'card report-heading' }, h('h2', {}, icon('chart'), data.title)),
        ];
        if (data.provisional) {
          content.push(
            h(
              'div',
              { class: 'alert', role: 'note' },
              'Bonus figures are provisional; confirm business rules before payroll use.',
            ),
          );
        }
        if (data.details?.basis) {
          content.push(h('div', { class: 'muted report-note' }, data.details.basis));
        }
        if (data.suppressedGroups) {
          content.push(
            h(
              'div',
              { class: 'muted report-note' },
              'Groups with fewer than five customers are hidden for privacy.',
            ),
          );
        }
        content.push(
          reportSummary(data.totals),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card__body' }, reportRows(data.rows ?? [])),
          ),
        );
        result.replaceChildren(...content.filter(Boolean));
      } catch (error) {
        result.replaceChildren(errorAlert(error));
      }
    }

    reportSelect.addEventListener('change', () => {
      syncGroupOptions();
      loadReport();
    });
    form.addEventListener('submit', loadReport);
    syncGroupOptions();
    const pageContent = [form];
    if (unavailable.length > 0) {
      pageContent.push(
        h(
          'div',
          { class: 'card report-note' },
          h('strong', {}, 'Planned integrations'),
          unavailable.map((report) =>
            h('p', {}, h('strong', {}, report.title), ` — ${report.reason}`),
          ),
        ),
      );
    }
    pageContent.push(result);
    view.replaceChildren(...pageContent);
    await loadReport();
  } catch (error) {
    view.replaceChildren(errorAlert(error));
  }
}
