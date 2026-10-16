/**
 * Prints the LookupHealthService snapshot as JSON (breakers, Google characters, Anthropic tokens, jobs, queue depth, the last
 * failures). Read-only; the same snapshot is served at GET /lookup/api/health (P8). The in-memory parts (lookup counters, queue counters) describe THIS
 * process only, so from a command line they are empty: look at the API process's own snapshot for those.
 *
 *   npm run health:snapshot
 */
import 'dotenv/config';
import pool from '../config/db';
import { getLookupHealthService } from '../services/lookup/health';

getLookupHealthService()
  .getSnapshot()
  .then((snapshot) => console.log(JSON.stringify(snapshot, null, 2)))
  .catch((err) => {
    console.error('health:snapshot failed:', (err as Error)?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
