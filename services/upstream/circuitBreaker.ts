import { BudgetExceeded, UpstreamConfigError, UpstreamNotFound, UpstreamProvider, UpstreamUnavailable } from './errors';

/**
 * Per-provider circuit breaker (docs/lookup-spec.md §11.2).
 *
 *   closed    → calls pass; N consecutive failures open the circuit
 *   open      → calls are rejected at once with UpstreamUnavailable('breaker_open')
 *   half_open → after resetMs ONE probe call is let through; success closes, failure re-opens
 *
 * What counts:
 *   failure  : UpstreamUnavailable (timeout, network, 5xx, 429, bad_response)
 *   trips at once : UpstreamConfigError (400/401/403 – retrying is pointless until someone fixes it), and a
 *              BudgetExceeded of the provider (spend_limit, provider_quota): later calls would only hit the same wall
 *   neutral  : UpstreamNotFound (healthy answer), BudgetExceeded('monthly_chars', our own counter), local_rate_limit,
 *              breaker_open, errors flagged affectsBreaker=false (per-word anomalies, a request shape the model
 *              rejects), and non-upstream errors (programming bugs must not hide a healthy provider)
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetMs: number;
  /** Injectable clock (epoch ms) so tests never sleep. */
  now?: () => number;
  /** Called on every state change; used for logging / metrics. Must not throw. */
  onStateChange?: (provider: UpstreamProvider, from: BreakerState, to: BreakerState) => void;
}

export interface BreakerSnapshot {
  provider: UpstreamProvider;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
}

type Outcome = 'success' | 'failure' | 'trip' | 'neutral';

export function classifyOutcome(err: unknown): Outcome {
  if (err instanceof UpstreamConfigError) return err.affectsBreaker ? 'trip' : 'neutral';
  // A limit on the PROVIDER's side (spend limit, quota) stays hit until someone raises it: stop calling at once.
  // Our own monthly counter ('monthly_chars') already blocks calls locally, so it says nothing about provider health.
  if (err instanceof BudgetExceeded) return err.reason === 'spend_limit' || err.reason === 'provider_quota' ? 'trip' : 'neutral';
  if (err instanceof UpstreamNotFound) return 'neutral';
  if (err instanceof UpstreamUnavailable) {
    if (!err.affectsBreaker) return 'neutral';
    return err.reason === 'local_rate_limit' || err.reason === 'breaker_open' ? 'neutral' : 'failure';
  }
  return 'neutral';
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(
    readonly provider: UpstreamProvider,
    private readonly opts: CircuitBreakerOptions
  ) {
    this.now = opts.now ?? Date.now;
  }

  snapshot(): BreakerSnapshot {
    return {
      provider: this.provider,
      state: this.currentState(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
    };
  }

  /** Current state; an open circuit whose reset time elapsed reports half_open. */
  currentState(): BreakerState {
    if (this.state === 'open' && this.openedAt !== null && this.now() - this.openedAt >= this.opts.resetMs) {
      return 'half_open';
    }
    return this.state;
  }

  /**
   * Runs fn through the breaker. Rejects with UpstreamUnavailable('breaker_open') without calling fn
   * when the circuit is open (or half-open with a probe already running).
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState();

    if (state === 'open') {
      throw this.openError();
    }
    if (state === 'half_open') {
      if (this.probeInFlight) throw this.openError();
      this.transition('half_open');
      this.probeInFlight = true;
    }

    const isProbe = state === 'half_open';
    try {
      const result = await fn();
      this.onOutcome('success', isProbe);
      return result;
    } catch (err) {
      this.onOutcome(classifyOutcome(err), isProbe);
      throw err;
    } finally {
      if (isProbe) this.probeInFlight = false;
    }
  }

  private openError(): UpstreamUnavailable {
    const retryAfterMs =
      this.openedAt === null ? undefined : Math.max(0, this.opts.resetMs - (this.now() - this.openedAt));
    return new UpstreamUnavailable(this.provider, 'breaker_open', {
      message: 'circuit open',
      retryAfterMs,
    });
  }

  private onOutcome(outcome: Outcome, wasProbe: boolean): void {
    switch (outcome) {
      case 'success':
        this.consecutiveFailures = 0;
        if (this.state !== 'closed') this.transition('closed');
        break;
      case 'failure':
        this.consecutiveFailures++;
        if (wasProbe || this.consecutiveFailures >= this.opts.failureThreshold) this.open();
        break;
      case 'trip':
        this.consecutiveFailures++;
        this.open();
        break;
      case 'neutral':
        // A neutral result says nothing about provider health. A probe that ended neutrally
        // must not leave the breaker stuck: allow the next call to probe again.
        break;
    }
  }

  private open(): void {
    this.openedAt = this.now();
    this.transition('open');
  }

  private transition(to: BreakerState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === 'closed') {
      this.openedAt = null;
      this.consecutiveFailures = 0;
    }
    try {
      this.opts.onStateChange?.(this.provider, from, to);
    } catch {
      /* observers must never break the call path */
    }
  }
}
