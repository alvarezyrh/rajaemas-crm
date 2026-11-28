/**
 * Master Data — areas, outlets, product catalogue, transaction types,
 * acquisition references and CS assignments, in one tabbed screen.
 *
 * Every entity is soft-deactivated ("Active" checkbox) instead of deleted, so
 * historical transactions keep their references. CS assignments are the
 * exception: an assignment is a period of time and can be ended.
 */
import { api } from '../api.js';
import { formDialog, h, icon, openModal, table, toast } from '../dom.js';
import { badge, LABELS, todayJakarta } from '../format.js';

const statusBadge = (isActive) =>
  h(
    'span',
    { class: `badge badge--${isActive ? 'success' : 'neutral'}` },
    isActive ? 'Active' : 'Inactive',
  );

const CHANNEL_TYPES = {
  DIGITAL_ADS: 'Digital ads',
  SOCIAL: 'Social media',
  SEARCH: 'Search',
  WALK_IN: 'Walk-in',
  APP: 'Mobile app',
  REFERRAL: 'Referral',
  EVENT: 'Event',
  OTHER: 'Other',
};

const optionsOf = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));

/**
 * Builds one CRUD tab. `fields(row)` returns the form definition (row = null
 * when creating); `extra` is loaded before the dialog opens and passed to it.
 */
function entityTab({
  path,
  writePermission,
  columns,
  fields,
  createLabel,
  emptyText,
  extra,
  allowCreate = true,
}) {
  return async function render(panel, ctx) {
    const body = h('div', { class: 'card' });
    const showInactive = h('input', { type: 'checkbox', id: 'show-inactive' });

    async function load() {
      const { data } = await api(path, {
        query: { includeInactive: showInactive.checked || undefined },
      });
      body.replaceChildren(
        table(
          [
            ...columns,
            { label: 'Status', render: (row) => statusBadge(row.isActive) },
            ctx.can(writePermission) && {
              label: 'Actions',
              render: (row) =>
                h(
                  'div',
                  { class: 'btn-group' },
                  h(
                    'button',
                    { class: 'btn btn--ghost btn--sm', onclick: () => edit(row) },
                    icon('pen'),
                    'Edit',
                  ),
                ),
            },
          ].filter(Boolean),
          data,
          { emptyText },
        ),
      );
    }

    async function openDialog(row) {
      const context = extra ? await extra(ctx) : {};
      // Fields may be conditional (`!row && …`), so falsy entries are dropped here.
      const fieldList = (await fields(row, context)).filter(Boolean);
      const result = await formDialog({
        title: row ? `${row.name ?? row.code ?? row.sku}` : createLabel,
        fields: fieldList,
        submitLabel: row ? 'Save changes' : 'Create',
        onSubmit: (values) =>
          row
            ? api(`${path}/${row.id}`, { method: 'PATCH', body: values })
            : api(path, { method: 'POST', body: values }),
      });
      if (!result) return;
      toast(row ? 'Saved' : 'Created');
      await load();
    }

    const edit = (row) => openDialog(row).catch((e) => toast(e.message, 'error'));
    showInactive.addEventListener('change', () => load().catch((e) => toast(e.message, 'error')));

    panel.replaceChildren(
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'field--check', for: 'show-inactive' },
          showInactive,
          h('span', {}, 'Show inactive'),
        ),
        h('div', { class: 'spacer' }),
        allowCreate &&
          ctx.can(writePermission) &&
          h(
            'button',
            {
              class: 'btn btn--gold',
              onclick: () => openDialog(null).catch((e) => toast(e.message, 'error')),
            },
            icon('plus'),
            createLabel,
          ),
      ),
      body,
    );
    await load();
  };
}

/* ------------------------------------------------------------------ */
/* Tab definitions                                                     */
/* ------------------------------------------------------------------ */
/** Codes are the stable reference used by other tables: set once, never edited. */
const codeField = (max = 32) => ({
  name: 'code',
  label: 'Code',
  required: true,
  max,
  placeholder: 'UPPER_SNAKE',
});

