/**
 * The hourly practice-session expiry on the worker (services/queue/practiceExpirySchedule.ts): the pg-boss side only. What a pass does
 * to the sessions is tested against the database in tests/practiceSessionExpiry.test.ts. No database here: the pass is mocked.
 */
jest.mock('../../config/db', () => ({ __esModule: true, default: { on: jest.fn() } }));
jest.mock('../../services/practiceSessionService', () => ({ abandonExpiredPracticeSessions: jest.fn() }));

import { abandonExpiredPracticeSessions } from '../../services/practiceSessionService';
import { PRACTICE_EXPIRY_QUEUE } from '../../services/queue/constants';
import { PRACTICE_EXPIRY_CRON, registerPracticeExpirySchedule } from '../../services/queue/practiceExpirySchedule';

const pass = abandonExpiredPracticeSessions as jest.Mock;

function fakeBoss() {
  const calls: Array<[string, ...unknown[]]> = [];
  let handler: (jobs: unknown[]) => Promise<void> = async () => undefined;
  const boss = {
    createQueue: jest.fn(async (...a: unknown[]) => void calls.push(['createQueue', ...a])),
    schedule: jest.fn(async (...a: unknown[]) => void calls.push(['schedule', ...a])),
    work: jest.fn(async (name: string, options: unknown, h: (jobs: unknown[]) => Promise<void>) => {
      calls.push(['work', name, options]);
      handler = h;
      return 'work-1';
    }),
  };
  return { boss: boss as any, calls, tick: () => handler([{}]) };
}

beforeEach(() => {
  jest.clearAllMocks();
  pass.mockResolvedValue({ abandoned: 0, skipped: 0, failed: 0, batches: 0 });
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('registerPracticeExpirySchedule', () => {
  it('is hourly, on the hour', () => {
    expect(PRACTICE_EXPIRY_CRON).toBe('0 * * * *');
  });

  it('creates the exclusive queue BEFORE scheduling, schedules every hour, then starts ONE handler at a time', async () => {
    const b = fakeBoss();
    const out = await registerPracticeExpirySchedule(b.boss);
    expect(out).toEqual({ workId: 'work-1', cron: '0 * * * *', queue: PRACTICE_EXPIRY_QUEUE });
    expect(b.calls.map((c) => c[0])).toEqual(['createQueue', 'schedule', 'work']);
    expect(b.calls[0]).toEqual(['createQueue', PRACTICE_EXPIRY_QUEUE, expect.objectContaining({ policy: 'exclusive', retryLimit: 0 })]);
    expect(b.calls[1]).toEqual(['schedule', PRACTICE_EXPIRY_QUEUE, '0 * * * *', null]);
    expect(b.calls[2][2]).toMatchObject({ localConcurrency: 1, batchSize: 1 });
  });

  it('each tick runs one pass with the options it was given and tells the observer', async () => {
    const seen: unknown[] = [];
    pass.mockResolvedValue({ abandoned: 3, skipped: 1, failed: 0, batches: 1 });
    const b = fakeBoss();
    await registerPracticeExpirySchedule(b.boss, { pass: { batchSize: 7, userIds: ['u1'] }, onPass: (r) => seen.push(r) });
    await b.tick();
    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledWith({ batchSize: 7, userIds: ['u1'] });
    expect(seen).toEqual([{ abandoned: 3, skipped: 1, failed: 0, batches: 1 }]);
    const logged = (console.info as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(logged).toContainEqual(expect.objectContaining({ evt: 'practice_expiry', abandoned: 3 }));
  });

  it('a pass that closed nothing is quiet; one with failed sessions is a warning (they stay open for the next run)', async () => {
    const b = fakeBoss();
    await registerPracticeExpirySchedule(b.boss);
    await b.tick();
    expect(console.warn).not.toHaveBeenCalled();
    pass.mockResolvedValue({ abandoned: 1, skipped: 0, failed: 2, batches: 1 });
    await b.tick();
    expect((console.warn as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]).evt)).toContain('practice_expiry');
  });

  it('a failing pass is logged and rethrown (pg-boss fails the job; the next tick is the retry); a throwing observer changes nothing', async () => {
    pass.mockRejectedValueOnce(new Error('db down'));
    const b = fakeBoss();
    await registerPracticeExpirySchedule(b.boss);
    await expect(b.tick()).rejects.toThrow('db down');
    expect((console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]).evt)).toContain('practice_expiry_failed');

    const b2 = fakeBoss();
    await registerPracticeExpirySchedule(b2.boss, {
      onPass: () => {
        throw new Error('observer');
      },
    });
    await expect(b2.tick()).resolves.toBeUndefined();
  });

  it('accepts another cron expression and queue name (tests use every minute)', async () => {
    const b = fakeBoss();
    await registerPracticeExpirySchedule(b.boss, { cron: '* * * * *', queueName: 'q.test' });
    expect(b.boss.schedule).toHaveBeenCalledWith('q.test', '* * * * *', null);
  });
});
