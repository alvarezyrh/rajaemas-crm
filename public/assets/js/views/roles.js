/**
 * Roles — read-only view of the authorisation matrix.
 *
 * The matrix lives in `src/security/rbac.js`; this screen only renders what the
 * server reports, so it can never drift from what is actually enforced.
 */
import { api } from '../api.js';
import { h, icon, toast } from '../dom.js';
import { LABELS } from '../format.js';

/** How far each role can see; the rows themselves are limited by data scope. */
const SCOPE = {
  SUPER_ADMIN: 'Every outlet, every setting',
  HQ_STAFF: 'Every outlet',
  AREA_MANAGER: 'Every outlet in one area',
  BRANCH_HEAD: 'One outlet',
  CUSTOMER_SERVICE: 'One outlet (optional)',
  DIGITAL_MARKETING: 'Every outlet, no identity data',
  APPRAISER: 'One outlet',
};

const GROUPS = [
  [
    'Dashboard & customers',
    [
      'dashboard:read',
      'customer:read',
      'customer:write',
      'customer:pii:reveal',
      'interaction:write',
      'segment:read',
    ],
  ],
  [
    'Appointments, appraisals & transactions',
    [
      'appointment:read',
      'appointment:write',
      'appraisal:read',
      'appraisal:write',
      'appraisal:approve',
      'transaction:write',
    ],
  ],
  [
    'Master data & access control',
    [
      'masterdata:read',
      'masterdata:manage',
      'outlet:manage',
      'staffing:manage',
      'role:read',
      'user:manage',
      'integration:manage',
      'settings:manage',
    ],
  ],
  [
    'Leads & acquisition budget',
    ['lead:read', 'lead:write', 'lead:convert', 'budget:read', 'budget:manage'],
  ],
  ['Marketing & reputation', ['blast:read', 'blast:manage', 'review:read', 'review:manage']],
  ['Reporting', ['report:executive', 'report:outlet_rating', 'lmrei:read', 'live_omset:read']],
];

const mark = (allowed) =>
  allowed
    ? h('span', { class: 'badge badge--success', title: 'Allowed' }, icon('check'))
    : h('span', { class: 'muted', title: 'Not allowed' }, '—');

export async function renderRoles(view, { user }) {
  const { data } = await api('/roles').catch((error) => {
    toast(error.message, 'error');
    return { data: [] };
  });

  const byRole = Object.fromEntries(data.map((r) => [r.role, new Set(r.permissions)]));
  const roles = data.map((r) => r.role);

  const head = h(
    'tr',
    {},
    h('th', {}, 'Permission'),
    ...roles.map((role) =>
      h(
        'th',
        { class: 'center' },
        h('strong', {}, LABELS.role[role] ?? role),
        role === user.role && h('div', { class: 'muted' }, '(you)'),
        h('div', { class: 'muted' }, SCOPE[role] ?? ''),
      ),
    ),
  );

  const rows = GROUPS.flatMap(([group, permissions]) => [
    h('tr', {}, h('th', { class: 'table__group', colspan: roles.length + 1 }, group)),
    ...permissions.map((permission) =>
      h(
        'tr',
        {},
        h('td', {}, h('code', {}, permission)),
        ...roles.map((role) => h('td', { class: 'center' }, mark(byRole[role]?.has(permission)))),
      ),
    ),
  ]);

  view.replaceChildren(
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__head' },
        h('h2', {}, icon('lock'), 'Role Permissions'),
        h(
          'span',
          { class: 'muted' },
          'A permission opens the menu; the data a user actually sees is limited by their outlet or area.',
        ),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h('table', { class: 'table table--matrix' }, h('thead', {}, head), h('tbody', {}, rows)),
      ),
    ),
  );
}
