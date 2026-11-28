/** Users — staff account management (head office only). */
import { api } from '../api.js';
import { formDialog, h, icon, openModal, table, toast } from '../dom.js';
import { dateTime, LABELS } from '../format.js';

const ROLE_HINT = {
  SUPER_ADMIN: 'Every outlet and every setting, including global configuration.',
  HQ_STAFF: 'All outlets; manages users, master data and API sources.',
  AREA_MANAGER: 'All outlets in one area; supervises staff and performance.',
  BRANCH_HEAD: 'One outlet; approves buybacks and assigns its CS officers.',
  CUSTOMER_SERVICE: 'Customers, leads, appointments and interactions; outlet optional.',
  DIGITAL_MARKETING: 'Campaigns, budgets and reviews; no identity data.',
  APPRAISER: 'One outlet; records appraisals and store transactions.',
};

function userFields({ user, branches, areas, isSelf }) {
  return [
    !user && {
      name: 'email',
      label: 'Work email',
      type: 'email',
      required: true,
      placeholder: 'name@rajaemas.id',
    },
    { name: 'fullName', label: 'Full name', required: true, value: user?.fullName },
    { name: 'jobTitle', label: 'Job title', max: 80, value: user?.jobTitle ?? '' },
    !isSelf && {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: Object.entries(LABELS.role).map(([value, label]) => ({
        value,
        label: `${label} — ${ROLE_HINT[value] ?? ''}`,
      })),
      value: user?.role ?? 'CUSTOMER_SERVICE',
    },
    !isSelf && {
      name: 'branchId',
      label: 'Outlet (required for Branch Head & Appraiser, empty for head-office roles)',
      type: 'select',
      options: branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
      value: user?.branchId ?? '',
    },
    !isSelf && {
      name: 'areaId',
      label: 'Area (required for Area Manager, empty for every other role)',
      type: 'select',
      options: areas.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
      value: user?.areaId ?? '',
    },
    user &&
      !isSelf && {
        name: 'isActive',
        label: 'Active (can sign in)',
        type: 'checkbox',
        value: user.isActive,
      },
  ].filter(Boolean);
}

