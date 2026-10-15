/**
 * Fills ipa_us for automatic entries that were created without one (see services/enrichment/backfillIpa.ts).
 *
 *   npm run enrich:backfill-ipa                      # dry run: shows what it would do (default)
 *   npm run enrich:backfill-ipa -- --dry-run         # the same, explicitly
 *   npm run enrich:backfill-ipa -- --confirm         # writes (one transaction)
 *   npm run enrich:backfill-ipa -- --word ephemeral  # one lemma only
 *
 * Only '[auto]' entries with ipa_us NULL and published = false. IPA tagged US first, else the first IPA with no tag
 * (marked '[ipa-untagged]' in admin_note). ipa_uk is never touched. No AI, no network, nothing is deleted.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { applyIpaBackfill, planIpaBackfill } from '../../services/enrichment/backfillIpa';
import { fetchWiktionaryRows } from '../../services/enrichment/sources/wiktionary';
import { getRefDb } from '../../services/lookup/refDb';
import { readArg } from './args';

const argv = process.argv.slice(2);

function target(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return `${process.env.DB_HOST ?? 'localhost'}/${process.env.DB_NAME ?? 'english_learning_app'}`;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<number> {
  const confirm = argv.includes('--confirm');
  if (confirm && argv.includes('--dry-run')) {
    console.error('Use either --dry-run or --confirm, not both.');
    return 2;
  }
  const lemma = readArg(argv, 'word')?.trim().toLowerCase();

  console.log(`database : ${target()}`);
  console.log(`mode     : ${confirm ? 'CONFIRM (writes)' : 'dry run (nothing is written)'}${lemma ? `   lemma: ${lemma}` : ''}`);
  void lookupConfig; // validates the environment like every other tool

  const refDb = getRefDb();
  const plan = await planIpaBackfill({ db: pool, fetchRows: (l) => fetchWiktionaryRows(refDb, l), lemma });

  console.log(`\nautomatic entries without ipa_us : ${plan.scanned}`);
  console.log(`  would get an IPA              : ${plan.items.length}  (tagged US: ${plan.items.filter((i) => i.source === 'tagged_us').length}, untagged: ${plan.items.filter((i) => i.source === 'untagged').length})`);
  console.log(`  no usable IPA in Wiktionary   : ${plan.noIpa.length}${plan.noIpa.length ? `  [${plan.noIpa.map((e) => e.lemma).join(', ')}]` : ''}`);
  console.log(`  published, left alone         : ${plan.skippedPublished.length}${plan.skippedPublished.length ? `  [${plan.skippedPublished.map((e) => e.lemma).join(', ')}]` : ''}`);
  if (plan.items.length > 0) {
    console.log('');
    console.table(plan.items.map((i) => ({ lemma: i.lemma, source: i.source === 'tagged_us' ? 'IPA có thẻ US' : 'IPA không thẻ ([ipa-untagged])', ipa_us: i.ipa, id: i.id })));
  }

  if (!confirm) {
    console.log(`\nDry run: nothing was written. Re-run with --confirm to apply ${plan.items.length} change(s).`);
    return 0;
  }
  if (plan.items.length === 0) {
    console.log('\nNothing to write.');
    return 0;
  }
  const result = await applyIpaBackfill(pool as any, plan);
  console.log(`\nWritten: ${result.updated} entr${result.updated === 1 ? 'y' : 'ies'} updated${result.skipped ? `, ${result.skipped} skipped (changed meanwhile)` : ''}; entry_edit_history +${result.updated * 2} lines.`);
  return 0;
}

main()
  .then(async (code) => {
    await pool.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('enrich:backfill-ipa failed:', (err as Error)?.message ?? err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
