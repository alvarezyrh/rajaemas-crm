import { api } from '../api.js';
import { emptyState, formDialog, h, icon, toast } from '../dom.js';
import {
  badge,
  date,
  dateTime,
  LABELS,
  number,
  options,
  segmentChips,
  SEGMENTS,
} from '../format.js';
import { ageOf, kycFields } from './customerForms.js';

const branchOptions = (branches) =>
  branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }));

function timelineView(items) {
  if (items.length === 0) return emptyState('No history yet');
  return h(
    'ol',
    { class: 'timeline' },
    items.map((item) => {
      const tag =
        item.kind === 'APPOINTMENT'
          ? badge('appointment', item.label)
          : item.kind === 'APPRAISAL'
            ? badge('appraisal', item.label)
            : item.kind === 'TRANSACTION'
              ? segmentChips([item.label])
              : h('span', { class: 'badge badge--info' }, LABELS.channel[item.label] ?? item.label);
      const detail = item.kind === 'APPOINTMENT' ? LABELS.service[item.detail] : item.detail;
      return h(
        'li',
        {
          dataset: {
            kind: item.kind,
            seg: item.kind === 'TRANSACTION' ? SEGMENTS[item.label]?.key : undefined,
          },
        },
        h(
          'div',
          { class: 'timeline__head' },
          h('strong', {}, LABELS.kind[item.kind]),
          tag,
          h(
            'span',
            { class: 'timeline__time' },
            `${dateTime(item.at)}${item.branchCode ? ` · ${item.branchCode}` : ''}`,
          ),
        ),
        h('div', {}, detail),
      );
    }),
  );
}

