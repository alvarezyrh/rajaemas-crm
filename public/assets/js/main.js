import { api, session } from './api.js';
import { appFooter, h, icon, languageToggle, themeToggle, toast } from './dom.js';
import { t } from './i18n.js';
import { renderAdvertising } from './views/advertising.js';
import { renderAppointments } from './views/appointments.js';
import { renderAppraisals } from './views/appraisals.js';
import { renderCustomerDetail } from './views/customerDetail.js';
import { renderCustomers } from './views/customers.js';
import { renderLeads } from './views/leads.js';
import { renderLogin } from './views/login.js';
import { renderLiveOmset } from './views/liveOmset.js';
import { renderMarketing } from './views/marketing.js';
import { renderIntegrations } from './views/integrations.js';
import { renderMasterData } from './views/masterData.js';
import { renderOverview } from './views/overview.js';
import { renderOperations } from './views/operations.js';
import { renderPasswordSetup, renderSettings } from './views/settings.js';
import { renderRoles } from './views/roles.js';
import { renderReports } from './views/reports.js';
import { renderUsers } from './views/users.js';
import { LABELS } from './format.js';

/** Admin tools pinned to the bottom of the sidebar, just above the signed-in user. */
const ADMIN_NAV = [
  {
    key: 'masterData',
    href: '#/master-data',
    label: 'Master Data',
    icon: 'layers',
    permission: 'masterdata:read',
  },
  {
    key: 'roles',
    href: '#/roles',
    label: 'Roles',
    icon: 'lock',
    permission: 'role:read',
  },
  {
    key: 'users',
    href: '#/users',
    label: 'Users',
    icon: 'user-gear',
    permission: 'user:manage',
  },
  {
    key: 'integrations',
    href: '#/integrations',
    label: 'API Gateway',
    icon: 'plug',
    permission: 'integration:manage',
  },
];

const NAV = [
  {
    key: 'overview',
    href: '#/',
    label: 'Overview',
    icon: 'home',
    permission: 'dashboard:read',
  },
  {
    key: 'customers',
    href: '#/customers',
    label: 'Customers',
    icon: 'users',
    group: 'customers',
    permission: 'customer:read',
  },
  {
    key: 'leads',
    href: '#/leads',
    label: 'Leads',
    icon: 'handshake',
    group: 'customers',
    permission: 'lead:read',
  },
  {
    key: 'advertising',
    href: '#/advertising',
    label: 'Advertising',
    icon: 'sack',
    group: 'insights',
    permission: 'budget:read',
  },
  {
    key: 'operations',
    href: '#/operations',
    label: 'Transactions & QMS',
    icon: 'coins',
    group: 'operations',
    permission: 'transaction:read',
  },
  {
    key: 'appointments',
    href: '#/appointments',
    label: 'Appointments',
    icon: 'calendar',
    group: 'customers',
    permission: 'appointment:read',
  },
  {
    key: 'appraisals',
    href: '#/appraisals',
    label: 'Appraisals & Buyback',
    icon: 'scale',
    group: 'operations',
    permission: 'appraisal:read',
  },
  {
    key: 'reports',
    href: '#/reports',
    label: 'Reports',
    icon: 'chart',
    group: 'insights',
    permission: 'lmrei:read',
  },
  {
    key: 'liveOmset',
    href: '#/live-omset',
    label: 'Live Omset',
    icon: 'chart',
    group: 'operations',
    permission: 'live_omset:read',
  },
  {
    key: 'marketing',
    href: '#/marketing',
    label: 'Reviews & Blast',
    icon: 'comments',
    group: 'insights',
    permission: 'review:read',
  },
];

const NAV_GROUPS = [
  { id: 'customers', label: 'Customer Management', icon: 'users' },
  { id: 'operations', label: 'Sales & Operations', icon: 'coins' },
  { id: 'insights', label: 'Analytics & Marketing', icon: 'chart' },
];

