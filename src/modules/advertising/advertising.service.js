import { Errors } from '../../core/errors.js';
import { dataScopeOf } from '../../shared/scope.js';

/** Rupiah has no meaningful fraction here, so ratios are rounded to whole rupiah. */
const roundIdr = (n) => (n === null || n === undefined ? null : Math.round(n));

/**
 * Advertising budgets & the Advertising Summary.
 *
 * Spend is booked per area × channel × month, while leads are counted with the
 * caller's own data scope. For an outlet-scoped caller those two sides are not
 * the same population, so cost-per-lead is only reported when they match.
 */
export function createAdvertisingService({ uow }) {
  async function requireActive(kind, repo, id, field) {
    if (!id) return;
    const row = await repo.findById(id);
    if (!row || !row.isActive)
      throw Errors.validation([{ field, message: `is not an active ${kind}` }]);
  }

  return Object.freeze({
    list(actor, query) {
      return uow.repos.advertising.list({ scope: dataScopeOf(actor), ...query });
    },

    async create(actor, input) {
      await requireActive('area', uow.repos.areas, input.areaId, 'areaId');
      await requireActive('channel', uow.repos.references, input.referenceId, 'referenceId');
      try {
        return await uow.run(async ({ advertising, audit }) => {
          const id = await advertising.insert({ ...input, createdBy: actor.id });
          await audit.append({
            actor,
            action: 'BUDGET_CREATED',
            entityType: 'advertising_budget',
            entityId: id,
            diff: { after: input },
          });
          return advertising.findById(id, dataScopeOf(actor));
        });
      } catch (err) {
        if (err.code === '23505')
          throw Errors.conflict('That area already has a budget for this channel and month');
        throw err;
      }
    },

    async update(actor, id, input) {
      const scope = dataScopeOf(actor);
      const before = await uow.repos.advertising.findById(id, scope);
      if (!before) throw Errors.notFound('Advertising budget');
      await requireActive('area', uow.repos.areas, input.areaId, 'areaId');
      await requireActive('channel', uow.repos.references, input.referenceId, 'referenceId');

      const fields = {};
      for (const key of ['areaId', 'referenceId', 'periodMonth', 'spendAmount', 'notes'])
        if (input[key] !== undefined) fields[key] = input[key];

      try {
        return await uow.run(async ({ advertising, audit }) => {
          const changed = await advertising.update(id, fields);
          if (!changed) throw Errors.notFound('Advertising budget');
          const after = await advertising.findById(id, scope);
          await audit.append({
            actor,
            action: 'BUDGET_UPDATED',
            entityType: 'advertising_budget',
            entityId: id,
            diff: {
              fields: Object.keys(fields),
              before: Object.fromEntries(Object.keys(fields).map((k) => [k, before[k]])),
              after: Object.fromEntries(Object.keys(fields).map((k) => [k, after[k]])),
            },
          });
          return after;
        });
      } catch (err) {
        if (err.code === '23505')
          throw Errors.conflict('That area already has a budget for this channel and month');
        throw err;
      }
    },

    /**
     * Advertising Summary: spend next to the leads and conversions of the same
     * period, grouped by area or by acquisition channel.
     *
     * Attribution is deliberately simple — same period, same area/channel — and
     * makes no claim about lag between spend and a lead arriving.
     */
    async summary(actor, { from, to, groupBy = 'reference' }) {
      const scope = dataScopeOf(actor);
      const [spend, leadCounts, areas, references] = await Promise.all([
        uow.repos.advertising.spendByAreaReference({ scope, from, to }),
        uow.repos.leads.countsByAreaReference({ scope, from, to }),
        uow.repos.areas.list({ includeInactive: true }),
        uow.repos.references.list({ includeInactive: true }),
      ]);
      const areaById = new Map(areas.map((a) => [a.id, a]));
      const referenceById = new Map(references.map((r) => [r.id, r]));

      // One cell per (area, channel) pair seen on either side.
      const cells = new Map();
      const cellOf = (areaId, referenceId) => {
        const key = `${areaId ?? '-'}|${referenceId ?? '-'}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = { areaId, referenceId, spend: 0, leads: 0, converted: 0 };
          cells.set(key, cell);
        }
        return cell;
      };
      for (const row of spend) cellOf(row.areaId, row.referenceId).spend += row.spend;
      for (const row of leadCounts) {
        const cell = cellOf(row.areaId, row.referenceId);
        cell.leads += row.leads;
        cell.converted += row.converted;
      }

      // Spend is booked per area; an outlet-scoped caller sees the whole area's
      // spend but only their own outlet's leads, so the ratio would mislead.
      const comparable = scope.branchId === null;

      const grouped = new Map();
      for (const cell of cells.values()) {
        const key = (groupBy === 'area' ? cell.areaId : cell.referenceId) ?? 'UNKNOWN';
        const bucket = grouped.get(key) ?? { key, spend: 0, leads: 0, converted: 0 };
        bucket.spend += cell.spend;
        bucket.leads += cell.leads;
        bucket.converted += cell.converted;
        grouped.set(key, bucket);
      }

      const ratio = (spendValue, count) =>
        comparable && count > 0 ? roundIdr(spendValue / count) : null;
      const rows = [...grouped.values()]
        .map((bucket) => {
          const area = groupBy === 'area' ? areaById.get(bucket.key) : null;
          const reference = groupBy === 'area' ? null : referenceById.get(bucket.key);
          return {
            key: bucket.key,
            areaCode: area?.code ?? null,
            areaName: area?.name ?? null,
            referenceCode: reference?.code ?? null,
            referenceName: reference?.name ?? null,
            channelType: reference?.channelType ?? null,
            spend: roundIdr(bucket.spend),
            leads: bucket.leads,
            converted: bucket.converted,
            conversionRate: bucket.leads ? bucket.converted / bucket.leads : 0,
            costPerLead: ratio(bucket.spend, bucket.leads),
            costPerConversion: ratio(bucket.spend, bucket.converted),
          };
        })
        .sort((a, b) => b.spend - a.spend);

      const totals = rows.reduce(
        (sum, row) => ({
          spend: sum.spend + row.spend,
          leads: sum.leads + row.leads,
          converted: sum.converted + row.converted,
        }),
        { spend: 0, leads: 0, converted: 0 },
      );

      return {
        period: { from: from ?? null, to: to ?? null },
        groupBy,
        comparable,
        basis: comparable ? 'same-scope' : 'area spend vs outlet leads — ratios omitted',
        totals: {
          ...totals,
          costPerLead: ratio(totals.spend, totals.leads),
          costPerConversion: ratio(totals.spend, totals.converted),
        },
        rows,
      };
    },
  });
}