const areasTab = entityTab({
  path: '/areas',
  writePermission: 'masterdata:manage',
  createLabel: 'Add Area',
  emptyText: 'No areas yet',
  columns: [
    { label: 'Code', render: (r) => h('strong', {}, r.code) },
    { label: 'Name', render: (r) => r.name },
    { label: 'Province', render: (r) => r.province },
    { label: 'City', render: (r) => r.city ?? '—' },
  ],
  fields: (row) => [
    !row && codeField(16),
    { name: 'name', label: 'Name', required: true, max: 120, value: row?.name },
    { name: 'province', label: 'Province', required: true, max: 80, value: row?.province },
    { name: 'city', label: 'City', max: 80, value: row?.city ?? '' },
    { name: 'regionCode', label: 'Region code', max: 16, value: row?.regionCode ?? '' },
    row && { name: 'isActive', label: 'Active', type: 'checkbox', value: row.isActive },
  ],
});

const outletsTab = entityTab({
  path: '/branches',
  writePermission: 'outlet:manage',
  createLabel: 'Add Outlet',
  emptyText: 'No outlets yet',
  // Outlets are provisioned centrally; this view only edits existing ones.
  allowCreate: false,
  columns: [
    { label: 'Code', render: (r) => h('strong', {}, r.code) },
    { label: 'Name', render: (r) => r.name },
    { label: 'Area', render: (r) => r.areaCode ?? '—' },
    { label: 'Region', render: (r) => r.region },
    { label: 'City', render: (r) => r.city ?? '—' },
    { label: 'Time zone', render: (r) => r.timezone },
    { label: 'Google Place ID', render: (r) => r.googlePlaceId ?? '—' },
  ],
  extra: async () => ({ areas: (await api('/areas')).data }),
  fields: (row, { areas }) => [
    { name: 'name', label: 'Name', required: true, max: 120, value: row?.name },
    { name: 'region', label: 'Region', max: 60, value: row?.region },
    {
      name: 'areaId',
      label: 'Area',
      type: 'select',
      options: areas.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
      value: row?.areaId ?? '',
    },
    { name: 'address', label: 'Address', max: 200, value: row?.address ?? '' },
    { name: 'city', label: 'City', max: 80, value: row?.city ?? '' },
    { name: 'province', label: 'Province', max: 80, value: row?.province ?? '' },
    {
      name: 'timezone',
      label: 'Time zone',
      type: 'select',
      options: optionsOf({
        'Asia/Jakarta': 'Asia/Jakarta (WIB)',
        'Asia/Makassar': 'Asia/Makassar (WITA)',
        'Asia/Jayapura': 'Asia/Jayapura (WIT)',
      }),
      value: row?.timezone ?? 'Asia/Jakarta',
    },
    {
      name: 'googlePlaceId',
      label: 'Google Place ID (for review sync)',
      max: 120,
      value: row?.googlePlaceId ?? '',
    },
    row && { name: 'isActive', label: 'Active', type: 'checkbox', value: row.isActive },
  ],
});

const productsTab = entityTab({
  path: '/products',
  writePermission: 'masterdata:manage',
  createLabel: 'Add Product',
  emptyText: 'No products yet',
  columns: [
    { label: 'SKU', render: (r) => h('strong', { class: 'num' }, r.sku) },
    { label: 'Name', render: (r) => r.name },
    { label: 'Category', render: (r) => r.categoryName ?? '—' },
    { label: 'Karat', align: 'num', render: (r) => r.karat ?? '—' },
    { label: 'Base weight (g)', align: 'num', render: (r) => r.baseWeightGram ?? '—' },
    {
      label: 'Type',
      render: (r) =>
        r.isBullion ? h('span', { class: 'badge badge--gold' }, 'Bullion LM REI') : '—',
    },
  ],
  extra: async () => ({ categories: (await api('/product-categories')).data }),
  fields: (row, { categories }) => [
    !row && {
      name: 'sku',
      label: 'SKU',
      required: true,
      max: 64,
      placeholder: 'LM-REI-10',
    },
    { name: 'name', label: 'Name', required: true, max: 160, value: row?.name },
    {
      name: 'categoryId',
      label: 'Category',
      type: 'select',
      options: categories.map((c) => ({ value: c.id, label: c.name })),
      value: row?.categoryId ?? '',
    },
    {
      name: 'karat',
      label: 'Karat (0.1–24)',
      type: 'number',
      step: '0.01',
      value: row?.karat ?? '',
    },
    {
      name: 'baseWeightGram',
      label: 'Base weight (gram)',
      type: 'number',
      step: '0.001',
      value: row?.baseWeightGram ?? '',
    },
    {
      name: 'isBullion',
      label: 'Bullion / Logam Mulia (LM REI)',
      type: 'checkbox',
      value: row?.isBullion,
    },
    row && { name: 'isActive', label: 'Active', type: 'checkbox', value: row.isActive },
  ],
});