const ROUTES = [
  {
    pattern: /^#?\/?$/,
    nav: 'overview',
    title: 'Overview',
    view: renderOverview,
  },
  // Customers and customer clusters share one page; ?seg= preselects a cluster filter.
  {
    pattern: /^#\/customers(?:\?seg=([A-Z_]+))?$/,
    nav: 'customers',
    title: 'Customers',
    view: renderCustomers,
  },
  {
    pattern: /^#\/customers\/([0-9a-f-]{36})$/,
    nav: 'customers',
    title: 'Customer Profile',
    view: renderCustomerDetail,
  },
  {
    pattern: /^#\/leads$/,
    nav: 'leads',
    title: 'Leads & Lead Summary',
    view: renderLeads,
  },
  {
    pattern: /^#\/advertising$/,
    nav: 'advertising',
    title: 'Advertising Budgets & Summary',
    view: renderAdvertising,
  },
  {
    pattern: /^#\/operations$/,
    nav: 'operations',
    title: 'Transactions & QMS',
    view: renderOperations,
  },
  {
    pattern: /^#\/appointments$/,
    nav: 'appointments',
    title: 'Branch Appointments',
    view: renderAppointments,
  },
  {
    pattern: /^#\/settings$/,
    nav: 'settings',
    title: 'Settings',
    view: renderSettings,
  },
  {
    pattern: /^#\/master-data$/,
    nav: 'masterData',
    title: 'Master Data',
    view: renderMasterData,
  },
  {
    pattern: /^#\/roles$/,
    nav: 'roles',
    title: 'Roles & Permissions',
    view: renderRoles,
  },
  { pattern: /^#\/users$/, nav: 'users', title: 'Users', view: renderUsers },
  {
    pattern: /^#\/integrations$/,
    nav: 'integrations',
    title: 'API Gateway',
    view: renderIntegrations,
  },
  {
    pattern: /^#\/appraisals$/,
    nav: 'appraisals',
    title: 'Appraisals & Buyback',
    view: renderAppraisals,
  },
  {
    pattern: /^#\/reports$/,
    nav: 'reports',
    title: 'Reports',
    view: renderReports,
  },
  {
    pattern: /^#\/live-omset$/,
    nav: 'liveOmset',
    title: 'Live Omset',
    view: renderLiveOmset,
  },
  {
    pattern: /^#\/marketing$/,
    nav: 'marketing',
    title: 'Reviews & WhatsApp Blast',
    view: renderMarketing,
  },
];

const appRoot = document.getElementById('app');
const state = { user: null, branches: [], shell: null, viewCleanup: null };

export const can = (permission) => state.user?.permissions.includes(permission) ?? false;

function cleanupView() {
  state.viewCleanup?.();
  state.viewCleanup = null;
}

function buildShell() {
  const link = (item) =>
    h('a', { href: item.href, dataset: { nav: item.key } }, icon(item.icon), item.label);
  const permittedMain = NAV.filter((item) => can(item.permission));
  const groupedMainLinks = new Map(NAV_GROUPS.map(({ id }) => [id, []]));
  const standaloneMainLinks = [];
  for (const item of permittedMain) {
    const navLink = link(item);
    if (item.group) groupedMainLinks.get(item.group)?.push(navLink);
    else standaloneMainLinks.push(navLink);
  }
  const mainLinks = [
    ...standaloneMainLinks,
    ...NAV_GROUPS.flatMap(({ id }) => groupedMainLinks.get(id)),
  ];
  const adminLinks = ADMIN_NAV.filter((item) => can(item.permission)).map(link);
  const navLinks = [...mainLinks, ...adminLinks];
  const groupedMenu = (id, label, iconName, items, className = '') => {
    if (items.length === 0) return null;
    return h(
      'details',
      { class: `nav-group ${className}`.trim(), dataset: { group: id } },
      h('summary', { class: 'nav-group__trigger' }, icon(iconName), h('span', {}, label)),
      h('div', { class: 'nav-group__items' }, items),
    );
  };
  const mainNavigation = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main navigation' },
    ...standaloneMainLinks,
    ...NAV_GROUPS.map(({ id, label, icon: iconName }) =>
      groupedMenu(id, label, iconName, groupedMainLinks.get(id)),
    ),
  );
  const title = h('h1');
  const view = h('section', { class: 'content', id: 'view' });
  const logout = h(
    'button',
    { class: 'btn btn--ghost btn--sm', type: 'button', onclick: signOut },
    icon('logout'),
    'Sign out',
  );

  const shell = h(
    'div',
    { class: 'shell' },
    h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'sidebar__brand' },
        h('img', {
          src: '/assets/logo.png?v=2',
          alt: '',
          width: 215,
          height: 272,
        }),
        h('div', {}, h('strong', {}, 'RajaEmas.id'), h('span', {}, 'Internal CRM')),
      ),
      mainNavigation,
      adminLinks.length > 0 &&
        h(
          'nav',
          { class: 'nav nav--admin', 'aria-label': 'Administration' },
          groupedMenu('admin', 'Administration', 'settings', adminLinks),
        ),
      h(
        'a',
        {
          class: 'sidebar__user',
          href: '#/settings',
          dataset: { nav: 'settings' },
          title: 'Account settings',
        },
        h(
          'span',
          { class: 'sidebar__user-text' },
          h('strong', { class: 'sidebar__user-name' }, state.user.fullName),
          h('span', {}, LABELS.role[state.user.role] ?? state.user.role),
        ),
        icon('settings'),
      ),
    ),
    h(
      'div',
      { class: 'main' },
      h(
        'header',
        { class: 'topbar' },
        title,
        h(
          'div',
          { class: 'topbar__actions' },
          h(
            'span',
            { class: 'chip' },
            state.user.branchCode ? `Branch ${state.user.branchCode}` : 'Head office access',
          ),
          languageToggle(),
          themeToggle(),
          logout,
        ),
      ),
      h('main', {}, view),
      appFooter(),
    ),
  );
  return { root: shell, title, view, navLinks };
}

