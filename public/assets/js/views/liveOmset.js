import { session } from '../api.js';
import { h, icon, kpiCard, table } from '../dom.js';
import { t } from '../i18n.js';
import { number, rupiah } from '../format.js';

const STREAM_URL = '/api/v1/live-omset/stream';
const MAX_RETRY_MS = 30_000;

function frameValues(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

export async function renderLiveOmset(view) {
  const status = h('span', { class: 'live-status', role: 'status' });
  const updatedAt = h('span', { class: 'live-omset__updated' });
  const kpis = h('div', { class: 'kpis' });
  const outletTable = h('div', { class: 'card live-omset__table' });
  let stopped = false;
  let activeController;

  function setStatus(label, state) {
    status.className = `live-status live-status--${state}`;
    status.replaceChildren(h('span', { class: 'live-status__dot' }), t(label));
  }

  function renderSnapshot(snapshot) {
    const totals = snapshot.totals;
    kpis.replaceChildren(
      kpiCard('coins', 'Buy value', rupiah(totals.buyAmount)),
      kpiCard('coins', 'Sell value', rupiah(totals.sellAmount)),
      kpiCard('chart', 'Transactions', number(totals.transactionCount)),
      kpiCard('scale', 'Weight', `${number(totals.weightGram)} g`),
    );
    outletTable.replaceChildren(
      table(
        [
          { label: 'Outlet', render: (branch) => `${branch.branchCode} · ${branch.branchName}` },
          { label: 'City', render: (branch) => branch.city ?? '—' },
          { label: 'Transactions', render: (branch) => number(branch.transactionCount) },
          { label: 'Buy', render: (branch) => rupiah(branch.buyAmount) },
          { label: 'Sell', render: (branch) => rupiah(branch.sellAmount) },
          { label: 'Weight', render: (branch) => `${number(branch.weightGram)} g` },
        ],
        snapshot.branches,
        { emptyText: 'No active outlets in your scope' },
      ),
    );
    updatedAt.textContent = `${t('Updated')} ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(snapshot.generatedAt))}`;
    setStatus('Live', 'connected');
  }

  view.replaceChildren(
    h(
      'div',
      { class: 'card live-omset__header' },
      h(
        'div',
        {},
        h('h2', {}, icon('chart'), 'Live Omset'),
        h('p', {}, 'Current-day transaction totals update every few seconds.'),
      ),
      h('div', { class: 'live-omset__connection' }, status, updatedAt),
    ),
    kpis,
    outletTable,
  );
  setStatus('Connecting', 'connecting');

  function stop() {
    if (stopped) return;
    stopped = true;
    activeController?.abort();
    window.removeEventListener('hashchange', onHashChange);
  }

  function onHashChange() {
    if (location.hash !== '#/live-omset') stop();
  }

  async function connect(signal) {
    const response = await fetch(STREAM_URL, {
      headers: {
        accept: 'text/event-stream',
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      },
      cache: 'no-store',
      signal,
    });

    if (response.status === 401) {
      session.token = null;
      window.dispatchEvent(new Event('auth:expired'));
      stop();
      return;
    }
    if (response.status === 403) {
      setStatus('Access denied', 'offline');
      stop();
      return;
    }
    if (!response.ok || !response.body) {
      throw new Error(`Live stream request failed (HTTP ${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const { event, data } = frameValues(frame);
        if (event === 'omset' && data) renderSnapshot(JSON.parse(data));
        if (event === 'stream-error') throw new Error(JSON.parse(data).message);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  async function run() {
    let attempt = 0;
    while (!stopped) {
      activeController = new AbortController();
      setStatus(attempt === 0 ? 'Connecting' : 'Reconnecting', 'connecting');
      try {
        await connect(activeController.signal);
        if (stopped) return;
        throw new Error('Live stream ended');
      } catch (error) {
        if (stopped) return;
        if (error.name === 'AbortError') return;
        setStatus('Reconnecting', 'offline');
        const delay = Math.min(1_000 * 2 ** attempt, MAX_RETRY_MS);
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  window.addEventListener('hashchange', onHashChange);
  run();
  return stop;
}
