/**
 * Single-flight (docs/lookup-spec.md §5 F7): concurrent calls with the same key share ONE execution.
 * The result is NOT cached — once the call settles the key is forgotten, so the next request starts fresh.
 * Errors are shared too (every waiter sees the same rejection).
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /** `shared` is true for callers that joined an execution started by someone else. */
  async run(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
    const existing = this.inFlight.get(key);
    if (existing) return { value: await existing, shared: true };

    const promise = fn();
    this.inFlight.set(key, promise);
    try {
      return { value: await promise, shared: false };
    } finally {
      // Only remove our own entry (a later flight for the same key must not be evicted).
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  get size(): number {
    return this.inFlight.size;
  }
}
