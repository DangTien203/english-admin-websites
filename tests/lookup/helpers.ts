import type { FetchLike } from '../../services/upstream/http';

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function htmlResponse(status: number, html = '<!DOCTYPE html><html><body>404 page</body></html>'): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

export type Step = Response | Error | ((url: string, init?: RequestInit) => Response | Promise<Response>);

/** A scripted fetch: each call consumes the next step (the last step repeats). Records every call. */
export function scriptedFetch(steps: Step[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    // A Response body can only be read once: hand out a clone each time.
    return step.clone();
  };
  return { fn, calls };
}

/** fetch that never answers until its abort signal fires (to exercise real timeouts). */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError')));
  });

export function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export const noSleep = async () => undefined;
