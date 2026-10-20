/**
 * Sets cefr_level of the entries the job made ('[auto]') from the Oxford list: the LOWEST level Oxford gives the word
 * (docs/lookup-runbook.md §13).
 *
 *   npm run oxford:apply-cefr -- --file "P:\Personal\WordyGo_Full\oxford_5000.json" --dry-run    # only shows what would change
 *   npm run oxford:apply-cefr -- --file "P:\Personal\WordyGo_Full\oxford_5000.json"              # applies
 *
 * Unlike the other seeding tools this one APPLIES by default (--dry-run previews). It touches only entries whose admin_note starts with
 * '[auto]'; each change leaves an entry_edit_history line (field_name 'cefr_level', admin_id NULL) and appends '[oxford-cefr]' to
 * admin_note. A second run changes nothing. It prints the matrix of Haiku's level against Oxford's.
 * The logic is services/enrichment/oxford/run.ts (runApplyCefr) and cefr.ts.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { runApplyCefr } from '../../services/enrichment/oxford/run';

if (require.main === module) {
  runApplyCefr(process.argv.slice(2), { db: pool as any, source: pool as any, out: (l) => console.log(l), err: (l) => console.error(l) })
    .then(async (code) => {
      await pool.end().catch(() => undefined);
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('oxford:apply-cefr failed:', err?.message ?? err);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
