/** API Gateway — import external data into CRM modules and expose approved CRM APIs. */
import { api } from '../api.js';
import { emptyState, formDialog, h, icon, openModal, table, toast } from '../dom.js';
import { dateTime, LABELS, number, segmentChips, SEGMENT_ORDER, SEGMENTS } from '../format.js';
import { renderApiClients } from './apiClients.js';

const RUN_STATUS = {
  RUNNING: ['Running', 'info'],
  SUCCEEDED: ['Succeeded', 'success'],
  FAILED: ['Failed', 'danger'],
};
const POLL_MS = 1000;

const runBadge = (status) =>
  h('span', { class: `badge badge--${RUN_STATUS[status][1]}` }, RUN_STATUS[status][0]);
const runCounts = (r) =>
  `${number(r.fetched)} fetched · ${number(r.created)} new · ${number(r.matched)} matched · ${number(r.enriched ?? 0)} enriched · ${number(r.skipped)} skipped`;

/** Identity (KTP) fields a customer source can map; all optional. */
const KYC_MAP = [
  ['nik', 'NIK'],
  ['birthPlace', 'place of birth'],
  ['birthDate', 'date of birth'],
  ['gender', 'gender'],
  ['addressLine', 'street address'],
  ['city', 'city / regency'],
  ['province', 'province'],
  ['postalCode', 'postal code'],
  ['occupation', 'occupation'],
];
const mapKey = (field) => `map_${field}`;

const TARGET_OPTIONS = [
  { value: 'CUSTOMER', label: 'Customer profiles' },
  { value: 'PRODUCT', label: 'Product catalog' },
  { value: 'LEAD', label: 'Leads' },
  { value: 'APPOINTMENT', label: 'Appointments' },
  { value: 'TRANSACTION', label: 'Transactions' },
  { value: 'DATASET', label: 'Custom JSON dataset (including stock/QMS snapshots)' },
];
const TARGET_LABELS = {
  CUSTOMER: 'Customer profiles',
  PRODUCT: 'Product catalog',
  LEAD: 'Leads',
  APPOINTMENT: 'Appointments',
  TRANSACTION: 'Transactions',
  DATASET: 'Custom JSON dataset',
};

