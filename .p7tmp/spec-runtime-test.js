module.exports = [
  { file: 'tests/queue/runtime.test.ts', edits: [
    [`jest.mock('../../services/enrichment/topics', () => ({ loadTopicIds: jest.fn() }));`,
     `jest.mock('../../services/queue/reconcileSchedule', () => ({ registerReconcileSchedule: jest.fn() }));
jest.mock('../../services/enrichment/topics', () => ({ loadTopicIds: jest.fn() }));`],
    [`import { registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';`,
     `import { registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { registerReconcileSchedule } from '../../services/queue/reconcileSchedule';`],
    [`const register = registerEnrichmentWorkers as jest.Mock;`, `const register = registerEnrichmentWorkers as jest.Mock;
const reconcile = registerReconcileSchedule as jest.Mock;`],
    [`    expect(register).toHaveBeenCalledTimes(1);
  });

  it('topics NOT seeded`, `    expect(register).toHaveBeenCalledTimes(1);
  });

  it('a worker also schedules the 10-minute reconcile pass (once per start)', async () => {
    await startEnrichmentRuntime('worker');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1]).toHaveProperty('pool');
  });

  it('topics NOT seeded`],
    [`    expect(register).not.toHaveBeenCalled();
    const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged).toContainEqual(expect.objectContaining({ evt: 'topics_not_seeded', code: 'topics_not_seeded' }));`,
     `    expect(register).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged).toContainEqual(expect.objectContaining({ evt: 'topics_not_seeded', code: 'topics_not_seeded' }));`],
    [`    expect(topics).not.toHaveBeenCalled();
    expect(boss).toHaveBeenCalledWith('sender');`, `    expect(topics).not.toHaveBeenCalled();
    expect(boss).toHaveBeenCalledWith('sender');
    expect(reconcile).not.toHaveBeenCalled(); // only a worker runs the cron pass`],
  ]},
];
