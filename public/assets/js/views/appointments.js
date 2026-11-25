import { api } from '../api.js';
import { h, icon, table, toast } from '../dom.js';
import { badge, LABELS, time, todayJakarta } from '../format.js';

/** Next actions per status (mirrors the server-side state machine). */
const NEXT_ACTIONS = {
  SCHEDULED: [
    ['CONFIRMED', 'Confirm', 'check'],
    ['CANCELLED', 'Cancel', 'xmark'],
  ],
  CONFIRMED: [
    ['CHECKED_IN', 'Check in', 'user-check'],
    ['NO_SHOW', 'No-show', 'ban'],
    ['CANCELLED', 'Cancel', 'xmark'],
  ],
  CHECKED_IN: [['COMPLETED', 'Complete', 'circle-check']],
};

export async function renderAppointments(view, { user, branches, can }) {
  const results = h('div', { class: 'card' });
  const dateInput = h('input', {
    class: 'input',
    type: 'date',
    value: todayJakarta(),
    'aria-label': 'Date',
  });
  const branchSelect = user.branchId
    ? null
    : h(
        'select',
        { class: 'select', 'aria-label': 'Branch' },
        h('option', { value: '' }, 'All branches'),
        branches.map((b) => h('option', { value: b.id }, `${b.code} — ${b.name}`)),
      );

  async function changeStatus(appointment, status) {
    try {
      await api(`/appointments/${appointment.id}`, {
        method: 'PATCH',
        idempotent: true,
        body: { status },
      });
      toast(`${appointment.customerName}: ${LABELS.appointment[status][0]}`);
      await load();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  const columns = [
    { label: 'Time', render: (a) => h('strong', { class: 'num' }, time(a.scheduledAt)) },
    {
      label: 'Customer',
      render: (a) => h('a', { href: `#/customers/${a.customerId}` }, a.customerName),
    },
    { label: 'Branch', render: (a) => a.branchCode },
    { label: 'Service', render: (a) => LABELS.service[a.serviceType] },
    { label: 'Status', render: (a) => badge('appointment', a.status) },
    {
      label: 'Actions',
      render: (a) =>
        can('appointment:write') &&
        h(
          'div',
          { class: 'btn-group' },
          (NEXT_ACTIONS[a.status] ?? []).map(([status, label, iconName]) =>
            h(
              'button',
              { class: 'btn btn--ghost btn--sm', onclick: () => changeStatus(a, status) },
              icon(iconName),
              label,
            ),
          ),
        ),
    },
  ];

  async function load() {
    const { data } = await api('/appointments', {
      query: { date: dateInput.value, branchId: branchSelect?.value },
    });
    results.replaceChildren(table(columns, data, { emptyText: 'No appointments on this date' }));
  }

  const reload = () => load().catch((error) => toast(error.message, 'error'));
  dateInput.addEventListener('change', reload);
  branchSelect?.addEventListener('change', reload);

  view.replaceChildren(h('div', { class: 'toolbar' }, dateInput, branchSelect), results);
  await load();
}
