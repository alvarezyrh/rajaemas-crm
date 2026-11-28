import { api } from '../api.js';
import { formDialog, h, icon, kpiCard, openModal, table, toast } from '../dom.js';
import { badge, dateTime, LABELS, number, rupiah, todayJakarta } from '../format.js';

const TICKET_ACTIONS = {
  WAITING: [
    ['SERVING', 'Serve', 'user-check'],
    ['CANCELLED', 'Cancel', 'xmark'],
  ],
  SERVING: [
    ['DONE', 'Complete', 'circle-check'],
    ['CANCELLED', 'Cancel', 'xmark'],
  ],
};

const firstOfMonth = (today) => `${today.slice(0, 7)}-01`;
const seconds = (value) => {
  if (value === null || value === undefined) return '—';
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
};

function periodFields(from, to) {
  const fromInput = h('input', {
    class: 'input',
    type: 'date',
    value: from,
    'aria-label': 'From date',
  });
  const toInput = h('input', {
    class: 'input',
    type: 'date',
    value: to,
    'aria-label': 'To date',
  });
  return { fromInput, toInput };
}

export async function renderOperations(view, { user, branches, can }) {
  const tabs = h('div', {
    class: 'tabs',
    role: 'tablist',
    'aria-label': 'Transactions and QMS',
  });
  const panel = h('div', { class: 'tab-panel' });
  const pages = [];
  if (can('transaction:read')) pages.push(['transactions', 'Transactions', renderTransactions]);
  if (can('qms:read')) pages.push(['qms', 'Queue & Ratings', renderQms]);

  async function activate(key) {
    for (const button of tabs.children) {
      button.setAttribute('aria-selected', button.dataset.tab === key ? 'true' : 'false');
    }
    panel.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Loading…')));
    try {
      await pages.find(([tab]) => tab === key)[2](panel, { user, branches, can });
    } catch (error) {
      panel.replaceChildren(
        h('div', { class: 'card' }, h('div', { class: 'empty' }, error.message)),
      );
    }
  }

  tabs.append(
    ...pages.map(([key, label]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'tab',
          dataset: { tab: key },
          'aria-selected': 'false',
          onclick: () => activate(key),
        },
        label,
      ),
    ),
  );
  view.replaceChildren(tabs, panel);
  await activate(pages[0][0]);
}

