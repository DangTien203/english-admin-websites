/**
 * Lists the dictionary entries created by the enrichment job (admin_note starts with "[auto]"), newest first, for a quick
 * review before the admin pages of P8 exist.
 *
 *   npm run enrich:review -- [--limit 20] [--unpublished] [--word serendipity]
 *
 *   --unpublished   only entries with published = false (waiting for review)
 *   --word <w>      print one entry in full: senses, Vietnamese meanings, examples, forms, admin_note
 * Read-only.
 */
import 'dotenv/config';
import pool from '../../config/db';
import { readArg } from './args';

const argv = process.argv.slice(2);

async function showOne(word: string): Promise<void> {
  const { rows: entries } = await pool.query(
    `SELECT * FROM dictionary_entries WHERE admin_note LIKE '[auto]%' AND (lower(headword) = $1 OR lower(lemma) = $1) ORDER BY created_at DESC LIMIT 1`,
    [word]
  );
  if (entries.length === 0) {
    console.log(`no auto-created entry for "${word}"`);
    return;
  }
  const e = entries[0];
  console.log(`${e.headword} (lemma ${e.lemma})  id ${e.id}  published=${e.published}  pos [${(e.pos ?? []).join(', ')}]  cefr ${e.cefr_level ?? '-'}  rank ${e.frequency_rank ?? '-'}`);
  console.log(`ipa_us ${e.ipa_us ?? '-'}  ipa_uk ${e.ipa_uk ?? '-'}  audio_us ${e.audio_us_url ?? '-'}  audio_uk ${e.audio_uk_url ?? '-'}`);
  console.log(`meaning_vi: ${e.meaning_vi}\nmeaning_en: ${e.meaning_en ?? '-'}\nexample: ${e.example_en ?? '-'} / ${e.example_vi ?? '-'}\netymology: ${(e.etymology ?? '-').slice(0, 200)}`);
  const { rows: senses } = await pool.query(`SELECT id, pos, sense_order, definition_en, definition_vi, register, domain FROM entry_senses WHERE entry_id = $1 ORDER BY sense_order`, [e.id]);
  for (const s of senses) {
    console.log(`\n  [${s.sense_order}] ${s.pos}: ${s.definition_en}\n      vi: ${s.definition_vi}${s.register ? `  register ${s.register}` : ''}${s.domain ? `  domain ${s.domain}` : ''}`);
    const { rows: ex } = await pool.query(`SELECT example_en, example_vi FROM sense_examples WHERE sense_id = $1 ORDER BY sort_order`, [s.id]);
    ex.forEach((x) => console.log(`      ví dụ: ${x.example_en} / ${x.example_vi}`));
  }
  const { rows: forms } = await pool.query(`SELECT form_type, form_value FROM word_forms WHERE entry_id = $1 ORDER BY sort_order`, [e.id]);
  if (forms.length) console.log(`\nforms: ${forms.map((f) => `${f.form_value} (${f.form_type})`).join(', ')}`);
  console.log(`\nadmin_note: ${e.admin_note}`);
}

async function main(): Promise<void> {
  const word = readArg(argv, 'word')?.trim().toLowerCase();
  if (word) return showOne(word);

  const limit = Math.min(Math.max(parseInt(readArg(argv, 'limit') ?? '20', 10) || 20, 1), 500);
  const onlyUnpublished = argv.includes('--unpublished');
  const { rows } = await pool.query(
    `SELECT e.headword, e.published, e.cefr_level, e.pos, e.meaning_vi, e.created_at, e.admin_note,
            (SELECT count(*)::int FROM entry_senses s WHERE s.entry_id = e.id) AS senses
       FROM dictionary_entries e
      WHERE e.admin_note LIKE '[auto]%' ${onlyUnpublished ? 'AND e.published = FALSE' : ''}
      ORDER BY e.created_at DESC
      LIMIT $1`,
    [limit]
  );
  const total = await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE published)::int AS published FROM dictionary_entries WHERE admin_note LIKE '[auto]%'`);
  console.log(`auto-created entries: ${total.rows[0].n} (published ${total.rows[0].published})`);
  if (rows.length === 0) return;
  console.table(
    rows.map((r) => ({
      headword: r.headword,
      published: r.published,
      cefr: r.cefr_level ?? '',
      pos: (r.pos ?? []).join(','),
      senses: r.senses,
      meaning_vi: String(r.meaning_vi ?? '').slice(0, 60),
      created: new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' '),
      missing_B: /thiếu tầng B: ([^·]*)/.exec(r.admin_note ?? '')?.[1]?.trim() ?? '',
    }))
  );
}

main()
  .catch((err) => {
    console.error('enrich:review failed:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