const categoriesTab = entityTab({
  path: '/product-categories',
  writePermission: 'masterdata:manage',
  createLabel: 'Add Category',
  emptyText: 'No categories yet',
  columns: [
    { label: 'Code', render: (r) => h('strong', {}, r.code) },
    { label: 'Name', render: (r) => r.name },
  ],
  fields: (row) => [
    !row && codeField(),
    { name: 'name', label: 'Name', required: true, max: 120, value: row?.name },
    row && { name: 'isActive', label: 'Active', type: 'checkbox', value: row.isActive },
  ],
});

const transactionTypesTab = entityTab({
  path: '/transaction-types',
  writePermission: 'masterdata:manage',
  createLabel: 'Add Transaction Type',
  emptyText: 'No transaction types yet',
  columns: [
    { label: 'Code', render: (r) => h('strong', {}, r.code) },
    { label: 'Name', render: (r) => r.name },
    { label: 'Side', render: (r) => badge('side', r.side) },
    {
      label: 'Bullion',
      render: (r) => (r.isBullion ? h('span', { class: 'badge badge--gold' }, 'LM REI') : '—'),
    },
    { label: 'Needs appraisal', render: (r) => (r.requiresAppraisal ? 'Yes' : 'No') },
  ],
  fields: (row) => [
    !row && codeField(),
    { name: 'name', label: 'Name', required: true, max: 120, value: row?.name },
    {
      name: 'side',
      label: 'Side (from the customer’s point of view)',
      type: 'select',
      required: true,
      options: optionsOf(LABELS.side),
      value: row?.side ?? 'BUY',
    },
    {
      name: 'isBullion',
      label: 'Bullion / LM REI scheme',
      type: 'checkbox',
      value: row?.isBullion,
    },
    {
      name: 'requiresAppraisal',
      label: 'Requires an appraisal before settling',
      type: 'checkbox',
      value: row?.requiresAppraisal,
    },
    row && { name: 'isActive', label: 'Active', type: 'checkbox', value: row.isActive },
  ],
});

const referencesTab = entityTab({
  path: '/references',
  writePermission: 'masterdata:manage',
  createLabel: 'Add Reference',
  emptyText: 'No acquisition channels yet',
  columns: [
    { label: 'Code', render: (r) => h('strong', {}, r.code) },
    { label: 'Name', render: (r) => r.name },
    { label: 'Channel type', render: (r) => CHANNEL_TYPES[r.channelType] ?? r.channelType },
  ],
  fields: (row) => [
    !row && codeField(),
    { name: 'name', label: 'Name', required: true, max: 120, value: row?.name },
    {
      name: 'channelType',
      label: 'Channel type',
      type: 'select',
      required: true,
      options: optionsOf(CHANNEL_TYPES),
      value: row?.channelType ?? 'WALK_IN',
    },
    row && { name: 'isActive', label: 'Active', type: 'checkbox', value: row.isActive },
  ],
});

