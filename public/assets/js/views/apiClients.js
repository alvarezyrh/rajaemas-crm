/** API ▸ Access for APPS / STORE — API keys that let other systems pull customer data. */
import { api } from '../api.js';
import { formDialog, h, icon, openModal, table, toast } from '../dom.js';
import { dateTime } from '../format.js';

const SCOPE_LABEL = {
  'customers:read': 'Profiles',
  'customers:read:pii': 'Identity data',
};

/** The full key is shown once, with a copy button and a ready-to-run example. */
function showNewKey(client, apiKey) {
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(apiKey);
          copy.replaceChildren(icon('check'), 'Copied');
        } catch {
          toast('Copy failed — select the key and copy it manually', 'error');
        }
      },
    },
    icon('copy'),
    'Copy',
  );
  const modal = openModal({
    title: 'API Key Created',
    wide: true,
    body: h(
      'div',
      {},
      h('p', {}, 'API key for ', h('strong', {}, client.name), ':'),
      h(
        'div',
        { class: 'secret' },
        h('code', { class: 'secret__value secret__value--long' }, apiKey),
        copy,
      ),
      h(
        'p',
        { class: 'muted' },
        'Store it in that system’s secret settings now. It is shown only once; if it is lost, revoke it and create a new one.',
      ),
      h('h3', { class: 'modal__subhead' }, 'Example'),
      h(
        'pre',
        { class: 'code' },
        `curl -H "Authorization: Bearer ${apiKey}" \\\n  "${location.origin}/api/partner/v1/customers?limit=100"`,
      ),
    ),
    actions: [
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: () => modal.close() },
        'Done',
      ),
    ],
  });
}

const DOCS = [
  [
    'GET /api/partner/v1/customers',
    'Changed customers, oldest change first. Query: updatedSince (ISO date-time), cursor (from meta.nextCursor), limit (1–500, default 100).',
  ],
  ['GET /api/partner/v1/customers/:id', 'One customer.'],
  [
    'GET /api/partner/v1/customers/lookup?phone= | ?nik=',
    'Exact match by phone or NIK (NIK lookup needs identity access).',
  ],
];

export async function renderApiClients(container) {
  const listSlot = h('div');

  async function load() {
    const { data } = await api('/api-clients');
    listSlot.replaceChildren(
      table(
        [
          { label: 'System', render: (c) => h('strong', {}, c.name) },
          { label: 'Key', render: (c) => h('code', { class: 'num' }, `rei_${c.keyPrefix}_••••`) },
          {
            label: 'Access',
            render: (c) =>
              h(
                'span',
                { class: 'seg-chips' },
                c.scopes.map((s) =>
                  h(
                    'span',
                    { class: `badge badge--${s.endsWith(':pii') ? 'warning' : 'info'}` },
                    SCOPE_LABEL[s] ?? s,
                  ),
                ),
              ),
          },
          {
            label: 'Status',
            render: (c) =>
              h(
                'span',
                { class: `badge badge--${c.isActive ? 'success' : 'neutral'}` },
                c.isActive ? 'Active' : 'Revoked',
              ),
          },
          { label: 'Last used', render: (c) => (c.lastUsedAt ? dateTime(c.lastUsedAt) : 'Never') },
          {
            label: 'Created',
            render: (c) =>
              `${dateTime(c.createdAt)}${c.createdByName ? ` · ${c.createdByName}` : ''}`,
          },
          {
            label: 'Actions',
            render: (c) =>
              c.isActive &&
              h(
                'button',
                { class: 'btn btn--ghost btn--sm', onclick: () => revoke(c) },
                icon('ban'),
                'Revoke',
              ),
          },
        ],
        data,
        { emptyText: 'No API keys yet. Create one for each system (e.g. APPS and STORE).' },
      ),
    );
  }

  async function create() {
    const result = await formDialog({
      title: 'Create API Key',
      fields: [
        { name: 'name', label: 'System name', required: true, placeholder: 'e.g. APPS or STORE' },
        {
          name: 'includePii',
          label: 'Include identity data (phone, NIK, email, birth data, street address)',
          type: 'checkbox',
          value: false,
        },
      ],
      submitLabel: 'Create key',
      onSubmit: async (values) =>
        (await api('/api-clients', { method: 'POST', body: values })).data,
    });
    if (!result) return;
    await load();
    showNewKey(result.client, result.apiKey);
  }

  function revoke(client) {
    const confirm = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--danger',
        onclick: async () => {
          try {
            await api(`/api-clients/${client.id}/revoke`, { method: 'POST' });
            modal.close();
            toast(`${client.name}: key revoked`);
            await load();
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      },
      icon('ban'),
      'Revoke key',
    );
    const modal = openModal({
      title: 'Revoke API Key',
      body: h(
        'p',
        {},
        `Revoke the key for `,
        h('strong', {}, client.name),
        '? That system will lose access immediately.',
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

  container.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h(
        'p',
        { class: 'muted page-intro' },
        'Give other company systems (APPS, STORE) read access to CRM customers. Each system gets its own key; identity data is only included when you allow it, and every request is written to the audit log.',
      ),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn--gold', onclick: create }, icon('plus'), 'Create API Key'),
    ),
    h('div', { class: 'card' }, listSlot),
    h(
      'details',
      { class: 'card disclosure' },
      h(
        'summary',
        { class: 'card__header' },
        h('h2', {}, icon('plug'), 'How APPS / STORE pull data'),
        h('span', { class: 'muted' }, 'Endpoints and paging'),
      ),
      h(
        'div',
        { class: 'card__body api-docs' },
        h(
          'p',
          {},
          'Send the key as ',
          h('code', {}, 'Authorization: Bearer <key>'),
          ' (or ',
          h('code', {}, 'X-API-Key'),
          '). Responses use the standard envelope.',
        ),
        h(
          'dl',
          {},
          DOCS.map(([endpoint, text]) => [h('dt', {}, h('code', {}, endpoint)), h('dd', {}, text)]),
        ),
        h(
          'p',
          { class: 'muted' },
          'Incremental sync: store meta.nextCursor and pass it back until it is null; next time, start again from the last cursor (or from updatedSince). A customer reappears whenever their profile, tier or clusters change.',
        ),
      ),
    ),
  );
  await load();
}