export async function renderCustomerDetail(view, { params: [id], user, branches, can }) {
  const [{ data: customer }, { data: timeline }] = await Promise.all([
    api(`/customers/${id}`),
    api(`/customers/${id}/timeline`),
  ]);
  const reload = () => renderCustomerDetail(view, { params: [id], user, branches, can });
  const pickBranch = !user.branchId && {
    name: 'branchId',
    label: 'Branch',
    type: 'select',
    required: true,
    options: branchOptions(branches),
    value: customer.homeBranchId,
  };

  const phone = h('div', { class: 'profile__phone' }, customer.phoneMasked);
  const nikCell = h('dd', {}, customer.hasNik ? 'On file (encrypted)' : 'Not provided');
  const addressCell = h('dd', {}, customer.hasAddress ? 'On file (encrypted)' : 'Not provided');
  const revealButton = can('customer:pii:reveal')
    ? h('button', { class: 'btn btn--ghost btn--sm' }, icon('eye'), 'Show full details')
    : null;
  revealButton?.addEventListener('click', async () => {
    revealButton.disabled = true;
    try {
      const { data } = await api(`/customers/${id}/pii/reveal`, { method: 'POST' });
      phone.replaceChildren(data.phone);
      if (data.nik) nikCell.replaceChildren(h('span', { class: 'num' }, data.nik));
      if (data.addressLine) addressCell.replaceChildren(data.addressLine);
      revealButton.remove();
      toast('Sensitive data revealed — recorded in the audit log');
    } catch (error) {
      toast(error.message, 'error');
      revealButton.disabled = false;
    }
  });

  const editProfile =
    can('customer:write') &&
    h(
      'button',
      {
        class: 'btn btn--ghost btn--sm',
        onclick: async () => {
          const saved = await formDialog({
            title: `Edit Profile — ${customer.fullName}`,
            fields: [
              { name: 'fullName', label: 'Full name', required: true, value: customer.fullName },
              { name: 'email', label: 'Email', type: 'email', value: customer.email },
              {
                name: 'preferredChannel',
                label: 'Preferred contact',
                type: 'select',
                required: true,
                options: options(LABELS.channel),
                value: customer.preferredChannel,
              },
              !user.branchId && {
                name: 'homeBranchId',
                label: 'Home branch',
                type: 'select',
                options: branchOptions(branches),
                value: customer.homeBranchId ?? '',
              },
              {
                name: 'marketingConsent',
                label: 'Customer agrees to receive promotions',
                type: 'checkbox',
                value: customer.marketingConsent,
              },
              { type: 'section', label: 'Identity (KTP)' },
              ...kycFields(customer),
            ].filter(Boolean),
            submitLabel: 'Save profile',
            onSubmit: (values) => api(`/customers/${id}`, { method: 'PATCH', body: values }),
          });
          if (saved) {
            toast('Profile updated');
            reload();
          }
        },
      },
      icon('pen'),
      'Edit profile',
    );

  const born = [
    customer.birthPlace,
    customer.birthDate &&
      `${date(`${customer.birthDate}T00:00:00+07:00`)} (age ${ageOf(customer.birthDate)})`,
  ]
    .filter(Boolean)
    .join(', ');
  const identity = [
    ['NIK', nikCell],
    ['Born', born || '—'],
    ['Gender', LABELS.gender[customer.gender] ?? '—'],
    ['Occupation', customer.occupation ?? '—'],
    ['Address', addressCell],
    ['City / regency', customer.city ?? '—'],
    ['Province', customer.province ?? '—'],
    ['Postal code', customer.postalCode ?? '—'],
  ];

  const actions = [
    can('appointment:write') &&
      h(
        'button',
        {
          class: 'btn btn--primary',
          onclick: async () => {
            const ok = await formDialog({
              title: 'Book Appointment',
              fields: [
                pickBranch,
                {
                  name: 'serviceType',
                  label: 'Service',
                  type: 'select',
                  required: true,
                  options: options(LABELS.service),
                },
                {
                  name: 'scheduledAt',
                  label: 'Visit time',
                  type: 'datetime-local',
                  required: true,
                },
                { name: 'notes', label: 'Notes', type: 'textarea', max: 500 },
              ].filter(Boolean),
              onSubmit: (values) =>
                api('/appointments', {
                  method: 'POST',
                  idempotent: true,
                  body: { ...values, customerId: id },
                }),
            });
            if (ok) {
              toast('Appointment booked');
              reload();
            }
          },
        },
        icon('calendar-plus'),
        'Book Appointment',
      ),
    can('appraisal:write') &&
      h(
        'button',
        {
          class: 'btn btn--gold',
          onclick: async () => {
            const ok = await formDialog({
              title: 'Record Appraisal',
              fields: [
                pickBranch,
                {
                  name: 'itemDescription',
                  label: 'Item description',
                  required: true,
                  placeholder: 'e.g. 24K gold necklace',
                },
                {
                  name: 'weightGram',
                  label: 'Weight (grams)',
                  type: 'number',
                  step: '0.001',
                  min: 0.001,
                  required: true,
                },
                {
                  name: 'purityKarat',
                  label: 'Purity (karat)',
                  type: 'number',
                  step: '0.01',
                  min: 1,
                  max: 24,
                  required: true,
                },
                {
                  name: 'offeredPrice',
                  label: 'Offer price (Rp)',
                  type: 'number',
                  step: '1',
                  min: 0,
                  required: true,
                },
                { name: 'notes', label: 'Test notes', type: 'textarea', max: 500 },
              ].filter(Boolean),
              onSubmit: (values) =>
                api('/appraisals', {
                  method: 'POST',
                  idempotent: true,
                  body: { ...values, customerId: id },
                }),
            });
            if (ok) {
              toast('Appraisal recorded');
              reload();
            }
          },
        },
        icon('scale'),
        'Record Appraisal',
      ),
    can('transaction:write') &&
      h(
        'button',
        {
          class: 'btn btn--ghost',
          onclick: async () => {
            const ok = await formDialog({
              title: 'Record Store Transaction',
              fields: [
                pickBranch,
                {
                  name: 'side',
                  label: 'Transaction type',
                  type: 'select',
                  required: true,
                  options: [
                    { value: 'BUY', label: 'Customer buys gold' },
                    { value: 'SELL', label: 'Customer sells gold' },
                  ],
                },
                { name: 'description', label: 'Item', placeholder: 'e.g. 5 g gold bar' },
                {
                  name: 'weightGram',
                  label: 'Weight (grams)',
                  type: 'number',
                  step: '0.001',
                  min: 0.001,
                  required: true,
                },
                {
                  name: 'amount',
                  label: 'Transaction value (Rp)',
                  type: 'number',
                  step: '1',
                  min: 0,
                  required: true,
                },
              ].filter(Boolean),
              submitLabel: 'Record',
              onSubmit: (values) =>
                api(`/customers/${id}/transactions`, {
                  method: 'POST',
                  idempotent: true,
                  body: values,
                }),
            });
            if (ok) {
              toast('Store transaction recorded');
              reload();
            }
          },
        },
        icon('store'),
        'Store Transaction',
      ),
    can('interaction:write') &&
      h(
        'button',
        {
          class: 'btn btn--ghost',
          onclick: async () => {
            const ok = await formDialog({
              title: 'Log Interaction',
              fields: [
                {
                  name: 'channel',
                  label: 'Channel',
                  type: 'select',
                  required: true,
                  options: options(LABELS.channel),
                },
                {
                  name: 'direction',
                  label: 'Direction',
                  type: 'select',
                  required: true,
                  options: [
                    { value: 'INBOUND', label: 'Inbound' },
                    { value: 'OUTBOUND', label: 'Outbound' },
                  ],
                },
                {
                  name: 'summary',
                  label: 'Topic summary',
                  type: 'textarea',
                  required: true,
                  max: 500,
                },
              ],
              onSubmit: (values) =>
                api(`/customers/${id}/interactions`, { method: 'POST', body: values }),
            });
            if (ok) {
              toast('Interaction logged');
              reload();
            }
          },
        },
        icon('comments'),
        'Log Interaction',
      ),
  ];

  view.replaceChildren(
    h(
      'div',
      {},
      h('a', { class: 'link-icon', href: '#/customers' }, icon('back'), 'Back to customers'),
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__body' },
        h(
          'div',
          { class: 'profile' },
          h(
            'div',
            {},
            h(
              'div',
              { class: 'timeline__head' },
              h('h2', {}, customer.fullName),
              badge('tier', customer.tierCode),
            ),
            phone,
            h('div', { class: 'btn-group' }, revealButton, editProfile),
          ),
          h('div', { class: 'btn-group' }, actions),
        ),
        h(
          'dl',
          { class: 'meta' },
          [
            ['Clusters', segmentChips(customer.channels)],
            ['Loyalty points', number(customer.loyaltyPoints)],
            ['Home branch', customer.homeBranchCode ?? '—'],
            ['Contact via', LABELS.channel[customer.preferredChannel]],
            ['Email', customer.email ?? '—'],
            ['Marketing consent', customer.marketingConsent ? 'Yes' : 'No'],
          ].map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))),
        ),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__header' },
        h('h2', {}, icon('id'), 'Identity (KTP)'),
        customer.kycSource &&
          h(
            'span',
            { class: 'muted' },
            `Source: ${customer.kycSource}${customer.kycUpdatedAt ? ` · ${dateTime(customer.kycUpdatedAt)}` : ''}`,
          ),
      ),
      h(
        'div',
        { class: 'card__body' },
        h(
          'dl',
          { class: 'meta meta--flush' },
          identity.map(([label, value]) =>
            h('div', {}, h('dt', {}, label), value instanceof Node ? value : h('dd', {}, value)),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card__header' }, h('h2', {}, icon('history'), 'Unified History')),
      h('div', { class: 'card__body' }, timelineView(timeline)),
    ),
  );
}
