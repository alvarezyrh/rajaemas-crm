/** Settings (own account) + the forced "set a new password" screen. */
import { api, session } from '../api.js';
import {
  appFooter,
  currentTheme,
  errorAlert,
  h,
  icon,
  languageToggle,
  setTheme,
  themeToggle,
  toast,
} from '../dom.js';
import { currentLang, LANGUAGES, setLang } from '../i18n.js';
import { dateTime, LABELS } from '../format.js';

const PASSWORD_HINT =
  'At least 10 characters with letters and numbers. It must not contain your name or email.';

/** Current / new / confirm password form. Calls onChanged(newToken) on success. */
function passwordForm({ submitLabel, onChanged }) {
  const errorSlot = h('div');
  const field = (name, label, autocomplete) =>
    h(
      'div',
      { class: 'field' },
      h('label', { for: `pw-${name}` }, label),
      h('input', {
        id: `pw-${name}`,
        name,
        type: 'password',
        class: 'input',
        required: true,
        autocomplete,
        maxlength: 200,
      }),
    );
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn--primary' },
    icon('key'),
    submitLabel,
  );

  const form = h(
    'form',
    {
      class: 'settings-form',
      onsubmit: async (event) => {
        event.preventDefault();
        errorSlot.replaceChildren();
        const { currentPassword, newPassword, confirmPassword } = Object.fromEntries(
          new FormData(form),
        );
        if (newPassword !== confirmPassword) {
          errorSlot.replaceChildren(errorAlert({ message: 'The new passwords do not match.' }));
          return;
        }
        submit.disabled = true;
        try {
          const { data } = await api('/account/password', {
            method: 'POST',
            body: { currentPassword, newPassword },
          });
          session.token = data.token; // the old token was revoked with every other session
          form.reset();
          await onChanged();
        } catch (error) {
          errorSlot.replaceChildren(errorAlert(error));
        } finally {
          submit.disabled = false;
        }
      },
    },
    errorSlot,
    field('currentPassword', 'Current password', 'current-password'),
    field('newPassword', 'New password', 'new-password'),
    field('confirmPassword', 'Confirm new password', 'new-password'),
    h('p', { class: 'field-hint' }, PASSWORD_HINT),
    submit,
  );
  return form;
}

/** Full-screen step shown after signing in with a temporary password. */
export function renderPasswordSetup(root, { user, onDone, onSignOut }) {
  root.replaceChildren(
    h(
      'div',
      { class: 'login' },
      h('div', { class: 'login__corner' }, languageToggle(), themeToggle()),
      h(
        'div',
        { class: 'login__card' },
        h(
          'div',
          { class: 'login__brand' },
          h('img', { src: '/assets/logo.png?v=2', alt: '', width: 215, height: 272 }),
          h('div', {}, h('h1', {}, 'Set a new password'), h('p', {}, `Welcome, ${user.fullName}`)),
        ),
        h(
          'p',
          { class: 'muted setup-note' },
          'You signed in with a temporary password. Choose your own password to continue.',
        ),
        passwordForm({
          submitLabel: 'Save password & continue',
          onChanged: async () => {
            toast('Password saved');
            await onDone();
          },
        }),
        h(
          'button',
          { type: 'button', class: 'link-button setup-signout', onclick: onSignOut },
          icon('logout'),
          'Sign out',
        ),
      ),
      appFooter(),
    ),
  );
}