async function renderTransactions(view, { user, branches, can }) {
  const today = todayJakarta();
  const { fromInput, toInput } = periodFields(firstOfMonth(today), today);
  const sideFilter = h(
    'select',
    { class: 'select', 'aria-label': 'List side' },
    h('option', { value: '' }, 'All sides'),
    h('option', { value: 'BUY' }, 'Buy'),
    h('option', { value: 'SELL' }, 'Sell'),
  );
  const groupBy = h(
    'select',
    { class: 'select', 'aria-label': 'Summary grouping' },
    [
      ['outlet', 'By outlet'],
      ['type', 'By type'],
      ['cs', 'By staff'],
      ['day', 'By day'],
    ].map(([value, label]) => h('option', { value }, label)),
  );
  const results = h('div', { class: 'card' });
  const summary = h('div', { class: 'operations-summary' });
  const bonus = h('div');

  async function load() {
    const query = {
      from: fromInput.value,
      to: toInput.value,
      side: sideFilter.value,
      page: 1,
      pageSize: 100,
    };
    const [list, report, bonusReport] = await Promise.all([
      api('/transactions', { query }),
      can('report:executive')
        ? api('/transactions/summary', {
            query: { from: fromInput.value, to: toInput.value, groupBy: groupBy.value },
          })
        : Promise.resolve(null),
      can('report:executive')
        ? api('/bonus/summary', { query: { from: fromInput.value, to: toInput.value } })
        : Promise.resolve(null),
    ]);

    if (report) {
      const { totals, rows } = report.data;
      summary.replaceChildren(
        h(
          'div',
          { class: 'kpis' },
          kpiCard('coins', 'Transactions', number(totals.transactions)),
          kpiCard('coins', 'Buy value', rupiah(totals.buyAmount)),
          kpiCard('coins', 'Sell value', rupiah(totals.sellAmount)),
          kpiCard('scale', 'Weight', `${number(totals.grams)} g`),
        ),
        h(
          'div',
          { class: 'card' },
          table(
            [
              { label: 'Group', render: (row) => row.name },
              { label: 'Transactions', render: (row) => number(row.transactions) },
              { label: 'Buy', render: (row) => rupiah(row.buyAmount) },
              { label: 'Sell', render: (row) => rupiah(row.sellAmount) },
              { label: 'Weight', render: (row) => `${number(row.grams)} g` },
            ],
            rows,
            { emptyText: 'No transactions in this period' },
          ),
        ),
      );
    } else {
      summary.replaceChildren();
    }

    if (bonusReport) {
      const { totals, rows, provisional } = bonusReport.data;
      bonus.replaceChildren(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card__header' }, h('h2', {}, 'Bonus Summary')),
          provisional &&
            h(
              'div',
              { class: 'alert' },
              'Bonus rules are provisional. Confirm the business rules before using these figures for payroll.',
            ),
          h(
            'div',
            { class: 'kpis' },
            kpiCard('coins', 'Bonus transactions', number(totals.transactions)),
            kpiCard('coins', 'Bonus amount', rupiah(totals.bonus)),
          ),
          table(
            [
              { label: 'Staff', render: (row) => row.csName },
              { label: 'Outlet', render: (row) => row.branchCode ?? '—' },
              { label: 'Transactions', render: (row) => number(row.transactions) },
              { label: 'Transaction value', render: (row) => rupiah(row.amount) },
              { label: 'Bonus', render: (row) => rupiah(row.bonus) },
              { label: 'Avg. rating', render: (row) => row.avgScore ?? '—' },
            ],
            rows,
            { emptyText: 'No staff bonus data in this period' },
          ),
        ),
      );
    } else {
      bonus.replaceChildren();
    }

    results.replaceChildren(
      table(
        [
          { label: 'Invoice', render: (row) => h('span', { class: 'num' }, row.invoiceNo ?? '—') },
          {
            label: 'Customer',
            render: (row) => h('a', { href: `#/customers/${row.customerId}` }, row.customerName),
          },
          { label: 'Outlet', render: (row) => row.branchCode ?? '—' },
          { label: 'Type', render: (row) => row.typeName ?? row.side },
          { label: 'Side', render: (row) => LABELS.side[row.side] ?? row.side },
          { label: 'Amount', render: (row) => rupiah(row.amount) },
          { label: 'Weight', render: (row) => `${number(row.weightGram)} g` },
          { label: 'Recorded', render: (row) => dateTime(row.occurredAt) },
        ],
        list.data,
        { emptyText: 'No transactions match these filters' },
      ),
    );
  }

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    fromInput,
    toInput,
    sideFilter,
    can('report:executive') && groupBy,
    can('transaction:write') &&
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: () => createTransaction() },
        icon('plus'),
        'Record transaction',
      ),
  );
  sideFilter.addEventListener('change', () =>
    load().catch((error) => toast(error.message, 'error')),
  );
  groupBy.addEventListener('change', () => load().catch((error) => toast(error.message, 'error')));
  fromInput.addEventListener('change', () =>
    load().catch((error) => toast(error.message, 'error')),
  );
  toInput.addEventListener('change', () => load().catch((error) => toast(error.message, 'error')));
  view.replaceChildren(toolbar, summary, bonus, results);
  await load();

  async function createTransaction() {
    try {
      const [customersResult, typesResult, productsResult, ticketsResult] = await Promise.all([
        api('/customers', { query: { page: 1, pageSize: 100 } }),
        api('/transaction-types'),
        api('/products'),
        api('/qms/tickets', { query: { todayOnly: true } }),
      ]);
      const types = typesResult.data.filter((type) => type.isActive);
      const products = productsResult.data.filter((product) => product.isActive);
      const tickets = ticketsResult.data.filter((ticket) =>
        ['WAITING', 'SERVING'].includes(ticket.status),
      );
      if (types.length === 0) throw new Error('Create an active transaction type first');
      if (customersResult.data.length === 0)
        throw new Error('Add a customer before recording a transaction');

      const customerSelect = h(
        'select',
        { class: 'select', required: true, 'aria-label': 'Customer' },
        h('option', { value: '' }, 'Choose customer'),
        customersResult.data.map((customer) =>
          h(
            'option',
            { value: customer.id },
            `${customer.fullName}${customer.phoneMasked ? ` · ${customer.phoneMasked}` : ''}`,
          ),
        ),
      );
      const customerSearch = h('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Search customer name…',
        'aria-label': 'Search customer name',
      });
      const typeSelect = h(
        'select',
        { class: 'select', required: true, 'aria-label': 'Transaction type' },
        h('option', { value: '' }, 'Choose transaction type'),
        types.map((type) => h('option', { value: type.id }, `${type.code} — ${type.name}`)),
      );
      const branchSelect = h(
        'select',
        {
          class: 'select',
          required: !user.branchId,
          'aria-label': 'Outlet',
        },
        h('option', { value: '' }, 'Choose outlet'),
        branches.map((branch) =>
          h(
            'option',
            {
              value: branch.id,
              selected:
                branch.id === (user.branchId ?? (branches.length === 1 ? branches[0].id : null)),
            },
            `${branch.code} — ${branch.name}`,
          ),
        ),
      );
      const ticketSelect = h(
        'select',
        { class: 'select', 'aria-label': 'Queue ticket' },
        h('option', { value: '' }, 'No linked queue ticket'),
        tickets.map((ticket) =>
          h('option', { value: ticket.id }, `${ticket.ticketNo} · ${ticket.branchCode}`),
        ),
      );
      const lines = h('div', {});
      const errorSlot = h('div', {});
      const lineControls = [];
      const addLineButton = h(
        'button',
        { type: 'button', class: 'btn btn--ghost btn--sm', onclick: addLine },
        icon('plus'),
        'Add item',
      );
      const addRow = (label, control) =>
        h('div', { class: 'field' }, h('label', {}, label), control);

      function addLine() {
        const productSelect = h(
          'select',
          { class: 'select', 'aria-label': 'Product' },
          h('option', { value: '' }, 'Manual item'),
          products.map((product) =>
            h('option', { value: product.id }, `${product.sku} — ${product.name}`),
          ),
        );
        const description = h('input', {
          class: 'input',
          required: true,
          maxlength: 200,
          placeholder: 'Item description',
          'aria-label': 'Item description',
        });
        const weight = h('input', {
          class: 'input',
          type: 'number',
          min: 0.001,
          step: 0.001,
          required: true,
          placeholder: 'Weight (g)',
          'aria-label': 'Weight in grams',
        });
        const unitPrice = h('input', {
          class: 'input',
          type: 'number',
          min: 0,
          step: 1,
          required: true,
          placeholder: 'Price per gram',
          'aria-label': 'Price per gram',
        });
        const karat = h('input', {
          class: 'input',
          type: 'number',
          min: 0.1,
          max: 24,
          step: 0.01,
          placeholder: 'Karat (optional)',
          'aria-label': 'Karat',
        });
        productSelect.addEventListener('change', () => {
          const product = products.find((entry) => entry.id === productSelect.value);
          if (!product) return;
          if (!description.value) description.value = product.name;
          if (!karat.value && product.karat) karat.value = product.karat;
          if (!weight.value && product.baseWeightGram) weight.value = product.baseWeightGram;
        });
        const remove = h(
          'button',
          {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            'aria-label': 'Remove item',
            onclick: () => {
              const entry = lineControls.find((line) => line.row === row);
              lineControls.splice(lineControls.indexOf(entry), 1);
              row.remove();
              lineControls.forEach((line) => (line.remove.disabled = lineControls.length === 1));
            },
          },
          icon('trash'),
        );
        const row = h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'toolbar' },
            productSelect,
            description,
            weight,
            unitPrice,
            karat,
            remove,
          ),
        );
        lineControls.push({ row, productSelect, description, weight, unitPrice, karat, remove });
        lineControls.forEach((line) => (line.remove.disabled = lineControls.length === 1));
        lines.append(row);
      }

      const entryForm = h(
        'form',
        { id: 'transaction-entry-form' },
        errorSlot,
        h(
          'div',
          {},
          addRow('Search customer name…', customerSearch),
          addRow('Customer', customerSelect),
          addRow('Transaction type', typeSelect),
          branches.length > 1 || !user.branchId
            ? addRow('Outlet', branchSelect)
            : h('p', { class: 'muted' }, `Outlet: ${branches[0]?.code ?? 'assigned outlet'}`),
          addRow('Queue ticket (optional)', ticketSelect),
        ),
        h('div', { class: 'card__header' }, h('h3', {}, 'Items'), addLineButton),
        lines,
      );
      const modal = openModal({
        title: 'Record transaction',
        wide: true,
        body: entryForm,
        actions: [
          h(
            'button',
            { type: 'button', class: 'btn btn--ghost', onclick: () => modal.close() },
            'Cancel',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--primary',
              onclick: submit,
            },
            icon('check'),
            'Save transaction',
          ),
        ],
      });

      let customerSearchTimer;
      customerSearch.addEventListener('input', () => {
        clearTimeout(customerSearchTimer);
        customerSearchTimer = setTimeout(async () => {
          const query = customerSearch.value.trim();
          if (query.length === 1) return;
          try {
            const { data } = await api('/customers', {
              query: { q: query || undefined, page: 1, pageSize: 100 },
            });
            customerSelect.replaceChildren(
              h('option', { value: '' }, 'Choose customer'),
              data.map((customer) =>
                h(
                  'option',
                  { value: customer.id },
                  `${customer.fullName}${customer.phoneMasked ? ` · ${customer.phoneMasked}` : ''}`,
                ),
              ),
            );
          } catch (error) {
            errorSlot.replaceChildren(h('div', { class: 'alert', role: 'alert' }, error.message));
          }
        }, 250);
      });

      addLine();

      async function submit(event) {
        const button = event.currentTarget;
        if (!entryForm.reportValidity()) return;
        button.disabled = true;
        errorSlot.replaceChildren();
        try {
          const body = {
            customerId: customerSelect.value,
            transactionTypeId: typeSelect.value,
            branchId: branchSelect.value || undefined,
            qmsTicketId: ticketSelect.value || undefined,
            items: lineControls.map((line) => ({
              productId: line.productSelect.value || undefined,
              description: line.description.value.trim(),
              weightGram: Number(line.weight.value),
              unitPrice: Number(line.unitPrice.value),
              karat: line.karat.value ? Number(line.karat.value) : undefined,
            })),
          };
          await api('/transactions', { method: 'POST', body, idempotent: true });
          modal.close();
          toast('Transaction recorded');
          await load();
        } catch (error) {
          errorSlot.replaceChildren(h('div', { class: 'alert', role: 'alert' }, error.message));
        } finally {
          button.disabled = false;
        }
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }
}