/** Shows a temporary password once, with a copy button. */
function showTemporaryPassword(title, user, password) {
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(password);
          copy.replaceChildren(icon('check'), 'Copied');
        } catch {
          toast('Copy failed — select the password and copy it manually', 'error');
        }
      },
    },
    icon('copy'),
    'Copy',
  );
  const modal = openModal({
    title,
    body: h(
      'div',
      {},
      h('p', {}, `Temporary password for `, h('strong', {}, user.fullName), ` (${user.email}):`),
      h('div', { class: 'secret' }, h('code', { class: 'secret__value' }, password), copy),
      h(
        'p',
        { class: 'muted' },
        'Share it privately. It is shown only once; they must choose their own password the first time they sign in.',
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

export async function renderUsers(view, { user: me, branches }) {
  // Areas are master data: only roles that may read it get the picker filled.
  const areas = (await api('/areas').catch(() => ({ data: [] }))).data;
  const results = h('div', { class: 'card' });
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name or email…',
    'aria-label': 'Search users',
  });
  const roleFilter = h(
    'select',
    { class: 'select', 'aria-label': 'Role' },
    h('option', { value: '' }, 'All roles'),
    Object.entries(LABELS.role).map(([value, label]) => h('option', { value }, label)),
  );
  const statusFilter = h(
    'select',
    { class: 'select', 'aria-label': 'Status' },
    h('option', { value: 'true' }, 'Active'),
    h('option', { value: 'false' }, 'Inactive'),
    h('option', { value: '' }, 'All statuses'),
  );

  const columns = [
    {
      label: 'Name',
      render: (u) =>
        h(
          'span',
          {},
          h('strong', {}, u.fullName),
          u.id === me.id && h('span', { class: 'muted' }, ' (you)'),
        ),
    },
    { label: 'Email', render: (u) => u.email },
    { label: 'Role', render: (u) => LABELS.role[u.role] ?? u.role },
    { label: 'Outlet', render: (u) => u.branchCode ?? 'All' },
    { label: 'Area', render: (u) => u.areaCode ?? '—' },
    {
      label: 'Status',
      render: (u) =>
        h(
          'span',
          { class: 'seg-chips' },
          h(
            'span',
            { class: `badge badge--${u.isActive ? 'success' : 'neutral'}` },
            u.isActive ? 'Active' : 'Inactive',
          ),
          u.isActive &&
            u.mustChangePassword &&
            h(
              'span',
              { class: 'badge badge--warning', title: 'Has a temporary password' },
              'Password pending',
            ),
        ),
    },
    { label: 'Last sign-in', render: (u) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never') },
    {
      label: 'Actions',
      render: (u) =>
        h(
          'div',
          { class: 'btn-group' },
          h(
            'button',
            { class: 'btn btn--ghost btn--sm', onclick: () => edit(u) },
            icon('pen'),
            'Edit',
          ),
          u.id !== me.id &&
            h(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                title: 'Reset password',
                onclick: () => resetPassword(u),
              },
              icon('key'),
              'Reset',
            ),
        ),
    },
  ];

  async function load() {
    const { data } = await api('/users', {
      query: {
        q: search.value.trim() || undefined,
        role: roleFilter.value || undefined,
        active: statusFilter.value || undefined,
      },
    });
    results.replaceChildren(table(columns, data, { emptyText: 'No users match these filters' }));
  }
  const reload = () => load().catch((e) => toast(e.message, 'error'));

  async function create() {
    const result = await formDialog({
      title: 'Add User',
      fields: userFields({ branches, areas }),
      submitLabel: 'Create user',
      onSubmit: async (values) => (await api('/users', { method: 'POST', body: values })).data,
    });
    if (!result) return;
    await reload();
    showTemporaryPassword('User created', result.user, result.temporaryPassword);
  }

  async function edit(user) {
    const isSelf = user.id === me.id;
    const result = await formDialog({
      title: `Edit User — ${user.fullName}`,
      fields: userFields({ user, branches, areas, isSelf }),
      submitLabel: 'Save changes',
      onSubmit: async (values) => {
        const body = isSelf
          ? {
              fullName: values.fullName,
              jobTitle: values.jobTitle,
              role: user.role,
              branchId: user.branchId ?? undefined,
              areaId: user.areaId ?? undefined,
              isActive: true,
            }
          : {
              fullName: values.fullName,
              jobTitle: values.jobTitle,
              role: values.role,
              branchId: values.branchId,
              areaId: values.areaId,
              isActive: values.isActive,
            };
        return (await api(`/users/${user.id}`, { method: 'PATCH', body })).data;
      },
    });
    if (!result) return;
    toast(
      result.sessionsEnded
        ? 'User updated — they were signed out so the change applies now'
        : 'User updated',
    );
    await reload();
  }

  function resetPassword(user) {
    const confirm = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary',
        onclick: async () => {
          confirm.disabled = true;
          try {
            const { data } = await api(`/users/${user.id}/reset-password`, { method: 'POST' });
            modal.close();
            await reload();
            showTemporaryPassword('Password reset', user, data.temporaryPassword);
          } catch (error) {
            toast(error.message, 'error');
            confirm.disabled = false;
          }
        },
      },
      icon('key'),
      'Reset password',
    );
    const modal = openModal({
      title: 'Reset Password',
      body: h(
        'p',
        {},
        `Create a new temporary password for `,
        h('strong', {}, user.fullName),
        '? They will be signed out everywhere and must set their own password at next sign-in.',
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

  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(reload, 200);
  });
  roleFilter.addEventListener('change', reload);
  statusFilter.addEventListener('change', reload);

  view.replaceChildren(
    h(
      'div',
      { class: 'toolbar' },
      search,
      roleFilter,
      statusFilter,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn--gold', onclick: create }, icon('user-plus'), 'Add User'),
    ),
    results,
  );
  await load();
}
