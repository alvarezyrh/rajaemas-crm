import { Errors } from '../../core/errors.js';
import { mapRecord } from './mapping.js';
import { maskPhone } from '../../shared/phone.js';
import { assertSafeUrl, FetchError, fetchJson } from './fetcher.js';
import { ShapeError } from './mapping.js';
import {
  INTEGRATION_TARGETS,
  REQUIRED_TARGET_FIELDS,
  createIntegrationTargets,
} from './targets.js';

const SYNC_EVENT = 'integration.sync';
const TOKEN_CONTEXT = 'integrations.token';
const MAX_PAGES = 200;
const MAX_ERRORS_KEPT = 25;
const STALE_RUN_MINUTES = 30;

/** Pull configured datasets from partner APIs into CRM modules or encrypted custom storage. */
export function createIntegrationService({
  uow,
  pii,
  blindIndex,
  intake,
  leads,
  appointments,
  transactions,
  masterdata,
  bus,
  logger,
  allowPrivateHosts,
}) {
  const repo = uow.repos.integrations;
  const targets = createIntegrationTargets({
    uow,
    pii,
    blindIndex,
    intake,
    leads,
    appointments,
    transactions,
    masterdata,
  });

  function validateTarget(source) {
    if (!INTEGRATION_TARGETS.includes(source.targetType))
      throw Errors.validation([{ field: 'targetType', message: 'is not supported' }]);
    const required = [...REQUIRED_TARGET_FIELDS[source.targetType]];
    const fieldMap = source.fieldMap ?? {};
    const issues = [];
    const accountIdField =
      source.targetType === 'CUSTOMER' ? fieldMap.accountId : fieldMap.customerAccountId;
    if (['APPOINTMENT', 'TRANSACTION'].includes(source.targetType)) {
      if (!fieldMap.customerAccountId && !fieldMap.customerPhone)
        issues.push({
          field: 'customerAccountId|customerPhone',
          message: 'a customer account ID or phone mapping is required',
        });
    }
    if (accountIdField && !source.channel)
      issues.push({
        field: 'channel',
        message: 'is required with a customer account ID mapping',
      });
    if (source.targetType === 'TRANSACTION')
      required.push('itemDescription', 'itemWeightGram', 'itemUnitPrice');
    issues.push(
      ...required
        .filter((key) => !fieldMap[key])
        .map((field) => ({ field, message: 'a source field mapping is required' })),
    );
    if (issues.length) throw Errors.validation(issues);
    if (source.targetType === 'DATASET') {
      if (!source.datasetName || source.datasetName.trim().length < 2)
        throw Errors.validation([
          { field: 'datasetName', message: 'must be at least 2 characters' },
        ]);
      if (source.datasetName.length > 80)
        throw Errors.validation([
          { field: 'datasetName', message: 'must be at most 80 characters' },
        ]);
    } else if (source.datasetName) {
      throw Errors.validation([
        { field: 'datasetName', message: 'is only available for custom datasets' },
      ]);
    }
  }

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
    targetType: input.targetType ?? 'CUSTOMER',
    datasetName: input.datasetName ?? null,
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
      const context = await targets.prepare(source);

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = await fetchJson(pageUrl(source, page), { headers, allowPrivateHosts });
        const list = targets.recordList(payload, source.listPath);

        for (const [i, record] of list.entries()) {
          const index = totals.fetched + i;
          let result;
          try {
            result = await targets.importRecord(source, record, actor, context);
          } catch (err) {
            // One bad record must not stop the other thousands: log it, skip it, move on.
            logger.error('integration.record_failed', { err, runId, index });
            result = { status: 'skipped', reason: err.status ? err.message : 'could not be saved' };
          }
          totals[result.status] += 1;
          if (result.enriched) totals.enriched += 1;
          if (result.reason && errors.length < MAX_ERRORS_KEPT) {
            errors.push({ index, reason: result.reason });
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
      const source = toRecord(input, actor.id);
      validateTarget(source);
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
      const source = toRecord(input);
      validateTarget(source);
      if (source.targetType !== existing.targetType)
        throw Errors.validation([
          { field: 'targetType', message: 'cannot be changed; create a new source instead' },
        ]);
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
        const list = targets.recordList(payload, source.listPath);
        const first = list[0];
        if (source.targetType !== 'CUSTOMER') {
          return {
            ok: true,
            targetType: source.targetType,
            fetched: list.length,
            sampleKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 30) : [],
            preview: [],
          };
        }
        return {
          ok: true,
          targetType: source.targetType,
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

    async datasetRecords(actor, id, { page, pageSize }) {
      const source = await requireSource(id);
      if (source.targetType !== 'DATASET')
        throw Errors.badRequest('This API source does not store a custom dataset');
      const rows = await repo.listDatasetRecords(source.id, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      await uow.repos.audit.append({
        actor,
        action: 'INTEGRATION_DATASET_READ',
        entityType: 'integration_source',
        entityId: source.id,
        diff: { page, pageSize, count: rows.length },
      });
      return {
        items: rows.map((row) => ({
          id: row.record_id,
          data: JSON.parse(pii.decrypt(row.payload_encrypted, `integrations.dataset:${source.id}`)),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        total: source.recordCount,
      };
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
