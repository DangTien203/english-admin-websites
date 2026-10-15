/**
 * startEnrichmentRuntime must not take a single job when the 30 topic tags are missing: every such job would end
 * failed / config_error for good, so a worker that started anyway would drain the queue into failed rows.
 */
import { EnrichmentConfigError } from '../../services/enrichment/errors';

const flags = { enrichmentEnabled: true, enrichmentWorkerEnabled: true };

jest.mock('../../config/db', () => ({ __esModule: true, default: { on: jest.fn() } }));
jest.mock('../../config/lookup', () => ({
  lookupConfig: { get flags() { return flags; }, queue: { schema: 'pgboss_unit', workerConcurrency: 2 } },
}));
jest.mock('../../services/queue/boss', () => ({ getBoss: jest.fn(), stopBoss: jest.fn() }));
jest.mock('../../services/queue/enrichmentWorker', () => ({
  EnrichmentWorker: jest.fn().mockImplementation(() => ({ requeueInFlight: jest.fn() })),
  registerEnrichmentWorkers: jest.fn(),
}));
jest.mock('../../services/enrichment/topics', () => ({ loadTopicIds: jest.fn() }));
jest.mock('../../services/enrichment/pipeline', () => ({ runEnrichment: jest.fn() }));

import { loadTopicIds } from '../../services/enrichment/topics';
import { getBoss } from '../../services/queue/boss';
import { registerEnrichmentWorkers } from '../../services/queue/enrichmentWorker';
import { startEnrichmentRuntime } from '../../services/queue/runtime';

const topics = loadTopicIds as jest.Mock;
const boss = getBoss as jest.Mock;
const register = registerEnrichmentWorkers as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  flags.enrichmentEnabled = true;
  flags.enrichmentWorkerEnabled = true;
  boss.mockResolvedValue({});
  topics.mockResolvedValue(new Map());
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('startEnrichmentRuntime', () => {
  it('topics seeded: pg-boss starts and the worker is registered', async () => {
    const runtime = await startEnrichmentRuntime('worker');
    expect(runtime?.worker).not.toBeNull();
    expect(boss).toHaveBeenCalledWith('worker');
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('topics NOT seeded: fails loudly, starts neither pg-boss nor a worker, so the jobs stay queued', async () => {
    topics.mockRejectedValue(new EnrichmentConfigError('topics_not_seeded', 'topics_not_seeded: 30 of 30 topic tags are missing'));
    await expect(startEnrichmentRuntime('worker')).rejects.toBeInstanceOf(EnrichmentConfigError);
    expect(boss).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged).toContainEqual(expect.objectContaining({ evt: 'topics_not_seeded', code: 'topics_not_seeded' }));
  });

  it('a database error is not reported as a missing seed, and it also stops the start', async () => {
    topics.mockRejectedValue(new Error('connection refused'));
    await expect(startEnrichmentRuntime('worker')).rejects.toThrow('connection refused');
    expect(boss).not.toHaveBeenCalled();
    const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged.some((l) => l.evt === 'topics_not_seeded')).toBe(false);
  });

  it('a process that only SENDS jobs does not need the tags', async () => {
    flags.enrichmentWorkerEnabled = false;
    topics.mockRejectedValue(new EnrichmentConfigError('topics_not_seeded', 'x'));
    const runtime = await startEnrichmentRuntime('api');
    expect(runtime?.worker).toBeNull();
    expect(topics).not.toHaveBeenCalled();
    expect(boss).toHaveBeenCalledWith('sender');
  });

  it('nothing happens when the queue is switched off', async () => {
    flags.enrichmentEnabled = false;
    expect(await startEnrichmentRuntime('api')).toBeNull();
    expect(boss).not.toHaveBeenCalled();
  });
});