const TARGET_FIELDS = {
  CUSTOMER: [
    { type: 'section', label: 'Customer field mapping' },
    { name: 'fullName', label: 'Field for customer name', required: true, placeholder: 'name' },
    {
      name: 'phone',
      label: 'Field for phone number',
      required: true,
      placeholder: 'contact.phone',
    },
    { name: 'email', label: 'Field for email (optional)', placeholder: 'contact.email' },
    { name: 'accountId', label: 'Field for account ID (optional)', placeholder: 'id' },
    { type: 'section', label: 'Identity (KTP) fields — optional' },
    ...KYC_MAP.map(([field, label]) => ({
      name: mapKey(field),
      mapField: field,
      label: `Field for ${label}`,
      placeholder: field === 'nik' ? 'ktp.nik' : undefined,
    })),
  ],
  PRODUCT: [
    { type: 'section', label: 'Product catalog mapping (does not import stock quantities)' },
    { name: 'sku', label: 'Field for SKU', required: true, placeholder: 'sku' },
    { name: 'name', label: 'Field for product name', required: true, placeholder: 'name' },
    {
      name: 'categoryCode',
      label: 'Field for category code (optional)',
      placeholder: 'category.code',
    },
    { name: 'karat', label: 'Field for karat (optional)', placeholder: 'karat' },
    {
      name: 'baseWeightGram',
      label: 'Field for base weight in grams (optional)',
      placeholder: 'weight',
    },
    { name: 'isBullion', label: 'Field for bullion flag (optional)', placeholder: 'isBullion' },
  ],
  LEAD: [
    { type: 'section', label: 'Lead field mapping' },
    { name: 'fullName', label: 'Field for lead name', required: true, placeholder: 'name' },
    { name: 'phone', label: 'Field for phone number', required: true, placeholder: 'phone' },
    { name: 'email', label: 'Field for email (optional)', placeholder: 'email' },
    {
      name: 'referenceCode',
      label: 'Field for acquisition channel code (optional)',
      placeholder: 'source.code',
    },
    { name: 'branchCode', label: 'Field for outlet code (optional)', placeholder: 'branch.code' },
    { name: 'areaCode', label: 'Field for area code (optional)', placeholder: 'area.code' },
    { name: 'notes', label: 'Field for notes (optional)', placeholder: 'notes' },
  ],
  APPOINTMENT: [
    { type: 'section', label: 'Appointment field mapping (customer must already exist in CRM)' },
    {
      name: 'externalId',
      label: 'Field for stable external record ID',
      required: true,
      placeholder: 'id',
    },
    {
      name: 'customerAccountId',
      label: 'Field for customer account ID (optional)',
      placeholder: 'customer.id',
    },
    {
      name: 'customerPhone',
      label: 'Field for customer phone (optional)',
      placeholder: 'customer.phone',
    },
    {
      name: 'branchCode',
      label: 'Field for outlet code',
      required: true,
      placeholder: 'branch.code',
    },
    {
      name: 'serviceType',
      label: 'Field for service type',
      required: true,
      placeholder: 'serviceType',
    },
    {
      name: 'scheduledAt',
      label: 'Field for scheduled date/time',
      required: true,
      placeholder: 'scheduledAt',
    },
    { name: 'notes', label: 'Field for notes (optional)', placeholder: 'notes' },
  ],
  TRANSACTION: [
    { type: 'section', label: 'Transaction field mapping (customer must already exist in CRM)' },
    {
      name: 'externalId',
      label: 'Field for stable external record ID',
      required: true,
      placeholder: 'id',
    },
    {
      name: 'customerAccountId',
      label: 'Field for customer account ID (optional)',
      placeholder: 'customer.id',
    },
    {
      name: 'customerPhone',
      label: 'Field for customer phone (optional)',
      placeholder: 'customer.phone',
    },
    {
      name: 'branchCode',
      label: 'Field for outlet code',
      required: true,
      placeholder: 'branch.code',
    },
    {
      name: 'transactionTypeCode',
      label: 'Field for transaction type code',
      required: true,
      placeholder: 'type.code',
    },
    { name: 'invoiceNo', label: 'Field for invoice number (optional)', placeholder: 'invoiceNo' },
    { name: 'description', label: 'Field for description (optional)', placeholder: 'description' },
    {
      name: 'occurredAt',
      label: 'Field for transaction date/time (optional)',
      placeholder: 'createdAt',
    },
    { name: 'items', label: 'Path to transaction item list', required: true, placeholder: 'items' },
    {
      name: 'itemDescription',
      label: 'Field path for item description',
      required: true,
      placeholder: 'name',
    },
    {
      name: 'itemWeightGram',
      label: 'Field path for item weight in grams',
      required: true,
      placeholder: 'weightGram',
    },
    {
      name: 'itemUnitPrice',
      label: 'Field path for item unit price',
      required: true,
      placeholder: 'unitPrice',
    },
    { name: 'itemKarat', label: 'Field path for karat (optional)', placeholder: 'karat' },
    { name: 'itemProductSku', label: 'Field path for product SKU (optional)', placeholder: 'sku' },
  ],
  DATASET: [
    { type: 'section', label: 'Custom dataset mapping (encrypted JSON records)' },
    {
      name: 'datasetName',
      label: 'Dataset name',
      required: true,
      placeholder: 'e.g. Stock snapshot',
    },
    {
      name: 'externalId',
      label: 'Field for stable external record ID',
      required: true,
      placeholder: 'id',
    },
  ],
};

