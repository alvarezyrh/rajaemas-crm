import { api } from '../api.js';
import { formDialog, h, icon, table, toast } from '../dom.js';
import { badge, date, LABELS, number, rupiah } from '../format.js';

export async function renderAppraisals(view, { user, can }) {
  const results = h('div', { class: 'card' });
  const statusSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Status' },
    h('option', { value: '' }, 'All statuses'),
    Object.entries(LABELS.appraisal).map(([value, [label]]) => h('option', { value }, label)),
  );

  async function changeStatus(appraisal, status, finalPrice) {
    const { data } = await api(`/appraisals/${appraisal.id}/status`, {
      method: 'PATCH',
      idempotent: true,
      body: { status, finalPrice },
    });
    toast(
      data.loyalty
        ? `Buyback settled · +${number(data.loyalty.pointsAwarded)} points (tier ${data.loyalty.tierCode})`
        : `Status updated: ${LABELS.appraisal[status][0]}`,
    );
    await load();
  }

  const safeChange = (appraisal, status) =>
    changeStatus(appraisal, status).catch((e) => toast(e.message, 'error'));

  async function settle(appraisal) {
    await formDialog({
      title: `Settle Buyback — ${appraisal.customerName}`,
      submitLabel: 'Approve & Settle',
      fields: [
        {
          name: 'finalPrice',
          label: 'Final price (Rp)',
          type: 'number',
          step: '1',
          min: 0,
          required: true,
          value: appraisal.offeredPrice,
        },
      ],
      onSubmit: ({ finalPrice }) => changeStatus(appraisal, 'SETTLED', finalPrice).then(() => true),
    });
  }

  function actionsFor(a) {
    if (a.status === 'OFFERED' && can('appraisal:write')) {
      return [
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            title: 'Customer accepted the offer',
            onclick: () => safeChange(a, 'ACCEPTED'),
          },
          icon('check'),
          'Accept',
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            title: 'Customer rejected the offer',
            onclick: () => safeChange(a, 'REJECTED'),
          },
          icon('xmark'),
          'Reject',
        ),
      ];
    }
    if (a.status === 'ACCEPTED' && can('appraisal:approve')) {
      return [
        h(
          'button',
          { class: 'btn btn--gold btn--sm', onclick: () => settle(a) },
          icon('handshake'),
          'Settle',
        ),
      ];
    }
    return [];
  }

  const columns = [
    { label: 'Date', render: (a) => date(a.createdAt) },
    {
      label: 'Customer',
      render: (a) => h('a', { href: `#/customers/${a.customerId}` }, a.customerName),
    },
    { label: 'Item', render: (a) => a.itemDescription },
    {
      label: 'Weight · Purity',
      align: 'right',
      render: (a) => h('span', { class: 'num' }, `${a.weightGram} g · ${a.purityKarat}K`),
    },
    {
      label: 'Offer',
      align: 'right',
      render: (a) => h('span', { class: 'num' }, rupiah(a.offeredPrice)),
    },
    {
      label: 'Final',
      align: 'right',
      render: (a) => h('span', { class: 'num' }, rupiah(a.finalPrice)),
    },
    !user.branchId && { label: 'Branch', render: (a) => a.branchCode },
    { label: 'Status', render: (a) => badge('appraisal', a.status) },
    { label: 'Actions', render: (a) => h('div', { class: 'btn-group' }, actionsFor(a)) },
  ].filter(Boolean);

  async function load() {
    const { data } = await api('/appraisals', {
      query: { status: statusSelect.value, pageSize: 50 },
    });
    results.replaceChildren(table(columns, data, { emptyText: 'No appraisals yet' }));
  }

  statusSelect.addEventListener('change', () => load().catch((e) => toast(e.message, 'error')));
  view.replaceChildren(h('div', { class: 'toolbar' }, statusSelect), results);
  await load();
}
