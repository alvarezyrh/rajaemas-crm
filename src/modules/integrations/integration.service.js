import { Errors } from '../../core/errors.js';
import { maskPhone } from '../../shared/phone.js';
import { assertSafeUrl, FetchError, fetchJson } from './fetcher.js';
import { extractList, mapRecord, ShapeError } from './mapping.js';

const SYNC_EVENT = 'integration.sync';
const TOKEN_CONTEXT = 'integrations.token';
const MAX_PAGES = 200;
const MAX_ERRORS_KEPT = 25;
const STALE_RUN_MINUTES = 30;

/** Partner API integrations: pull customer databases from other applications. */
export function createIntegrationService({ uow, pii, intake, bus, logger, allowPrivateHosts }) {
  const repo = uow.repos.integrations;

  async function requireSource(id) {
    const source = await repo.findById(id);
    if (!source) throw Errors.notFound('API source');
    return source;
  }

  /** Resolves the token rules for create/update into what gets stored. */
  function tokenFor(input, existing) {
    if (!input.authHeader) {
      if (input.authToken)
        throw Errors.validation([
          { field: 'authHeader', message: 'is required when a token is given' },
        ]);
      return null; // no auth (clears any stored token)
    }
    if (input.authToken) return pii.encrypt(input.authToken, TOKEN_CONTEXT);
    if (existing?.hasToken) return undefined; // keep the stored token
    throw Errors.validation([
      { field: 'authToken', message: 'is required when an auth header is set' },
    ]);
  }

  async function headersFor(source) {
    if (!source.authHeader) return {};
    const encrypted = await repo.findToken(source.id);
    return encrypted ? { [source.authHeader]: pii.decrypt(encrypted, TOKEN_CONTEXT) } : {};
  }

  function pageUrl(source, page) {
    if (source.pagination !== 'page') return source.endpointUrl;
    const url = new URL(source.endpointUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(source.pageSize));
    return url.toString();
  }

  const toRecord = (input, createdBy = null) => ({
    name: input.name,
    endpointUrl: input.endpointUrl,
    authHeader: input.authHeader ?? null,
    channel: input.channel ?? null,
    listPath: input.listPath ?? '',
    fieldMap: input.fieldMap,
    pagination: input.pagination,
    pageSize: input.pageSize,
    isActive: input.isActive,
    createdBy,
  });

  async function guardUrl(url) {
    try {
      await assertSafeUrl(url, { allowPrivateHosts });
    } catch (err) {
      if (err instanceof FetchError)
        throw Errors.validation([{ field: 'endpointUrl', message: err.message }]);
      throw err;
    }
  }

  const conflictOnName = (err) => {
    if (err.code === '23505') throw Errors.conflict('An API source with this name already exists');
    throw err;
  };

  /** The sync itself — runs off the request path (event bus). */
  async function execute({ runId, sourceId, actor }) {
    const totals = { fetched: 0, created: 0, matched: 0, enriched: 0, skipped: 0 };
    const errors = [];
    try {
      const source = await requireSource(sourceId);
      const headers = await headersFor(source);

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = await fetchJson(pageUrl(source, page), { headers, allowPrivateHosts });
        const list = extractList(payload, source.listPath);

        for (const [i, record] of list.entries()) {
          const index = totals.fetched + i;
          const mapped = mapRecord(record, source.fieldMap);
          if (!mapped.ok) {
            totals.skipped += 1;
            if (errors.length < MAX_ERRORS_KEPT) errors.push({ index, reason: mapped.reason });
            continue;
          }
          let result;
          try {
            result = await intake.upsert(mapped.value, {
              actor,
              channel: source.channel,
              source: `API: ${source.name}`,
            });
          } catch (err) {
            // One bad record must not stop the other thousands: log it, skip it, move on.
            logger.error('integration.record_failed', { err, runId, index });
            result = { status: 'skipped', reason: err.status ? err.message : 'could not be saved' };
          }
          totals[result.status] += 1;
          if (result.enriched) totals.enriched += 1;
          const problems = [
            result.reason,
            mapped.rejected.length > 0 && `ignored invalid ${mapped.rejected.join(', ')}`,
          ].filter(Boolean);
          if (problems.length && errors.length < MAX_ERRORS_KEPT) {
            errors.push({ index, reason: problems.join('; ') });
          }
        }
        totals.fetched += list.length;
        if (source.pagination !== 'page' || list.length < source.pageSize) break;
      }

      await repo.finishRun(runId, { status: 'SUCCEEDED', ...totals, errors });
    } catch (err) {
      const expected = err instanceof FetchError || err instanceof ShapeError;
      const message = expected || err.status ? err.message : 'Unexpected error during sync';
      if (!expected) logger.error('integration.sync_failed', { err, runId });
      await repo.finishRun(runId, { status: 'FAILED', ...totals, errorMessage: message, errors });
    }
    await uow.repos.audit.append({
      actor,
      action: 'INTEGRATION_SYNCED',
      entityType: 'integration_source',
      entityId: sourceId,
      diff: { runId, ...totals },
    });
  }

  bus.subscribe(SYNC_EVENT, execute);

  return Object.freeze({
    async overview() {
      await repo.failStaleRuns(STALE_RUN_MINUTES);
      const [sources, runs] = await Promise.all([repo.list(), repo.recentRuns(15)]);
      return { sources, runs };
    },

    async create(actor, input) {
      await guardUrl(input.endpointUrl);
      const authTokenEncrypted = tokenFor(input);
      return uow
        .run(async ({ integrations, audit }) => {
          const source = await integrations.insert({
            ...toRecord(input, actor.id),
            authTokenEncrypted,
          });
          await audit.append({
            actor,
            action: 'INTEGRATION_CREATED',
            entityType: 'integration_source',
            entityId: source.id,
            diff: { name: source.name, endpointUrl: source.endpointUrl },
          });
          return source;
        })
        .catch(conflictOnName);
    },

    async update(actor, id, input) {
      const existing = await requireSource(id);
      await guardUrl(input.endpointUrl);
      const authTokenEncrypted = tokenFor(input, existing);
      return uow
        .run(async ({ integrations, audit }) => {
          const source = await integrations.update(id, { ...toRecord(input), authTokenEncrypted });
          await audit.append({
            actor,
            action: 'INTEGRATION_UPDATED',
            entityType: 'integration_source',
            entityId: id,
            diff: {
              name: source.name,
              endpointUrl: source.endpointUrl,
              tokenChanged: authTokenEncrypted !== undefined,
            },
          });
          return source;
        })
        .catch(conflictOnName);
    },

    async remove(actor, id) {
      const source = await requireSource(id);
      await uow.run(async ({ integrations, audit }) => {
        await integrations.remove(id);
        await audit.append({
          actor,
          action: 'INTEGRATION_DELETED',
          entityType: 'integration_source',
          entityId: id,
          diff: { name: source.name },
        });
      });
    },

    /** Fetches the first page and shows how records would be mapped (nothing is saved). */
    async test(id) {
      const source = await requireSource(id);
      try {
        const payload = await fetchJson(pageUrl(source, 1), {
          headers: await headersFor(source),
          allowPrivateHosts,
        });
        const list = extractList(payload, source.listPath);
        const first = list[0];
        return {
          ok: true,
          fetched: list.length,
          sampleKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 30) : [],
          preview: list.slice(0, 5).map((record) => {
            const mapped = mapRecord(record, source.fieldMap);
            if (!mapped.ok) return { ok: false, reason: mapped.reason };
            // Preview shows what will be imported without exposing identity data in full.
            const { phone, kyc, ...rest } = mapped.value;
            const { nik, addressLine, ...kycClear } = kyc;
            return {
              ok: true,
              ...rest,
              phoneMasked: phone ? maskPhone(phone.slice(-4)) : null,
              kyc: {
                ...kycClear,
                ...(nik ? { nik: `••••••••••••${nik.slice(-4)}` } : {}),
                ...(addressLine ? { addressLine: 'provided' } : {}),
              },
              ignored: mapped.rejected,
            };
          }),
        };
      } catch (err) {
        if (err instanceof FetchError || err instanceof ShapeError)
          return { ok: false, error: err.message };
        throw err;
      }
    },

    async startSync(actor, id) {
      const source = await requireSource(id);
      if (!source.isActive) throw Errors.conflict('This API source is paused');
      await repo.failStaleRuns(STALE_RUN_MINUTES);
      const run = await repo.startRun(id, actor.id);
      if (!run) throw Errors.conflict('A sync for this source is already running');
      bus.publish(SYNC_EVENT, { runId: run.id, sourceId: id, actor });
      return run;
    },

    async run(runId) {
      const run = await repo.findRun(runId);
      if (!run) throw Errors.notFound('Sync run');
      return run;
    },
  });
}
