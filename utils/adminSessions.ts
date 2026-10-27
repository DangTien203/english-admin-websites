import type { Store } from 'express-session';
import { sessionStore } from '../config/sessionStore';

/**
 * Ends every signed-in session of one admin account and returns how many it ended.
 *
 * A session holds a snapshot of the admin (id, role, …) taken at sign-in and requireAuth / requireRole trust it, so when a super admin
 * changes someone's role, status, e-mail or password the old sessions must go: otherwise a disabled or demoted admin keeps the old
 * rights until the cookie expires. They have to sign in again, and sign-in checks the account as it is now.
 */
export async function destroyAdminSessions(adminId: string, store: Store = sessionStore): Promise<number> {
  if (typeof store.all !== 'function') return 0;

  const sessions = await new Promise<Record<string, any>>((resolve, reject) => {
    store.all!((err, all) => (err ? reject(err) : resolve((all as Record<string, any>) ?? {})));
  });

  const sids = Object.entries(sessions)
    .filter(([, sess]) => sess?.admin?.id === adminId)
    .map(([sid]) => sid);

  await Promise.all(
    sids.map((sid) => new Promise<void>((resolve, reject) => store.destroy(sid, (err) => (err ? reject(err) : resolve()))))
  );
  return sids.length;
}
