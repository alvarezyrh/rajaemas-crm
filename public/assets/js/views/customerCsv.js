/** Customers ▸ Import CSV / Export CSV. */
import { api, download, saveBlob } from '../api.js';
import { h, icon, openModal, toast } from '../dom.js';
import { number } from '../format.js';
import { t } from '../i18n.js';
import { parseCsv, TEMPLATE_CSV, toCustomerRows } from '../csv.js';

const BATCH = 500; // server limit per request
const MAX_ROWS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const SHOWN_PROBLEMS = 50;

const STATUS_TEXT = {
  ready: 'Ready',
  created: 'Imported',
  exists: 'Already exists',
  invalid: 'Invalid',
};

/** Sends rows in batches and merges the results. */
async function sendRows(rows, dryRun, onProgress) {
  const totals = { created: 0, ready: 0, exists: 0, invalid: 0 };
  const results = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data } = await api('/customers/import', {
      method: 'POST',
      body: { rows: rows.slice(i, i + BATCH), dryRun },
    });
    for (const key of Object.keys(totals)) totals[key] += data.totals[key];
    results.push(...data.results);
    onProgress?.(Math.min(i + BATCH, rows.length));
  }
  return { totals, results };
}

function totalsView(totals, dryRun) {
  const items = dryRun
    ? [
        ['ready', 'Ready to import'],
        ['exists', 'Already exist (skipped)'],
        ['invalid', 'Invalid (skipped)'],
      ]
    : [
        ['created', 'Imported'],
        ['exists', 'Already exist (skipped)'],
        ['invalid', 'Invalid (skipped)'],
      ];
  return h(
    'div',
    { class: 'import-totals' },
    items.map(([key, label]) =>
      h(
        'div',
        { class: `import-total import-total--${key}` },
        h('strong', { class: 'num' }, number(totals[key])),
        h('span', {}, label),
      ),
    ),
  );
}

function problemsView(results) {
  const problems = results.filter(
    (r) => r.status === 'invalid' || (r.status === 'exists' && r.errors),
  );
  if (problems.length === 0) return null;
  return h(
    'div',
    { class: 'import-problems' },
    h('h3', {}, `Rows that will be skipped (${number(problems.length)})`),
    h(
      'ul',
      {},
      problems
        .slice(0, SHOWN_PROBLEMS)
        .map((p) =>
          h(
            'li',
            {},
            h('strong', {}, `Row ${p.row}`),
            h(
              'span',
              { class: `badge badge--${p.status === 'invalid' ? 'danger' : 'neutral'}` },
              STATUS_TEXT[p.status],
            ),
            h('span', {}, (p.errors ?? []).join('; ')),
          ),
        ),
    ),
    problems.length > SHOWN_PROBLEMS &&
      h('p', { class: 'muted' }, `…and ${number(problems.length - SHOWN_PROBLEMS)} more.`),
  );
}

export function openImportDialog({ onImported }) {
  const fileInput = h('input', {
    type: 'file',
    accept: '.csv,text/csv',
    class: 'file-input',
    'aria-label': 'CSV file',
  });
  const templateLink = h(
    'button',
    {
      type: 'button',
      class: 'link-button',
      onclick: () =>
        saveBlob(
          new Blob([`\uFEFF${TEMPLATE_CSV}`], { type: 'text/csv' }),
          'customers-template.csv',
        ),
    },
    icon('download'),
    'Download template',
  );
  const cancel = h(
    'button',
    { type: 'button', class: 'btn btn--ghost', onclick: () => modal.close() },
    'Cancel',
  );

  const intro = h(
    'div',
    { class: 'import-intro' },
    h(
      'p',
      {},
      'Upload a CSV with a header row. ',
      h('strong', {}, 'full_name'),
      ' and ',
      h('strong', {}, 'phone'),
      ' are required; email, nik, preferred_channel, marketing_consent and home_branch_code are optional.',
    ),
    h(
      'p',
      { class: 'muted' },
      'Customers whose phone number is already registered are skipped, never overwritten. Nothing is saved until you confirm.',
    ),
    fileInput,
    templateLink,
  );
  const modal = openModal({
    title: 'Import Customers from CSV',
    body: intro,
    actions: [cancel],
    wide: true,
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_BYTES) return toast('The file is larger than 5 MB', 'error');

    const { rows, missing, mapped, ignored } = toCustomerRows(parseCsv(await file.text()));
    if (missing.length) {
      return toast(
        `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.map((m) => (m === 'fullName' ? 'full_name' : m)).join(', ')}`,
        'error',
      );
    }
    if (rows.length === 0) return toast('The file has no data rows', 'error');
    if (rows.length > MAX_ROWS)
      return toast(`Import up to ${number(MAX_ROWS)} rows at a time`, 'error');

    const progress = h('p', { class: 'muted' }, `Checking ${number(rows.length)} rows…`);
    modal.setBody(progress);
    modal.setActions(cancel);
    let check;
    try {
      check = await sendRows(
        rows,
        true,
        (done) => (progress.textContent = t(`Checking… ${number(done)} / ${number(rows.length)}`)),
      );
    } catch (error) {
      modal.setBody(intro);
      return toast(error.message, 'error');
    }

    const confirm = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--primary',
        disabled: check.totals.ready === 0,
        onclick: async () => {
          const status = h('p', { class: 'muted' }, 'Importing…');
          modal.setBody(status);
          modal.setActions();
          try {
            const ready = new Set(
              check.results.filter((r) => r.status === 'ready').map((r) => r.row),
            );
            const done = await sendRows(
              rows.filter((r) => ready.has(r.row)),
              false,
              (n) => (status.textContent = t(`Importing… ${number(n)} / ${number(ready.size)}`)),
            );
            modal.setBody(totalsView(done.totals, false), problemsView(done.results));
            onImported?.(done.totals.created);
          } catch (error) {
            modal.setBody(h('p', {}, error.message));
          }
          modal.setActions(
            h(
              'button',
              { type: 'button', class: 'btn btn--primary', onclick: () => modal.close() },
              'Done',
            ),
          );
        },
      },
      icon('upload'),
      check.totals.ready === 0
        ? 'Nothing to import'
        : `Import ${number(check.totals.ready)} customers`,
    );

    modal.setBody(
      h(
        'p',
        {},
        h('strong', {}, file.name),
        ` · ${number(rows.length)} rows · columns used: ${Object.values(mapped).join(', ')}`,
      ),
      ignored.length > 0 && h('p', { class: 'muted' }, `Ignored columns: ${ignored.join(', ')}`),
      totalsView(check.totals, true),
      problemsView(check.results),
    );
    modal.setActions(cancel, confirm);
  });
}

/** Exports with the list's current search and cluster filter. */
export async function exportCustomers(button, query) {
  button.disabled = true;
  try {
    await download('/customers/export', { query });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}