async function route() {
  if (!state.shell) return;
  cleanupView();
  // Old bookmarks of the former "Customer Clusters" page land on Customers.
  const legacy = location.hash.match(/^#\/segments(?:\?seg=([A-Z_]+))?$/);
  if (legacy) {
    location.replace(legacy[1] ? `#/customers?seg=${legacy[1]}` : '#/customers');
    return;
  }
  const hash = location.hash || '#/';
  const match = ROUTES.map((r) => ({
    route: r,
    m: hash.match(r.pattern),
  })).find((x) => x.m);
  if (!match) {
    location.hash = '#/';
    return;
  }

  const { route: current, m } = match;
  const { title, view, navLinks } = state.shell;
  title.textContent = t(current.title);
  document.title = `${t(current.title)} · CRM RajaEmas.id`;
  const activeLink = navLinks.find((link) => link.dataset.nav === current.nav);
  for (const group of state.shell.root.querySelectorAll('.nav-group')) {
    group.open = group === activeLink?.closest('.nav-group');
  }
  for (const link of navLinks) {
    if (link.dataset.nav === current.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  view.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  try {
    const cleanup = await current.view(view, {
      user: state.user,
      branches: state.branches,
      params: m.slice(1),
      can,
    });
    if (typeof cleanup === 'function') state.viewCleanup = cleanup;
  } catch (error) {
    view.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'empty' }, error.message)));
  }
}

async function startSession() {
  cleanupView();
  const { data: user } = await api('/auth/me');
  // A temporary password (new account or admin reset) must be replaced first;
  // the server refuses every other endpoint until then.
  if (user.mustChangePassword) {
    state.shell = null;
    appRoot.className = '';
    renderPasswordSetup(appRoot, {
      user,
      onDone: startSession,
      onSignOut: signOut,
    });
    return;
  }
  const { data: branches } = await api('/branches');
  state.user = user;
  state.branches = branches;
  state.shell = buildShell();
  appRoot.className = '';
  appRoot.replaceChildren(state.shell.root);
  await route();
}

function showLogin() {
  cleanupView();
  state.user = null;
  state.shell = null;
  appRoot.className = '';
  renderLogin(appRoot, { onSuccess: startSession });
}

async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* the session may already have ended */
  }
  session.token = null;
  showLogin();
}

window.addEventListener('hashchange', route);
/** Language switch: redraw the current screen in place (session and URL are kept). */
window.addEventListener('lang:change', () => {
  if (session.token) startSession().catch(showLogin);
  else showLogin();
});
window.addEventListener('auth:password-change', () => startSession().catch(showLogin));
/** Settings → name change: refresh the sidebar card without a reload. */
window.addEventListener('account:updated', (event) => {
  if (!state.user) return;
  state.user.fullName = event.detail.fullName;
  const name = document.querySelector('.sidebar__user-name');
  if (name) name.textContent = event.detail.fullName;
});
window.addEventListener('auth:expired', () => {
  toast('Your session has ended. Please sign in again.', 'error');
  showLogin();
});

if (session.token) startSession().catch(showLogin);
else showLogin();