function sourceFields(source, targetType) {
  const map = source?.fieldMap ?? {};
  const fields = [
    {
      name: 'sourceName',
      label: 'Source name',
      required: true,
      value: source?.name,
      placeholder: 'e.g. Member App',
    },
    {
      name: 'endpointUrl',
      label: 'Endpoint URL (GET, returns JSON)',
      required: true,
      type: 'url',
      value: source?.endpointUrl,
      placeholder: 'https://partner.example.com/api/data',
    },
    {
      name: 'authHeader',
      label: 'Auth header (optional)',
      value: source?.authHeader,
      placeholder: 'Authorization or X-API-Key',
    },
    {
      name: 'authToken',
      label: source?.hasToken ? 'Auth token — leave empty to keep the saved one' : 'Auth token',
      type: 'password',
      placeholder: source?.hasToken ? '••••••••  (saved, encrypted)' : 'e.g. Bearer abc123…',
    },
    {
      name: 'listPath',
      label: 'Where the record list is in the response (empty = the response itself)',
      value: source?.listPath,
      placeholder: 'e.g. data.items',
    },
    { type: 'section', label: 'Paging & status' },
    {
      name: 'pagination',
      label: 'Pagination',
      type: 'select',
      required: true,
      options: [
        { value: 'none', label: 'None — one request returns everything' },
        { value: 'page', label: 'Pages — adds ?page=1&pageSize=N' },
      ],
      value: source?.pagination ?? 'none',
    },
    {
      name: 'pageSize',
      label: 'Page size',
      type: 'number',
      min: 1,
      max: 1000,
      step: 1,
      value: source?.pageSize ?? 100,
    },
    {
      name: 'isActive',
      label: 'Active (can be synced)',
      type: 'checkbox',
      value: source ? source.isActive : true,
    },
  ];

  if (['CUSTOMER', 'APPOINTMENT', 'TRANSACTION'].includes(targetType)) {
    fields.splice(4, 0, {
      name: 'channel',
      label:
        targetType === 'CUSTOMER'
          ? 'Imported cluster / account ID channel (required when mapped)'
          : 'Channel for customer account ID (required when mapped)',
      type: 'select',
      options: SEGMENT_ORDER.map((channel) => ({
        value: channel,
        label: SEGMENTS[channel].label,
      })),
      value: source?.channel ?? '',
    });
  }

  const mappedFields = TARGET_FIELDS[targetType] ?? [];
  fields.splice(
    fields.findIndex((field) => field.type === 'section'),
    0,
    ...mappedFields.map((field) => ({
      ...field,
      value: field.name === 'datasetName' ? source?.datasetName : map[field.mapField ?? field.name],
    })),
  );
  return fields;
}

const toBody = (v, targetType) => ({
  name: v.sourceName,
  endpointUrl: v.endpointUrl,
  authHeader: v.authHeader,
  authToken: v.authToken,
  channel: v.channel,
  targetType,
  datasetName: v.datasetName,
  listPath: v.listPath,
  fieldMap: Object.fromEntries(
    (TARGET_FIELDS[targetType] ?? [])
      .filter((field) => field.name && field.name !== 'datasetName')
      .map((field) => [field.mapField ?? field.name, v[field.name]])
      .filter(([, value]) => value),
  ),
  pagination: v.pagination,
  pageSize: v.pageSize,
  isActive: v.isActive,
});

function showTestResult(source, result) {
  const body = result.ok
    ? source.targetType === 'CUSTOMER'
      ? [
          h(
            'p',
            {},
            icon('circle-check'),
            ` Connected. ${number(result.fetched)} records on the first page.`,
          ),
          result.sampleKeys.length > 0 &&
            h('p', { class: 'muted' }, `Fields in a record: ${result.sampleKeys.join(', ')}`),
          h('h3', { class: 'modal__subhead' }, 'How the first records will be imported'),
          table(
            [
              {
                label: 'Name',
                render: (r) =>
                  r.ok
                    ? (r.fullName ?? '—')
                    : h('span', { class: 'badge badge--danger' }, 'Skipped'),
              },
              {
                label: 'Phone',
                render: (r) =>
                  r.ok ? h('span', { class: 'num' }, r.phoneMasked ?? '—') : r.reason,
              },
              { label: 'Email', render: (r) => (r.ok ? (r.email ?? '—') : '') },
              { label: 'Account id', render: (r) => (r.ok ? (r.accountId ?? '—') : '') },
              {
                label: 'Identity',
                render: (r) => {
                  if (!r.ok) return '';
                  const k = r.kyc ?? {};
                  const parts = [
                    k.nik && `NIK ${k.nik}`,
                    k.birthDate,
                    LABELS.gender[k.gender],
                    [k.city, k.province].filter(Boolean).join(', '),
                    k.addressLine && 'address',
                  ].filter(Boolean);
                  return h(
                    'span',
                    {},
                    parts.join(' · ') || '—',
                    r.ignored?.length > 0 &&
                      h(
                        'span',
                        { class: 'badge badge--warning' },
                        `ignored: ${r.ignored.join(', ')}`,
                      ),
                  );
                },
              },
            ],
            result.preview,
            { emptyText: 'The list is empty' },
          ),
        ]
      : [
          h(
            'p',
            {},
            icon('circle-check'),
            ` Connected. ${number(result.fetched)} records on the first page.`,
          ),
          result.sampleKeys.length > 0 &&
            h('p', { class: 'muted' }, `Fields in a record: ${result.sampleKeys.join(', ')}`),
          h(
            'p',
            { class: 'muted' },
            `Records will be imported into ${TARGET_LABELS[source.targetType] ?? source.targetType}.`,
          ),
        ]
    : [h('div', { class: 'alert', role: 'alert' }, result.error)];
  const modal = openModal({
    title: `Test — ${source.name}`,
    body: h('div', {}, body),
    actions: [
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: () => modal.close() },
        'Close',
      ),
    ],
    wide: true,
  });
}