/* ------------------------------------------------------------------ */
/* CS assignments — a period of time, so it is ended rather than edited */
/* ------------------------------------------------------------------ */
async function renderCsAssignments(panel, ctx) {
  const body = h('div', { class: 'card' });
  const canWrite = ctx.can('staffing:manage');

  async function load() {
    const { data } = await api('/cs-assignments');
    body.replaceChildren(
      table(
        [
          { label: 'Staff', render: (r) => h('strong', {}, r.userName) },
          { label: 'Email', render: (r) => r.userEmail },
          { label: 'Outlet', render: (r) => `${r.branchCode} — ${r.branchName}` },
          {
            label: 'Primary',
            render: (r) =>
              r.isPrimary ? h('span', { class: 'badge badge--brand' }, 'Primary') : '—',
          },
          { label: 'From', render: (r) => r.validFrom },
          { label: 'Until', render: (r) => r.validTo ?? '—' },
          canWrite && {
            label: 'Actions',
            render: (r) =>
              h(
                'button',
                { class: 'btn btn--ghost btn--sm', onclick: () => end(r) },
                icon('trash'),
                'End',
              ),
          },
        ].filter(Boolean),
        data,
        { emptyText: 'No customer service assignments yet' },
      ),
    );
  }

  async function add() {
    const staffResult = await api('/cs-assignments/staff');
    const staff = staffResult.data;
    const outlets = ctx.branches.length ? ctx.branches : (await api('/branches')).data;
    if (staff.length === 0) {
      toast('No staff account is available in your scope', 'error');
      return;
    }
    const result = await formDialog({
      title: 'Assign Customer Service',
      fields: [
        {
          name: 'userId',
          label: 'Staff',
          type: 'select',
          required: true,
          options: staff.map((s) => ({
            value: s.id,
            label: `${s.fullName} — ${LABELS.role[s.role] ?? s.role}${s.branchCode ? ` (${s.branchCode})` : ''}`,
          })),
        },
        {
          name: 'branchId',
          label: 'Outlet',
          type: 'select',
          required: true,
          options: outlets.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
          value: ctx.user.branchId ?? '',
        },
        {
          name: 'validFrom',
          label: 'Valid from',
          type: 'date',
          required: true,
          value: todayJakarta(),
        },
        { name: 'validTo', label: 'Valid until (empty = ongoing)', type: 'date' },
        { name: 'isPrimary', label: 'Primary officer of this outlet', type: 'checkbox' },
      ],
      submitLabel: 'Assign',
      onSubmit: (values) => api('/cs-assignments', { method: 'POST', body: values }),
    });
    if (!result) return;
    toast('Assignment created');
    await load();
  }

  function end(row) {
    const confirm = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary',
        onclick: async () => {
          confirm.disabled = true;
          try {
            await api(`/cs-assignments/${row.id}`, { method: 'DELETE' });
            modal.close();
            toast('Assignment ended');
            await load();
          } catch (error) {
            toast(error.message, 'error');
            confirm.disabled = false;
          }
        },
      },
      icon('trash'),
      'End assignment',
    );
    const modal = openModal({
      title: 'End Assignment',
      body: h(
        'p',
        {},
        `End the assignment of `,
        h('strong', {}, row.userName),
        ` at ${row.branchCode}? The history stays in the audit log.`,
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

  panel.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'muted' }, 'Who serves which outlet, and since when.'),
      h('div', { class: 'spacer' }),
      canWrite &&
        h(
          'button',
          { class: 'btn btn--gold', onclick: () => add().catch((e) => toast(e.message, 'error')) },
          icon('user-plus'),
          'Assign CS',
        ),
    ),
    body,
  );
  await load();
}

const TABS = [
  ['areas', 'Areas', 'map', areasTab],
  ['outlets', 'Outlets', 'store', outletsTab],
  ['products', 'Products', 'gem', productsTab],
  ['categories', 'Categories', 'layers', categoriesTab],
  ['types', 'Transaction Types', 'coins', transactionTypesTab],
  ['references', 'References', 'filter', referencesTab],
  ['cs', 'Customer Services', 'user-check', renderCsAssignments],
];

export async function renderMasterData(view, ctx) {
  const panel = h('div', { class: 'tab-panel' });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Master Data' });

  async function show(key) {
    for (const button of tabs.children) {
      button.setAttribute('aria-selected', button.dataset.tab === key ? 'true' : 'false');
    }
    const [, , , render] = TABS.find(([k]) => k === key);
    panel.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    await render(panel, ctx);
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
  await show(TABS[0][0]);
}