export async function renderSettings(view) {
  const { data: account } = await api('/account');

  /* Profile */
  const nameInput = h('input', {
    id: 'set-name',
    name: 'fullName',
    class: 'input',
    required: true,
    minlength: 2,
    maxlength: 120,
    value: account.fullName,
    autocomplete: 'name',
  });
  const saveName = h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save');
  const profileForm = h(
    'form',
    {
      class: 'settings-form',
      onsubmit: async (event) => {
        event.preventDefault();
        saveName.disabled = true;
        try {
          const { data } = await api('/account', {
            method: 'PATCH',
            body: { fullName: nameInput.value },
          });
          window.dispatchEvent(new CustomEvent('account:updated', { detail: data }));
          toast('Profile updated');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          saveName.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'set-name' }, 'Full name'), nameInput),
    saveName,
  );
  const facts = [
    ['Email', account.email],
    ['Role', LABELS.role[account.role] ?? account.role],
    [
      'Branch',
      account.branchCode
        ? `${account.branchCode} — ${account.branchName}`
        : 'All branches (head office)',
    ],
    ['Last sign-in', account.lastLoginAt ? dateTime(account.lastLoginAt) : '—'],
    ['Password changed', account.passwordChangedAt ? dateTime(account.passwordChangedAt) : 'Never'],
  ];

  /* Appearance */
  const themeChoice = (value, label, hint) =>
    h(
      'label',
      { class: 'choice' },
      h('input', {
        type: 'radio',
        name: 'theme',
        value,
        checked: currentTheme() === value,
        onchange: () => setTheme(value),
      }),
      h('span', {}, h('strong', {}, label), h('small', { class: 'muted' }, hint)),
    );
  const themeGroup = h(
    'div',
    { class: 'choices', role: 'radiogroup', 'aria-label': 'Theme' },
    themeChoice('light', 'Light', 'White, the default'),
    themeChoice('dark', 'Dark', 'Easier on the eyes at night'),
  );
  const syncTheme = () => {
    if (!themeGroup.isConnected) return window.removeEventListener('theme:change', syncTheme); // left the page
    for (const input of themeGroup.querySelectorAll('input'))
      input.checked = input.value === currentTheme();
  };
  window.addEventListener('theme:change', syncTheme);

  // Language names are shown in their own language, so they are never translated.
  const languageGroup = h(
    'div',
    { class: 'choices', role: 'radiogroup', 'aria-label': 'Language' },
    Object.entries(LANGUAGES).map(([code, name]) => {
      const label = h('strong', { lang: code });
      label.textContent = name;
      return h(
        'label',
        { class: 'choice' },
        h('input', {
          type: 'radio',
          name: 'language',
          value: code,
          checked: currentLang() === code,
          onchange: () => setLang(code),
        }),
        h('span', {}, label),
      );
    }),
  );

  /* Sessions */
  const signOutOthers = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost',
      onclick: async () => {
        signOutOthers.disabled = true;
        try {
          const { data } = await api('/account/sessions/revoke-others', { method: 'POST' });
          session.token = data.token;
          toast('Signed out of all other devices');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          signOutOthers.disabled = false;
        }
      },
    },
    icon('logout'),
    'Sign out of other devices',
  );

  const card = (iconName, title, ...body) =>
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card__header' }, h('h2', {}, icon(iconName), title)),
      h('div', { class: 'card__body' }, ...body),
    );

  view.replaceChildren(
    h(
      'div',
      { class: 'settings' },
      card(
        'id',
        'Profile',
        h(
          'dl',
          { class: 'meta meta--stack' },
          facts.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))),
        ),
        profileForm,
      ),
      card(
        'lock',
        'Password',
        h('p', { class: 'muted' }, 'Changing your password signs you out of every other device.'),
        passwordForm({
          submitLabel: 'Change password',
          onChanged: async () => toast('Password changed — other devices were signed out'),
        }),
      ),
      card(
        'palette',
        'Appearance',
        h('h3', { class: 'settings-subhead' }, 'Theme'),
        themeGroup,
        h('h3', { class: 'settings-subhead' }, 'Language'),
        languageGroup,
      ),
      card(
        'devices',
        'Sessions',
        h(
          'p',
          { class: 'muted' },
          'Lost a device or signed in on a shared computer? End every other session; this one stays signed in.',
        ),
        signOutOthers,
      ),
    ),
  );
}
