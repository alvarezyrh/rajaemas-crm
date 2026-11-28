/**
 * DOM utilities. All dynamic content is built with createElement/textContent
 * (never innerHTML), so it is safe from XSS.
 */
import { currentLang, LANGUAGES, setLang, t } from './i18n.js';

/** Attributes people read (or hear) — translated like text. */
const READABLE_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt']);

/**
 * Creates an element. String children and readable attributes are translated
 * (i18n.js), so every view is bilingual without wrapping its strings.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    // Styles go through CSSOM: the CSP (style-src 'self') blocks style="" attributes.
    else if (key === 'style')
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, READABLE_ATTRS.has(key) ? t(String(value)) : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(t(String(child))));
  }
  return el;
}

/** Ikon Font Awesome (paket lokal). Nama aplikasi → kelas FA. */
const ICONS = {
  home: 'fa-solid fa-house',
  users: 'fa-solid fa-users',
  calendar: 'fa-regular fa-calendar',
  scale: 'fa-solid fa-scale-balanced',
  logout: 'fa-solid fa-right-from-bracket',
  plus: 'fa-solid fa-plus',
  prev: 'fa-solid fa-chevron-left',
  next: 'fa-solid fa-chevron-right',
  back: 'fa-solid fa-arrow-left',
  forward: 'fa-solid fa-arrow-right',
  eye: 'fa-regular fa-eye',
  'calendar-plus': 'fa-solid fa-calendar-plus',
  'calendar-day': 'fa-solid fa-calendar-day',
  comments: 'fa-regular fa-comments',
  check: 'fa-solid fa-check',
  xmark: 'fa-solid fa-xmark',
  ban: 'fa-solid fa-ban',
  'user-check': 'fa-solid fa-user-check',
  'circle-check': 'fa-solid fa-circle-check',
  handshake: 'fa-regular fa-handshake',
  gem: 'fa-regular fa-gem',
  crown: 'fa-solid fa-crown',
  sack: 'fa-solid fa-sack-dollar',
  history: 'fa-solid fa-clock-rotate-left',
  login: 'fa-solid fa-right-to-bracket',
  theme: 'fa-solid fa-circle-half-stroke',
  store: 'fa-solid fa-store',
  app: 'fa-solid fa-mobile-screen-button',
  web: 'fa-solid fa-cart-shopping',
  segments: 'fa-solid fa-circle-nodes',
  coins: 'fa-solid fa-coins',
  layers: 'fa-solid fa-layer-group',
  filter: 'fa-solid fa-filter',
  'user-slash': 'fa-solid fa-user-slash',
  heart: 'fa-solid fa-heart',
  plug: 'fa-solid fa-plug',
  sync: 'fa-solid fa-arrows-rotate',
  upload: 'fa-solid fa-file-arrow-up',
  download: 'fa-solid fa-file-arrow-down',
  pen: 'fa-solid fa-pen',
  trash: 'fa-regular fa-trash-can',
  settings: 'fa-solid fa-gear',
  'user-gear': 'fa-solid fa-user-gear',
  'user-plus': 'fa-solid fa-user-plus',
  key: 'fa-solid fa-key',
  copy: 'fa-regular fa-copy',
  lock: 'fa-solid fa-lock',
  devices: 'fa-solid fa-laptop',
  palette: 'fa-solid fa-palette',
  id: 'fa-regular fa-id-card',
};

export function icon(name) {
  const el = document.createElement('i');
  el.className = `icon ${ICONS[name] ?? `fa-solid fa-${name}`}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/* ---------------------------------------------------------------------- */
/* Light/dark theme. The initial theme is set by theme.js in <head>.     */
/* ---------------------------------------------------------------------- */
const THEME_KEY = 'rei.crm.theme.v2';
const THEME_COLOR = { dark: '#0a0806', light: '#ffffff' };

export const currentTheme = () =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

/** Applies and remembers a theme; every theme control listens for `theme:change`. */
export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage blocked: the theme still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent('theme:change', { detail: theme }));
}

/** Round light/dark toggle. The half-filled circle is the familiar theme symbol; the label names the target mode. */
export function themeToggle(extraClass = '') {
  const button = h('button', { type: 'button', class: `theme-toggle ${extraClass}`.trim() });
  const sync = () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    button.replaceChildren(icon('theme'));
    button.setAttribute('aria-label', t(label));
    button.title = t(label);
  };
  button.addEventListener('click', () => {
    setTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });
  window.addEventListener('theme:change', sync);
  sync();
  return button;
}

/** EN | ID pill. The screen re-renders on `lang:change` (see main.js). */
export function languageToggle(extraClass = '') {
  return h(
    'div',
    { class: `lang-toggle ${extraClass}`.trim(), role: 'group', 'aria-label': 'Switch language' },
    Object.entries(LANGUAGES).map(([code, name]) =>
      h(
        'button',
        {
          type: 'button',
          lang: code,
          title: name,
          'aria-pressed': currentLang() === code ? 'true' : 'false',
          onclick: () => setLang(code),
        },
        code.toUpperCase(),
      ),
    ),
  );
}

/** Year the app was created (fixed — not the current year). */
const CREATED_YEAR = 2026;

/** App credit line shown at the bottom of every screen. */
export function appFooter() {
  const heart = icon('heart');
  heart.classList.add('app-footer__heart');
  return h(
    'footer',
    { class: 'app-footer' },
    'IT REI-DEV - Made by ',
    heart,
    h('span', { class: 'sr-only' }, 'love'),
    ` ${CREATED_YEAR}`,
  );
}

export function toast(message, tone = 'info') {
  const el = h('div', { class: `toast${tone === 'error' ? ' toast--error' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

export function errorAlert(error) {
  const details = Array.isArray(error.details) ? error.details : [];
  return h(
    'div',
    { class: 'alert', role: 'alert' },
    error.message,
    details.length > 0 &&
      h(
        'ul',
        {},
        details.map((d) => h('li', {}, `${d.field}: ${d.message}`)),
      ),
  );
}

export function emptyState(text) {
  return h('div', { class: 'empty' }, text);
}

/** One KPI tile: label, icon and a value (`fullValue` is the tooltip). */
export function kpiCard(iconName, label, value, fullValue = value) {
  return h(
    'div',
    { class: 'card kpi' },
    h(
      'div',
      { class: 'kpi__head' },
      h('div', { class: 'kpi__label' }, label),
      h('span', { class: 'kpi__icon' }, icon(iconName)),
    ),
    h('div', { class: 'kpi__value', title: fullValue }, value),
  );
}

export function table(columns, rows, { onRowClick, emptyText = 'No data yet' } = {}) {
  if (rows.length === 0) return emptyState(emptyText);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          columns.map((c) => h('th', { class: c.align }, c.label)),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            {
              class: onRowClick ? 'is-clickable' : undefined,
              onclick: onRowClick ? () => onRowClick(row) : undefined,
            },
            columns.map((c) => h('td', { class: c.align }, c.render(row))),
          ),
        ),
      ),
    ),
  );
}

