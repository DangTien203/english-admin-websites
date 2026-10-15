module.exports = [
  { file: 'services/queue/reconcileSchedule.ts', edits: [
    [`export type LockedReconcileResult = { ran: true; result: ReconcileResult } | { ran: false; reason: 'lock_held' };`,
     `export type LockedReconcileResult = { ran: true; result: ReconcileResult } | { ran: false; reason: 'lock_held' };

/** Narrowing helper: this project compiles without strictNullChecks, which stops \`if (r.ran)\` from narrowing the union. */
export const didRun = (r: LockedReconcileResult): r is { ran: true; result: ReconcileResult } => r.ran === true;`],
    [`      if (outcome.ran) {
        incr('reconcile.passes');`, `      if (didRun(outcome)) {
        incr('reconcile.passes');`],
    [`        logEvent('info', 'enrich_reconcile_skipped', { reason: outcome.reason });`, `        logEvent('info', 'enrich_reconcile_skipped', { reason: 'lock_held' });`],
  ]},
  { file: 'tests/queue/boss.test.ts', edits: [
    [`  it('uses PGBOSS_SCHEMA and PGBOSS_POOL_MAX and never schedules cron jobs', () => {
    const o = buildBossOptions({ ...settings, schema: 'pgboss_x', poolMax: 7 }, 'worker', { connectionString: 'postgres://u:p@h/db' });
    expect(o).toMatchObject({ schema: 'pgboss_x', max: 7, schedule: false, connectionString: 'postgres://u:p@h/db' });
  });`,
     `  it('uses PGBOSS_SCHEMA and PGBOSS_POOL_MAX', () => {
    const o = buildBossOptions({ ...settings, schema: 'pgboss_x', poolMax: 7 }, 'worker', { connectionString: 'postgres://u:p@h/db' });
    expect(o).toMatchObject({ schema: 'pgboss_x', max: 7, connectionString: 'postgres://u:p@h/db' });
  });

  it('only the worker role evaluates the cron schedule (the 10-minute reconcile pass); a sender never does', () => {
    expect(buildBossOptions(settings, 'worker', {}).schedule).toBe(true);
    expect(buildBossOptions(settings, 'sender', {}).schedule).toBe(false);
  });`],
  ]},
];
