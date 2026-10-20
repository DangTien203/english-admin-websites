/**
 * Publishes, from the command line, the entries the job made — by the same rule as the bulk publish of /lookup/review
 * (docs/lookup-runbook.md §13; the rule: docs/lookup-admin.md §3.4). DRY RUN BY DEFAULT: nothing is published without --confirm.
 *
 *   npm run enrich:publish                                   # dry run: who would be published, who is held back and why
 *   npm run enrich:publish -- --cefr A1,A2 --limit 500       # dry run of a slice
 *   npm run enrich:publish -- --cefr A1,A2 --limit 500 --confirm
 *
 * Eligible = made by the job ('[auto]'), not published, tier A complete, no note of Haiku in a "needs a look" category.
 * Each published entry gets an entry_edit_history line (field_name 'published', admin_id NULL, new_value 'true (cli)').
 * The logic is services/enrichment/oxford/run.ts (runPublish) and publish.ts.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { runPublish } from '../../services/enrichment/oxford/run';

if (require.main === module) {
  runPublish(process.argv.slice(2), { db: pool as any, source: pool as any, out: (l) => console.log(l), err: (l) => console.error(l) })
    .then(async (code) => {
      await pool.end().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('enrich:publish failed:', err?.message ?? err);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
