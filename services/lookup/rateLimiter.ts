/**
 * Per-user limiter for lookups that MISS the dictionary (docs/lookup-spec.md §5 F6): such a lookup costs
 * a paid Google call, a dictionary hit does not. Sliding window, in-process memory (one instance of the
 * server = one counter; with several instances the effective limit is multiplied).
 */
export class UserRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now
  ) {
    if (!(limit >= 1)) throw new RangeError('limit must be >= 1');
  }

  /** Records one attempt when allowed. Otherwise says how long until the oldest attempt leaves the window. */
  check(userId: string): { allowed: boolean; retryAfterMs?: number } {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const recent = (this.hits.get(userId) ?? []).filter((x) => x > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + this.windowMs - t) };
    }

    recent.push(t);
    this.hits.set(userId, recent);
    if (this.hits.size > 5000) this.sweep(cutoff);
    return { allowed: true };
  }

  /** Drops users with no attempt left in the window so the map cannot grow forever. */
  private sweep(cutoff: number): void {
    for (const [user, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1] <= cutoff) this.hits.delete(user);
    }
  }
}