/* ---------------------------------------------------------------------- */
/* Generic form dialog                                                     */
/* field: { name, label, type, required, options:[{value,label}], min,     */
/*          max, step, value, placeholder, inputmode }                     */
/* A { type: 'section', label } entry renders a sub-heading.               */
/* ---------------------------------------------------------------------- */
function control(field) {
  const common = { id: `f-${field.name}`, name: field.name, required: field.required };
  if (field.type === 'select') {
    return h(
      'select',
      { ...common, class: 'select' },
      !field.required && h('option', { value: '' }, '—'),
      field.options.map((o) =>
        h('option', { value: o.value, selected: o.value === field.value }, o.label),
      ),
    );
  }
  if (field.type === 'textarea') {
    return h(
      'textarea',
      { ...common, class: 'input', rows: 3, maxlength: field.max },
      field.value ?? '',
    );
  }
  if (field.type === 'checkbox') {
    return h('input', { ...common, type: 'checkbox', checked: field.value === true });
  }
  return h('input', {
    ...common,
    class: 'input',
    type: field.type ?? 'text',
    min: field.min,
    max: field.max,
    step: field.step,
    value: field.value,
    placeholder: field.placeholder,
    inputmode: field.inputmode,
    autocomplete: 'off',
  });
}

function readValues(form, fields) {
  const values = {};
  for (const field of fields) {
    if (field.type === 'section') continue;
    const el = form.elements.namedItem(field.name);
    if (field.type === 'checkbox') {
      values[field.name] = el.checked;
      continue;
    }
    const raw = el.value.trim();
    if (raw === '') continue;
    if (field.type === 'number') values[field.name] = Number(raw);
    else if (field.type === 'datetime-local') values[field.name] = new Date(raw).toISOString();
    else values[field.name] = raw;
  }
  return values;
}

/** @returns {Promise<any>} the onSubmit result, or null when cancelled. */
export function formDialog({ title, fields, submitLabel = 'Save', onSubmit }) {
  return new Promise((resolve) => {
    const errorSlot = h('div');
    const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, submitLabel);
    const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'Cancel');

    const form = h(
      'form',
      {},
      h('div', { class: 'modal__header' }, h('h2', {}, title)),
      h(
        'div',
        { class: 'modal__body' },
        errorSlot,
        fields.map((field) =>
          field.type === 'section'
            ? h('h3', { class: 'modal__subhead' }, field.label)
            : h(
                'div',
                { class: `field${field.type === 'checkbox' ? ' field--check' : ''}` },
                field.type === 'checkbox' && control(field),
                h('label', { for: `f-${field.name}` }, field.label),
                field.type !== 'checkbox' && control(field),
              ),
        ),
      ),
      h('div', { class: 'modal__footer' }, cancel, submit),
    );

    const dialog = h('dialog', { class: 'modal' }, form);
    let result = null;

    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      errorSlot.replaceChildren();
      try {
        result = await onSubmit(readValues(form, fields));
        dialog.close();
      } catch (error) {
        errorSlot.replaceChildren(errorAlert(error));
      } finally {
        submit.disabled = false;
      }
    });

    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Generic modal. `body` is any node; `actions` are buttons for the footer.
 * Returns { dialog, close, setBody, setActions } so multi-step flows can
 * swap content in place.
 */
export function openModal({ title, body, actions = [], wide = false }) {
  const bodySlot = h('div', { class: 'modal__body' }, body);
  const footer = h('div', { class: 'modal__footer' }, actions);
  const dialog = h(
    'dialog',
    { class: `modal${wide ? ' modal--wide' : ''}` },
    h('div', { class: 'modal__header' }, h('h2', {}, title)),
    bodySlot,
    footer,
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return {
    dialog,
    close: () => dialog.close(),
    setBody: (...nodes) => bodySlot.replaceChildren(...nodes),
    setActions: (...buttons) => footer.replaceChildren(...buttons),
  };
}
