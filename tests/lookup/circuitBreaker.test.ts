import { CircuitBreaker } from '../../services/upstream/circuitBreaker';
import { BudgetExceeded, UpstreamConfigError, UpstreamNotFound, UpstreamUnavailable } from '../../services/upstream/errors';
import { fakeClock } from './helpers';

const fail = () => Promise.reject(new UpstreamUnavailable('free_dictionary', 'http_5xx'));
const ok = () => Promise.resolve('ok');

function make(threshold = 3, resetMs = 30_000) {
  const clock = fakeClock();
  const changes: string[] = [];
  const breaker = new CircuitBreaker('free_dictionary', {
    failureThreshold: threshold,
    resetMs,
    now: clock.now,
    onStateChange: (_p, from, to) => changes.push(`${from}>${to}`),
  });
  return { breaker, clock, changes };
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold and a success resets the count', async () => {
    const { breaker } = make(3);
    await expect(breaker.exec(fail)).rejects.toBeInstanceOf(UpstreamUnavailable);
    await expect(breaker.exec(fail)).rejects.toBeInstanceOf(UpstreamUnavailable);
    await breaker.exec(ok);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    await expect(breaker.exec(fail)).rejects.toBeInstanceOf(UpstreamUnavailable);
    await expect(breaker.exec(fail)).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(breaker.currentState()).toBe('closed');
  });

  it('opens after N consecutive failures, then rejects without calling fn', async () => {
    const { breaker, changes } = make(3);
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fail)).rejects.toMatchObject({ reason: 'http_5xx' });
    expect(breaker.currentState()).toBe('open');
    const fn = jest.fn(ok);
    await expect(breaker.exec(fn)).rejects.toMatchObject({ name: 'UpstreamUnavailable', reason: 'breaker_open' });
    expect(fn).not.toHaveBeenCalled();
    expect(changes).toEqual(['closed>open']);
  });

  it('goes half-open after resetMs and closes again when the probe succeeds', async () => {
    const { breaker, clock, changes } = make(2, 30_000);
    await breaker.exec(fail).catch(() => undefined);
    await breaker.exec(fail).catch(() => undefined);
    clock.advance(29_999);
    expect(breaker.currentState()).toBe('open');
    clock.advance(1);
    expect(breaker.currentState()).toBe('half_open');
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.currentState()).toBe('closed');
    expect(changes).toEqual(['closed>open', 'open>half_open', 'half_open>closed']);
  });

  it('re-opens (and restarts the timer) when the half-open probe fails', async () => {
    const { breaker, clock } = make(1, 10_000);
    await breaker.exec(fail).catch(() => undefined);
    clock.advance(10_000);
    await expect(breaker.exec(fail)).rejects.toMatchObject({ reason: 'http_5xx' });
    expect(breaker.currentState()).toBe('open');
    clock.advance(9_999);
    expect(breaker.currentState()).toBe('open');
    clock.advance(1);
    expect(breaker.currentState()).toBe('half_open');
  });

  it('lets exactly one probe through while half-open', async () => {
    const { breaker, clock } = make(1, 1000);
    await breaker.exec(fail).catch(() => undefined);
    clock.advance(1000);
    let release!: () => void;
    const slow = breaker.exec(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('probe');
        })
    );
    await expect(breaker.exec(ok)).rejects.toMatchObject({ reason: 'breaker_open' });
    release();
    await expect(slow).resolves.toBe('probe');
    expect(breaker.currentState()).toBe('closed');
  });

  it('a config error (400/401/403) trips the breaker immediately', async () => {
    const { breaker } = make(5);
    await expect(breaker.exec(() => Promise.reject(new UpstreamConfigError('google_translate', 'HTTP 403', 403)))).rejects.toBeInstanceOf(UpstreamConfigError);
    expect(breaker.currentState()).toBe('open');
  });

  it.each([
    ['a 404 not-found', new UpstreamNotFound('free_dictionary')],
    ['budget exceeded', new BudgetExceeded('google_translate', 'monthly_chars')],
    ['our own rate limit', new UpstreamUnavailable('free_dictionary', 'local_rate_limit')],
    ['a programming error', new TypeError('bug')],
  ])('%s never counts as a failure', async (_name, error) => {
    const { breaker } = make(2);
    for (let i = 0; i < 5; i++) await expect(breaker.exec(() => Promise.reject(error))).rejects.toBe(error);
    expect(breaker.currentState()).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('an UpstreamUnavailable flagged affectsBreaker=false (per-word anomaly) is ignored', async () => {
    const { breaker } = make(1);
    const oneWord = new UpstreamUnavailable('free_dictionary', 'bad_response', { affectsBreaker: false });
    for (let i = 0; i < 3; i++) await expect(breaker.exec(() => Promise.reject(oneWord))).rejects.toBe(oneWord);
    expect(breaker.currentState()).toBe('closed');
  });

  it('a "not found" result counts as a healthy provider and resets the failure streak', async () => {
    const { breaker } = make(3);
    await breaker.exec(fail).catch(() => undefined);
    await breaker.exec(fail).catch(() => undefined);
    await breaker.exec(() => Promise.resolve({ found: false })); // FreeDictionaryClient returns { found:false } for a JSON 404
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('a neutral probe does not leave the breaker stuck', async () => {
    const { breaker, clock } = make(1, 1000);
    await breaker.exec(fail).catch(() => undefined);
    clock.advance(1000);
    await breaker.exec(() => Promise.reject(new UpstreamNotFound('free_dictionary'))).catch(() => undefined);
    await expect(breaker.exec(ok)).resolves.toBe('ok'); // the next call may probe again
    expect(breaker.currentState()).toBe('closed');
  });
});
