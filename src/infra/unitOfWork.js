/**
 * Unit of Work: repositories for plain reads (`repos`)
 * dan menjalankan sekumpulan perubahan secara atomik (`run`).
 *
 *   await uow.run(async ({ appraisals, customers, audit }) => { ... });
 */
export function createUnitOfWork(db, buildRepositories) {
  return Object.freeze({
    repos: buildRepositories(db),
    run: (work) => db.transaction((tx) => work(buildRepositories(tx))),
  });
}
