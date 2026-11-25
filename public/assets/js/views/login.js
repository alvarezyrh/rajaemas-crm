import { api, session } from '../api.js';
import { appFooter, errorAlert, h, icon, languageToggle, themeToggle } from '../dom.js';

export function renderLogin(root, { onSuccess }) {
  const errorSlot = h('div');
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn--primary btn--block' },
    icon('login'),
    'Sign in',
  );

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        errorSlot.replaceChildren();
        try {
          const { data } = await api('/auth/login', {
            method: 'POST',
            body: { email: form.elements.email.value, password: form.elements.password.value },
          });
          session.token = data.token;
          await onSuccess();
        } catch (error) {
          errorSlot.replaceChildren(errorAlert(error));
          submit.disabled = false;
        }
      },
    },
    errorSlot,
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'email' }, 'Work email'),
      h('input', {
        id: 'email',
        name: 'email',
        type: 'email',
        class: 'input',
        required: true,
        autocomplete: 'username',
      }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'password' }, 'Password'),
      h('input', {
        id: 'password',
        name: 'password',
        type: 'password',
        class: 'input',
        required: true,
        minlength: 8,
        autocomplete: 'current-password',
      }),
    ),
    submit,
  );

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
          h('div', {}, h('h1', {}, 'RajaEmas.id'), h('p', {}, 'CRM · Staff & Branch Portal')),
        ),
        form,
      ),
      appFooter(),
    ),
  );
  form.elements.email.focus();
}