async function renderQms(view, { user, branches, can }) {
  const today = todayJakarta();
  const { fromInput, toInput } = periodFields(firstOfMonth(today), today);
  const statusFilter = h(
    'select',
    { class: 'select', 'aria-label': 'Queue status' },
    h('option', { value: '' }, 'All statuses'),
    Object.entries(LABELS.qms).map(([value, [label]]) => h('option', { value }, label)),
  );
  const results = h('div', { class: 'card' });
  const reports = h('div');

  async function load() {
    const [tickets, qmsSummary, ratings] = await Promise.all([
      api('/qms/tickets', { query: { status: statusFilter.value, todayOnly: true } }),
      can('report:executive')
        ? api('/qms/summary', { query: { from: fromInput.value, to: toInput.value } })
        : Promise.resolve(null),
      can('report:executive')
        ? api('/cs-ratings/summary', { query: { from: fromInput.value, to: toInput.value } })
        : Promise.resolve(null),
    ]);

    if (qmsSummary && ratings) {
      reports.replaceChildren(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card__header' }, h('h2', {}, 'QMS Summary')),
          table(
            [
              { label: 'Outlet', render: (row) => `${row.branchCode} — ${row.branchName}` },
              { label: 'Tickets', render: (row) => number(row.tickets) },
              { label: 'Waiting', render: (row) => number(row.waiting) },
              { label: 'Serving', render: (row) => number(row.serving) },
              { label: 'Done', render: (row) => number(row.done) },
              { label: 'Avg. wait', render: (row) => seconds(row.avgWaitSeconds) },
            ],
            qmsSummary.data,
            { emptyText: 'No queue data in this period' },
          ),
        ),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card__header' }, h('h2', {}, 'CS Rating Summary')),
          table(
            [
              { label: 'Staff', render: (row) => row.csName },
              { label: 'Outlet', render: (row) => row.branchCode ?? '—' },
              { label: 'Ratings', render: (row) => number(row.ratings) },
              { label: 'Average', render: (row) => row.avgScore },
              { label: '5★', render: (row) => number(row.distribution[5]) },
              { label: '1★', render: (row) => number(row.distribution[1]) },
            ],
            ratings.data,
            { emptyText: 'No ratings in this period' },
          ),
        ),
      );
    } else {
      reports.replaceChildren();
    }

    results.replaceChildren(
      table(
        [
          { label: 'Ticket', render: (ticket) => h('strong', { class: 'num' }, ticket.ticketNo) },
          {
            label: 'Customer',
            render: (ticket) =>
              ticket.customerId
                ? h('a', { href: `#/customers/${ticket.customerId}` }, ticket.customerName)
                : 'Walk-in',
          },
          { label: 'Outlet', render: (ticket) => ticket.branchCode },
          { label: 'Staff', render: (ticket) => ticket.csName ?? '—' },
          { label: 'Status', render: (ticket) => badge('qms', ticket.status) },
          { label: 'Wait', render: (ticket) => seconds(ticket.waitSeconds) },
          {
            label: 'Actions',
            render: (ticket) => {
              const actions = (TICKET_ACTIONS[ticket.status] ?? []).map(
                ([status, label, iconName]) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn--ghost btn--sm',
                      onclick: () => changeStatus(ticket, status),
                    },
                    icon(iconName),
                    label,
                  ),
              );
              if (
                can('rating:write') &&
                ticket.status === 'DONE' &&
                ticket.csId &&
                !ticket.isRated
              ) {
                actions.push(
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn--ghost btn--sm',
                      onclick: () => rateTicket(ticket),
                    },
                    icon('star'),
                    'Rate service',
                  ),
                );
              }
              return actions.length ? h('div', { class: 'btn-group' }, actions) : '—';
            },
          },
        ],
        tickets.data,
        { emptyText: 'No queue tickets for today' },
      ),
    );
  }

  async function changeStatus(ticket, status) {
    try {
      await api(`/qms/tickets/${ticket.id}`, { method: 'PATCH', body: { status } });
      toast(`${ticket.ticketNo}: ${LABELS.qms[status][0]}`);
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function rateTicket(ticket) {
    try {
      const result = await formDialog({
        title: `Rate service · ${ticket.ticketNo}`,
        fields: [
          {
            name: 'score',
            label: 'Rating',
            type: 'select',
            required: true,
            options: [5, 4, 3, 2, 1].map((score) => ({
              value: String(score),
              label: `${score} stars`,
            })),
          },
          { name: 'comment', label: 'Comment (optional)', type: 'textarea', max: 500 },
        ],
        submitLabel: 'Submit rating',
        onSubmit: (values) =>
          api('/cs-ratings', {
            method: 'POST',
            body: { qmsTicketId: ticket.id, score: Number(values.score), comment: values.comment },
          }),
      });
      if (!result) return;
      toast('Service rating submitted');
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function createTicket() {
    try {
      const { data: customers } = await api('/customers', { query: { page: 1, pageSize: 100 } });
      const result = await formDialog({
        title: 'Take queue number',
        fields: [
          ...(branches.length > 1 || !user.branchId
            ? [
                {
                  name: 'branchId',
                  label: 'Outlet',
                  type: 'select',
                  required: true,
                  options: branches.map((branch) => ({
                    value: branch.id,
                    label: `${branch.code} — ${branch.name}`,
                  })),
                  value: branches.length === 1 ? branches[0].id : '',
                },
              ]
            : []),
          {
            name: 'customerId',
            label: 'Customer (optional)',
            type: 'select',
            options: customers.map((customer) => ({
              value: customer.id,
              label: `${customer.fullName}${customer.phoneMasked ? ` · ${customer.phoneMasked}` : ''}`,
            })),
          },
        ],
        submitLabel: 'Take number',
        onSubmit: (values) =>
          api('/qms/tickets', {
            method: 'POST',
            body: {
              branchId: values.branchId ?? branches[0]?.id,
              customerId: values.customerId,
            },
          }),
      });
      if (!result) return;
      toast('Queue ticket created');
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    statusFilter,
    can('report:executive') && fromInput,
    can('report:executive') && toInput,
    can('qms:write') &&
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: createTicket },
        icon('plus'),
        'Take queue number',
      ),
  );
  statusFilter.addEventListener('change', () =>
    load().catch((error) => toast(error.message, 'error')),
  );
  fromInput.addEventListener('change', () =>
    load().catch((error) => toast(error.message, 'error')),
  );
  toInput.addEventListener('change', () => load().catch((error) => toast(error.message, 'error')));
  view.replaceChildren(toolbar, reports, results);
  await load();
}
