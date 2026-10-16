import { logEvent } from '../services/queue/log';

/**
 * One structured log line per write made from the lookup / enrichment admin pages (P8): { evt: 'admin_action', ... }.
 *
 * Only identifiers, counts and result codes go in: the admin's id (never the e-mail or name), the action, the object (an entry
 * id, a word, a job id) and how it ended. No request body, no admin_note, no free text. logEvent masks API keys on top of that.
 *
 * result: 'ok' | 'rejected:<ERROR_CODE>' (an expected refusal) | 'forbidden' (role not allowed) | 'error' (unexpected failure).
 */
export interface AdminAction {
  adminId: string | null;
  action: string;
  target?: { type: string; id?: string; word?: string };
  result: string;
  /** counters only (words requested, entries published, ...) */
  extra?: Record<string, number | string | boolean>;
}

export function logAdminAction(a: AdminAction): void {
  const level = a.result === 'error' ? 'error' : a.result === 'forbidden' ? 'warn' : 'info';
  logEvent(level, 'admin_action', {
    admin_id: a.adminId,
    action: a.action,
    target_type: a.target?.type ?? null,
    target_id: a.target?.id ? a.target.id.slice(0, 64) : null,
    ...(a.target?.word ? { word: a.target.word.slice(0, 100) } : {}),
    result: a.result,
    ...(a.extra ?? {}),
  });
}
