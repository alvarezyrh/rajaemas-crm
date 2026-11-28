import { Errors } from '../../core/errors.js';
import { can, Permissions as P } from '../../security/rbac.js';
import { dataScopeOf } from '../../shared/scope.js';

const DEFINITIONS = Object.freeze([
  {
    name: 'dashboard-city',
    title: 'Dashboard by City',
    permission: P.REPORT_EXECUTIVE,
    groups: [],
    available: true,
  },
  {
    name: 'dashboard-province',
    title: 'Dashboard by Province',
    permission: P.REPORT_EXECUTIVE,
    groups: [],
    available: true,
  },
  {
    name: 'transactions',
    title: 'Transaction Summary',
    permission: P.REPORT_EXECUTIVE,
    groups: ['area', 'city', 'branch', 'reference'],
    defaultGroupBy: 'branch',
    available: true,
  },
  {
    name: 'customers',
    title: 'Customer Summary',
    permission: P.REPORT_EXECUTIVE,
    groups: ['area', 'city', 'branch', 'reference', 'tier'],
    defaultGroupBy: 'tier',
    available: true,
  },
  {
    name: 'bonus',
    title: 'Bonus Summary',
    permission: P.REPORT_EXECUTIVE,
    groups: [],
    available: true,
  },
  {
    name: 'cs-ratings',
    title: 'CS Rating Summary',
    permission: P.REPORT_EXECUTIVE,
    groups: [],
    available: true,
  },
  {
    name: 'qms',
    title: 'QMS Summary',
    permission: P.REPORT_EXECUTIVE,
    groups: [],
    available: true,
  },
  {
    name: 'leads',
    title: 'Lead Summary',
    permission: P.LEAD_READ,
    groups: ['area', 'reference'],
    defaultGroupBy: 'area',
    available: true,
  },
  {
    name: 'advertising',
    title: 'Advertising Summary',
    permission: P.BUDGET_READ,
    groups: ['area', 'reference'],
    defaultGroupBy: 'reference',
    available: true,
  },
  {
    name: 'google-reviews',
    title: 'Google Review Summary',
    permission: P.REPORT_OUTLET_RATING,
    groups: [],
    available: false,
    reason: 'Google reviews are fetched on demand and are not stored for historical reports.',
  },
  {
    name: 'outlet-ratings',
    title: 'Outlet Rating Summary',
    permission: P.REPORT_OUTLET_RATING,
    groups: [],
    available: false,
    reason: 'Requires review data from the Phase F integration.',
  },
  {
    name: 'app-demographics',
    title: 'RajaEmas App Demographics',
    permission: P.REPORT_EXECUTIVE,
    groups: [],
    available: true,
  },
  {
    name: 'lmrei',
    title: 'LM REI Dashboard',
    permission: P.LMREI_READ,
    groups: [],
    available: true,
  },
]);

const BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);

function assertPeriod({ from, to }) {
  if (from && to && from > to) {
    throw Errors.validation([{ field: 'to', message: 'must be on or after from' }]);
  }
}

function withEnvelope(definition, query, groupBy, data) {
  return {
    report: definition.name,
    title: definition.title,
    period: { from: query.from ?? null, to: query.to ?? null },
    groupBy: groupBy ?? null,
    ...data,
  };
}

export function createReportsService({ repository, transactions, qms, leads, advertising }) {
  function definition(name) {
    const report = BY_NAME.get(name);
    if (!report) throw Errors.notFound('Report');
    return report;
  }

  return Object.freeze({
    definition,

    catalog(actor) {
      return DEFINITIONS.filter((item) => can(actor.role, item.permission)).map((item) => ({
        name: item.name,
        title: item.title,
        groups: item.groups,
        defaultGroupBy: item.defaultGroupBy,
        available: item.available,
        ...(item.reason ? { reason: item.reason } : {}),
      }));
    },

    async run(actor, name, query) {
      const report = definition(name);
      if (!can(actor.role, report.permission)) throw Errors.forbidden();
      assertPeriod(query);
      if (!report.available) throw Errors.notImplemented(report.reason);
      if (query.groupBy && !report.groups.includes(query.groupBy)) {
        throw Errors.validation([
          {
            field: 'groupBy',
            message: `must be one of: ${report.groups.join(', ')}`,
          },
        ]);
      }

      const groupBy = query.groupBy ?? report.defaultGroupBy;
      const options = { ...query, groupBy };
      switch (name) {
        case 'dashboard-city':
        case 'dashboard-province': {
          const result = await repository.dailySales({
            ...options,
            scope: dataScopeOf(actor),
            groupBy: name === 'dashboard-city' ? 'city' : 'province',
          });
          return withEnvelope(report, query, null, result);
        }
        case 'transactions': {
          const result = await repository.transactionSummary({
            ...options,
            scope: dataScopeOf(actor),
          });
          return withEnvelope(report, query, groupBy, result);
        }
        case 'customers': {
          const result = await repository.customerSummary({
            ...options,
            scope: dataScopeOf(actor),
          });
          return withEnvelope(report, query, groupBy, result);
        }
        case 'bonus': {
          const result = await transactions.bonusSummary(actor, query);
          return withEnvelope(report, query, null, {
            totals: result.totals,
            rows: result.rows,
            provisional: result.provisional,
            details: { rules: result.rules },
          });
        }
        case 'cs-ratings': {
          const rows = await qms.ratingSummary(actor, query);
          const ratings = sum(rows, 'ratings');
          const weightedScore = rows.reduce((total, row) => {
            const scoreTotal = Object.entries(row.distribution).reduce(
              (sum, [score, count]) => sum + Number(score) * count,
              0,
            );
            return total + scoreTotal;
          }, 0);
          return withEnvelope(report, query, null, {
            totals: {
              ratings,
              avgScore: ratings ? weightedScore / ratings : null,
            },
            rows,
          });
        }
        case 'qms': {
          const rows = await qms.summary(actor, query);
          const done = sum(rows, 'done');
          const weightedWait = rows.reduce(
            (total, row) => total + (row.avgWaitSeconds ?? 0) * row.done,
            0,
          );
          return withEnvelope(report, query, null, {
            totals: {
              tickets: sum(rows, 'tickets'),
              waiting: sum(rows, 'waiting'),
              serving: sum(rows, 'serving'),
              done,
              cancelled: sum(rows, 'cancelled'),
              avgWaitSeconds: done ? Math.round(weightedWait / done) : null,
              maxWaitSeconds: rows.length
                ? Math.max(...rows.map((row) => row.maxWaitSeconds ?? 0))
                : null,
            },
            rows,
          });
        }
        case 'leads': {
          const result = await leads.summary(actor, query);
          return withEnvelope(report, query, groupBy, {
            totals: {
              total: result.total,
              ...result.byStatus,
              avgDaysToConvert: result.avgDaysToConvert,
            },
            rows: groupBy === 'reference' ? result.byReference : result.byArea,
          });
        }
        case 'advertising': {
          const result = await advertising.summary(actor, query);
          return withEnvelope(report, query, groupBy, {
            totals: result.totals,
            rows: result.rows,
            details: { comparable: result.comparable, basis: result.basis },
          });
        }
        case 'app-demographics': {
          const result = await repository.appDemographics({
            ...query,
            scope: dataScopeOf(actor),
          });
          return withEnvelope(report, query, null, result);
        }
        case 'lmrei': {
          const result = await repository.lmreiSummary({
            ...query,
            scope: dataScopeOf(actor),
          });
          return withEnvelope(report, query, null, result);
        }
        default:
          throw Errors.notFound('Report');
      }
    },
  });
}
