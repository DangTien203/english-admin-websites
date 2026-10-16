import { drainBackground, drainLookupBackground } from '../../services/lookup';

/** Graceful shutdown (app.ts, step "lookup_background"): the work that follows an answer finishes, but never holds the exit for long. */
describe('drainBackground', () => {
  it('returns at once when there is nothing to wait for', async () => {
    await expect(drainBackground(undefined)).resolves.toBeUndefined();
    await expect(drainLookupBackground()).resolves.toBeUndefined(); // no lookup has built the service in this process
  });

  it('waits for the work to finish', async () => {
    let finished = false;
    const target = {
      idle: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 30)
        ),
    };
    await drainBackground(target, 2000);
    expect(finished).toBe(true);
  });

  it('gives up after maxMs when the work is stuck (a send waiting for a dead database must not hold the exit)', async () => {
    const stuck = { idle: () => new Promise<void>(() => undefined) };
    const started = Date.now();
    await drainBackground(stuck, 40);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a rejecting idle() does not fail the shutdown step', async () => {
    await expect(drainBackground({ idle: () => Promise.reject(new Error('boom')) })).resolves.toBeUndefined();
  });
});
