/**
 * Structured one-line JSON logs + tiny in-process counters for the queue layer (docs/lookup-spec.md §12).
 * Same convention as the rest of the lookup code: console.* with JSON.stringify({ evt, ... }).
 */

import { redactSecrets } from '../../utils/redact';

type Level = 'info' | 'warn' | 'error';

export function logEvent(level: Level, evt: string, fields: Record<string, unknown> = {}): void {
  const line = redactSecrets(JSON.stringify({ evt, ...fields }));
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

/** Message of anything thrown, capped so a provider body can never flood the log. */
export function errMessage(err: unknown): string {
  return redactSecrets(String((err as Error)?.message ?? err)).slice(0, 300);
}

const counters = new Map<string, number>();

/** e.g. incr('enqueue.skipped.daily_cap'). Read with counterSnapshot(); exposed to a metrics endpoint later. */
export function incr(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function counterSnapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetCounters(): void {
  counters.clear();
}
