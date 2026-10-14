import { SHUTDOWN_GRACE_MS } from './constants';
import { errMessage, logEvent } from './log';

/**
 * SIGTERM / SIGINT handling shared by the API process and the worker process.
 * Steps run in order (stop taking work → wait for running jobs → close pools). A second signal, or the
 * hard timeout, exits immediately.
 */
export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

/** Runs the steps, logging failures; returns the process exit code (0 = all steps succeeded). */
export async function runShutdown(steps: ShutdownStep[]): Promise<number> {
  let code = 0;
  for (const step of steps) {
    try {
      await step.run();
      logEvent('info', 'shutdown_step', { step: step.name, ok: true });
    } catch (err) {
      code = 1;
      logEvent('error', 'shutdown_step', { step: step.name, ok: false, error: errMessage(err) });
    }
  }
  return code;
}

export function installShutdownHandlers(
  steps: ShutdownStep[],
  opts: { hardTimeoutMs?: number; exit?: (code: number) => void } = {}
): void {
  const hardTimeoutMs = opts.hardTimeoutMs ?? SHUTDOWN_GRACE_MS + 15_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logEvent('warn', 'shutdown_forced', { signal });
      exit(1);
      return;
    }
    shuttingDown = true;
    logEvent('info', 'shutdown_start', { signal });
    const hard = setTimeout(() => {
      logEvent('error', 'shutdown_timeout', { after_ms: hardTimeoutMs });
      exit(1);
    }, hardTimeoutMs);
    hard.unref();
    void runShutdown(steps).then((code) => {
      clearTimeout(hard);
      exit(code);
    });
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
