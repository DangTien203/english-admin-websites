/**
 * In-process token bucket (docs/lookup-spec.md §11.5), used to stay under the Free Dictionary
 * request budget (FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN). Starts full and refills continuously:
 * `capacity` tokens per `windowMs`.
 *
 * Per-process only: with several server instances each one has its own bucket.
 */
export interface TokenBucketOptions {
  capacity: number;
  windowMs: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    if (!(opts.capacity >= 1) || !(opts.windowMs > 0)) {
      throw new RangeError('TokenBucket needs capacity >= 1 and windowMs > 0');
    }
    this.capacity = opts.capacity;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs);
    this.lastRefill = t;
  }

  /** Takes `n` tokens if available; returns false (and takes nothing) otherwise. */
  tryRemove(n = 1): boolean {
    this.refill();
    if (this.tokens + 1e-9 >= n) {
      this.tokens = Math.max(0, this.tokens - n);
      return true;
    }
    return false;
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens + 1e-9);
  }

  /** Milliseconds until `n` tokens will be available (0 when they already are). */
  msUntilAvailable(n = 1): number {
    this.refill();
    const missing = n - this.tokens;
    if (missing <= 0) return 0;
    return Math.ceil((missing * this.windowMs) / this.capacity);
  }
}
