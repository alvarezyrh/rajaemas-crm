function businessDateKey(timeZone, instant) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}`;
}

const numeric = (value) => Number(value ?? 0);

export function createLiveOmsetService({ branches, cache, clock = () => new Date() }) {
  return Object.freeze({
    async open(actor) {
      const outlets = await branches.list(actor, { includeInactive: false });
      return Object.freeze({
        async snapshot() {
          const now = clock();
          const rows = await Promise.all(
            outlets.map(async (branch) => {
              const dateKey = businessDateKey(branch.timezone, now);
              const summary = await cache.get(`omset:live:${branch.id}:${dateKey}`);
              return {
                branchId: branch.id,
                branchCode: branch.code,
                branchName: branch.name,
                city: branch.city,
                province: branch.province,
                transactionCount: numeric(summary?.transaction_count),
                buyCount: numeric(summary?.buy_count),
                sellCount: numeric(summary?.sell_count),
                buyAmount: numeric(summary?.buy_amount),
                sellAmount: numeric(summary?.sell_amount),
                bonusAmount: numeric(summary?.bonus_amount),
                weightGram: numeric(summary?.weight_gram),
              };
            }),
          );
          const totals = rows.reduce(
            (sum, row) => ({
              transactionCount: sum.transactionCount + row.transactionCount,
              buyCount: sum.buyCount + row.buyCount,
              sellCount: sum.sellCount + row.sellCount,
              buyAmount: sum.buyAmount + row.buyAmount,
              sellAmount: sum.sellAmount + row.sellAmount,
              bonusAmount: sum.bonusAmount + row.bonusAmount,
              weightGram: sum.weightGram + row.weightGram,
            }),
            {
              transactionCount: 0,
              buyCount: 0,
              sellCount: 0,
              buyAmount: 0,
              sellAmount: 0,
              bonusAmount: 0,
              weightGram: 0,
            },
          );

          return { generatedAt: now.toISOString(), totals, branches: rows };
        },
      });
    },
  });
}