function showRunErrors(run) {
  const modal = openModal({
    title: `Sync — ${run.sourceName}`,
    body: h(
      'div',
      {},
      h('p', {}, runBadge(run.status), ` ${runCounts(run)}`),
      run.errorMessage && h('div', { class: 'alert', role: 'alert' }, run.errorMessage),
      run.errors.length > 0
        ? h(
            'ul',
            { class: 'run-errors' },
            run.errors.map((e) =>
              h('li', {}, h('strong', {}, `Record #${e.index + 1}`), ` — ${e.reason}`),
            ),
          )
        : h('p', { class: 'muted' }, 'No skipped records.'),
    ),
    actions: [
      h(
        'button',
        { type: 'button', class: 'btn btn--primary', onclick: () => modal.close() },
        'Close',
      ),
    ],
  });
}

async function renderSources(view) {
  const list = h('div', { class: 'sources' });
  const history = h('div');
  const polling = new Map(); // sourceId → timer

  async function load() {
    const { data } = await api('/integrations');
    list.replaceChildren(
      ...(data.sources.length
        ? data.sources.map(sourceCard)
        : [
            h(
              'div',
              { class: 'card' },
              emptyState(
                'No API sources yet. Add a source to import data from an external system.',
              ),
            ),
          ]),
    );
    history.replaceChildren(
      table(
        [
          { label: 'Started', render: (r) => dateTime(r.startedAt) },
          { label: 'Source', render: (r) => h('strong', {}, r.sourceName) },
          { label: 'Status', render: (r) => runBadge(r.status) },
          {
            label: 'Fetched',
            align: 'right',
            render: (r) => h('span', { class: 'num' }, number(r.fetched)),
          },
          {
            label: 'New',
            align: 'right',
            render: (r) => h('span', { class: 'num' }, number(r.created)),
          },
          {
            label: 'Matched',
            align: 'right',
            render: (r) => h('span', { class: 'num' }, number(r.matched)),
          },
          {
            label: 'Enriched',
            align: 'right',
            render: (r) => h('span', { class: 'num' }, number(r.enriched ?? 0)),
          },
          {
            label: 'Skipped',
            align: 'right',
            render: (r) => h('span', { class: 'num' }, number(r.skipped)),
          },
          { label: 'By', render: (r) => r.startedByName ?? '—' },
        ],
        data.runs,
        {
          emptyText: 'No syncs yet',
          onRowClick: (r) =>
            api(`/integrations/runs/${r.id}`)
              .then(({ data: run }) => showRunErrors(run))
              .catch((e) => toast(e.message, 'error')),
        },
      ),
    );
    for (const s of data.sources)
      if (s.lastRun?.status === 'RUNNING' && !polling.has(s.id)) watch(s.id, s.lastRun.id);
  }

  function watch(sourceId, runId) {
    if (polling.has(sourceId)) return; // one poller per source
    const tick = async () => {
      try {
        const { data: run } = await api(`/integrations/runs/${runId}`);
        if (run.status === 'RUNNING') {
          polling.set(sourceId, setTimeout(tick, POLL_MS));
          return;
        }
        polling.delete(sourceId);
        toast(
          run.status === 'SUCCEEDED'
            ? `${run.sourceName}: ${number(run.created)} new, ${number(run.matched)} matched`
            : `${run.sourceName}: sync failed`,
          run.status === 'SUCCEEDED' ? 'info' : 'error',
        );
        if (view.isConnected) await load();
      } catch (error) {
        polling.delete(sourceId);
        toast(error.message, 'error');
      }
    };
    polling.set(sourceId, setTimeout(tick, POLL_MS));
  }

  function sourceCard(source) {
    const run = source.lastRun;
    const busy = run?.status === 'RUNNING';
    const syncButton = h(
      'button',
      {
        class: 'btn btn--primary btn--sm',
        disabled: busy || !source.isActive,
        title: source.isActive ? '' : 'This source is paused',
        onclick: async () => {
          syncButton.disabled = true;
          try {
            const { data } = await api(`/integrations/${source.id}/sync`, { method: 'POST' });
            await load();
            watch(source.id, data.id);
          } catch (error) {
            toast(error.message, 'error');
            syncButton.disabled = false;
          }
        },
      },
      icon('sync'),
      busy ? 'Syncing…' : 'Sync now',
    );
    const testButton = h(
      'button',
      {
        class: 'btn btn--ghost btn--sm',
        onclick: async () => {
          testButton.disabled = true;
          try {
            showTestResult(
              source,
              (await api(`/integrations/${source.id}/test`, { method: 'POST' })).data,
            );
          } catch (error) {
            toast(error.message, 'error');
          } finally {
            testButton.disabled = false;
          }
        },
      },
      icon('plug'),
      'Test connection',
    );
    const datasetButton =
      source.targetType === 'DATASET' &&
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          onclick: () => viewDataset(source).catch((error) => toast(error.message, 'error')),
        },
        icon('eye'),
        'View dataset',
      );

    let host = source.endpointUrl;
    try {
      const u = new URL(source.endpointUrl);
      host = `${u.host}${u.pathname}`;
    } catch {
      /* show as-is */
    }

    return h(
      'article',
      { class: 'card source' },
      h(
        'div',
        { class: 'source__head' },
        h('span', { class: 'source__icon' }, icon('plug')),
        h(
          'div',
          { class: 'source__title' },
          h('h2', {}, source.name),
          h('span', { class: 'muted num' }, host),
        ),
        h(
          'span',
          { class: `badge badge--${source.isActive ? 'success' : 'neutral'}` },
          source.isActive ? 'Active' : 'Paused',
        ),
      ),
      h(
        'dl',
        { class: 'meta source__meta' },
        [
          [
            'Target',
            `${TARGET_LABELS[source.targetType] ?? source.targetType}${source.datasetName ? ` · ${source.datasetName}` : ''}`,
          ],
          ...(source.targetType === 'CUSTOMER'
            ? [['Cluster', source.channel ? segmentChips([source.channel]) : 'Profiles only']]
            : []),
          ...(source.targetType === 'DATASET'
            ? [['Records', number(source.recordCount ?? 0)]]
            : []),
          ['Auth', source.authHeader ? `${source.authHeader} · token saved` : 'None'],
          [
            'Pagination',
            source.pagination === 'page' ? `Pages of ${number(source.pageSize)}` : 'None',
          ],
          [
            'Last sync',
            run
              ? h(
                  'span',
                  {},
                  runBadge(run.status),
                  ' ',
                  run.finishedAt ? dateTime(run.finishedAt) : 'in progress',
                )
              : 'Never',
          ],
        ].map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))),
      ),
      run &&
        run.status !== 'RUNNING' &&
        h(
          'p',
          { class: 'source__result muted' },
          run.errorMessage ? `${runCounts(run)} — ${run.errorMessage}` : runCounts(run),
        ),
      h(
        'div',
        { class: 'btn-group source__actions' },
        syncButton,
        testButton,
        datasetButton,
        h(
          'button',
          { class: 'btn btn--ghost btn--sm', onclick: () => edit(source) },
          icon('pen'),
          'Edit',
        ),
        h(
          'button',
          { class: 'btn btn--ghost btn--sm', onclick: () => remove(source) },
          icon('trash'),
          'Delete',
        ),
      ),
    );
  }

  async function edit(source, targetType = source?.targetType ?? 'CUSTOMER') {
    const saved = await formDialog({
      title: source ? 'Edit API Source' : 'Add API Source',
      fields: sourceFields(source, targetType),
      submitLabel: source ? 'Save changes' : 'Add source',
      onSubmit: (values) =>
        api(source ? `/integrations/${source.id}` : '/integrations', {
          method: source ? 'PUT' : 'POST',
          body: toBody(values, targetType),
        }),
    });
    if (saved) {
      toast(
        source
          ? 'API source updated'
          : 'API source added — use “Test connection” to check the mapping',
      );
      await load();
    }
  }

  async function addSource() {
    const selected = await formDialog({
      title: 'Choose an import target',
      fields: [
        {
          name: 'targetType',
          label: 'Target module',
          type: 'select',
          required: true,
          options: TARGET_OPTIONS,
          value: 'CUSTOMER',
        },
      ],
      submitLabel: 'Continue',
      onSubmit: (values) => values.targetType,
    });
    if (selected) await edit(null, selected);
  }

  async function viewDataset(source) {
    const { data } = await api(`/integrations/${source.id}/records?page=1&pageSize=50`);
    const body = data.items.length
      ? data.items.map((record) =>
          h(
            'article',
            { class: 'card' },
            h('p', { class: 'muted' }, `Updated ${dateTime(record.updatedAt)}`),
            h('pre', { class: 'code' }, JSON.stringify(record.data, null, 2)),
          ),
        )
      : [emptyState('No records in this dataset yet.')];
    const modal = openModal({
      title: `${source.datasetName} — ${number(data.total)} records`,
      body: h('div', { class: 'stack' }, body),
      actions: [
        h(
          'button',
          { type: 'button', class: 'btn btn--primary', onclick: () => modal.close() },
          'Close',
        ),
      ],
      wide: true,
    });
  }

  function remove(source) {
    const confirm = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--danger',
        onclick: async () => {
          try {
            await api(`/integrations/${source.id}`, { method: 'DELETE' });
            modal.close();
            toast('API source deleted');
            await load();
          } catch (error) {
            toast(error.message, 'error');
          }
        },
      },
      icon('trash'),
      'Delete',
    );
    const modal = openModal({
      title: 'Delete API Source',
      body: h(
        'p',
        {},
        `Delete “${source.name}” and its sync history? Imported CRM records stay; custom dataset records are deleted.`,
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

  view.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h(
        'p',
        { class: 'muted page-intro' },
        'Import external data into customer, product, lead, appointment, and transaction modules, or store encrypted custom JSON datasets. Existing CRM records are not overwritten. Product imports cover the catalog only, not stock quantities.',
      ),
      h('div', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--gold',
          onclick: () => addSource().catch((e) => toast(e.message, 'error')),
        },
        icon('plus'),
        'Add API Source',
      ),
    ),
    list,
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__header' },
        h('h2', {}, icon('history'), 'Sync History'),
        h('span', { class: 'muted' }, 'Click a row for details'),
      ),
      history,
    ),
  );
  await load();
}

const TABS = [
  ['pull', 'Import external data', 'download', renderSources],
  ['access', 'Expose CRM customer API', 'key', renderApiClients],
];

export async function renderIntegrations(view) {
  const panel = h('div', { class: 'tab-panel' });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'API Gateway' });

  async function show(key) {
    for (const button of tabs.children) {
      button.setAttribute('aria-selected', button.dataset.tab === key ? 'true' : 'false');
    }
    const [, , , render] = TABS.find(([k]) => k === key);
    panel.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    await render(panel);
  }

  tabs.append(
    ...TABS.map(([key, label, iconName]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'tab',
          dataset: { tab: key },
          onclick: () => show(key).catch((e) => toast(e.message, 'error')),
        },
        icon(iconName),
        label,
      ),
    ),
  );
  view.replaceChildren(h('div', {}, tabs), panel);
  await show('pull');
}
