/**
 * READ-ONLY audit of definition coverage: which dictionary entries lack an English and/or a Vietnamese definition.
 *
 *   npx tsx scripts/dev/audit-definitions.ts [--sample 8] [--list <file.json>]
 *
 * An entry is COMPLETE when ALL of these hold (the app shows the first sense's definition_vi and falls back to meaning_vi):
 *   1. dictionary_entries.meaning_en and meaning_vi are non-blank,
 *   2. it has at least one entry_senses row, and EVERY sense has a non-blank definition_en and definition_vi,
 *   3. every part of speech listed in dictionary_entries.pos has at least one such sense (otherwise that part of speech has
 *      neither an English nor a Vietnamese definition).
 * It also flags values that are present but wrong, checked on every sense: Vietnamese identical to the English, English prose in a
 * Vietnamese field, Vietnamese letters in an English field, placeholders such as "-" or "N/A".
 *
 *   --sample N     headwords to show per category (default 8)
 *   --list <file>  write every incomplete entry (current texts and sense rows) as JSON
 *
 * Everything runs inside BEGIN READ ONLY, so the script cannot change data. It prints no connection details.
 * The fix for what this finds is scripts/dev/fill-definitions.ts (dry-run by default).
 */
import 'dotenv/config';
import fs from 'node:fs';
import pool from '../../config/db';
import { readArg } from '../enrichment/args';

const argv = process.argv.slice(2);
const SAMPLE = Math.max(parseInt(readArg(argv, 'sample') ?? '8', 10) || 8, 0);
const LIST_FILE = readArg(argv, 'list');

/**
 * Letters only Vietnamese uses. é è ê à â ô ó ò ú ù ì í ý are left out on purpose: French and Spanish loanwords ("café", "résumé")
 * use them, and an English definition may legitimately contain one.
 */
const VI_ONLY_SOURCE = '[ạảãấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹơưăđ]';
/**
 * Common English function words. Two DISTINCT ones in a text with no Vietnamese-only letter is English prose. Distinct, because
 * Vietnamese words coincide with single English ones ("an toàn", "hét the thé") and one repeated word proves nothing.
 */
const EN_STOP_SOURCE = '\\m(the|of|to|a|an|is|in|and|that|or|for|with|who|which|it|be|as|by|on|at|from|someone|something|used)\\M';
const PLACEHOLDER_SOURCE = '^(?:[-–—_.?!*[:space:]]+|n/?a|none|null|undefined|todo|tbd|xxx+|chưa có|không có)$';

const VI_ONLY = new RegExp(VI_ONLY_SOURCE, 'i');
const EN_STOP = /\b(?:the|of|to|a|an|is|in|and|that|or|for|with|who|which|it|be|as|by|on|at|from|someone|something|used)\b/gi;
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE.replace('[:space:]', '\\s'), 'i');

interface SenseRow {
  id: string;
  pos: string;
  sense_order: number;
  definition_en: string | null;
  definition_vi: string | null;
}

interface EntryRow {
  id: string;
  headword: string;
  lemma: string;
  pos: string[] | null;
  published: boolean;
  source: string;
  is_auto: boolean;
  meaning_en: string | null;
  meaning_vi: string | null;
  senses: number;
  senses_no_en: number;
  senses_no_vi: number;
  senses_vi_eq_en: number;
  senses_vi_english: number;
  senses_en_vietnamese: number;
  senses_placeholder: number;
  pos_missing: string[] | null;
  first_en: string | null;
  first_vi: string | null;
}

const blank = (s: string | null | undefined): boolean => s === null || s === undefined || s.trim() === '';
const norm = (s: string | null | undefined): string => (s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const englishProse = (s: string | null): boolean => !blank(s) && !VI_ONLY.test(s!) && new Set(s!.toLowerCase().match(EN_STOP) ?? []).size >= 2;

/** One named test over an entry. `gap` = a definition is missing (fix needed); `quality` = present but suspect. */
interface Check {
  key: string;
  label: string;
  kind: 'gap' | 'quality';
  test: (e: EntryRow) => boolean;
}

const CHECKS: Check[] = [
  { key: 'no_senses', label: 'no sense rows at all', kind: 'gap', test: (e) => e.senses === 0 },
  { key: 'no_meaning_en', label: 'entry-level meaning_en blank', kind: 'gap', test: (e) => blank(e.meaning_en) },
  { key: 'no_meaning_vi', label: 'entry-level meaning_vi blank', kind: 'gap', test: (e) => blank(e.meaning_vi) },
  { key: 'senses_no_en', label: 'some sense has no definition_en', kind: 'gap', test: (e) => e.senses_no_en > 0 },
  { key: 'senses_no_vi', label: 'some sense has no definition_vi', kind: 'gap', test: (e) => e.senses_no_vi > 0 },
  {
    key: 'pos_without_sense',
    label: 'a part of speech listed on the entry has no sense, so no EN and no VI definition for it',
    kind: 'gap',
    test: (e) => (e.pos_missing?.length ?? 0) > 0,
  },
  {
    key: 'no_en_anywhere',
    label: 'NO English definition anywhere (meaning_en and every sense blank)',
    kind: 'gap',
    test: (e) => blank(e.meaning_en) && e.senses_no_en === e.senses,
  },
  {
    key: 'no_vi_anywhere',
    label: 'NO Vietnamese definition anywhere (meaning_vi and every sense blank)',
    kind: 'gap',
    test: (e) => blank(e.meaning_vi) && e.senses_no_vi === e.senses,
  },
  {
    key: 'app_shows_no_vi',
    label: 'app would show NO Vietnamese (first sense blank AND meaning_vi blank)',
    kind: 'gap',
    test: (e) => blank(e.first_vi) && blank(e.meaning_vi),
  },
  {
    key: 'vi_equals_en',
    label: 'Vietnamese identical to English (never translated)',
    kind: 'quality',
    test: (e) => e.senses_vi_eq_en > 0 || (!blank(e.meaning_vi) && norm(e.meaning_vi) === norm(e.meaning_en)),
  },
  {
    key: 'vi_is_headword',
    label: 'meaning_vi is just the headword',
    kind: 'quality',
    test: (e) => !blank(e.meaning_vi) && norm(e.meaning_vi) === norm(e.headword),
  },
  {
    key: 'vi_looks_english',
    label: 'a Vietnamese field holds English prose',
    kind: 'quality',
    test: (e) => e.senses_vi_english > 0 || englishProse(e.meaning_vi),
  },
  {
    key: 'en_looks_vietnamese',
    label: 'an English field holds Vietnamese-only letters',
    kind: 'quality',
    test: (e) => e.senses_en_vietnamese > 0 || (!blank(e.meaning_en) && VI_ONLY.test(e.meaning_en!)),
  },
  {
    key: 'placeholder',
    label: 'placeholder text ("-", "N/A", "TODO", …) in a definition',
    kind: 'quality',
    test: (e) => e.senses_placeholder > 0 || [e.meaning_en, e.meaning_vi].some((v) => !blank(v) && PLACEHOLDER.test(v!.trim())),
  },
];

const ENTRIES_SQL = `
  WITH sf AS (
    SELECT entry_id, pos, sense_order, definition_en, definition_vi,
           (NULLIF(btrim(definition_en), '') IS NULL) AS no_en,
           (NULLIF(btrim(definition_vi), '') IS NULL) AS no_vi,
           (lower(btrim(definition_vi)) = lower(btrim(definition_en))) AS vi_eq_en,
           (definition_vi !~* $1 AND (SELECT count(DISTINCT m[1]) FROM regexp_matches(lower(definition_vi), $2, 'g') AS m) >= 2) AS vi_english,
           (definition_en ~* $1) AS en_vietnamese,
           (definition_en ~* $3 OR definition_vi ~* $3) AS placeholder
      FROM entry_senses
  ),
  s AS (
    SELECT entry_id,
           count(*)::int AS senses,
           (count(*) FILTER (WHERE no_en))::int AS senses_no_en,
           (count(*) FILTER (WHERE no_vi))::int AS senses_no_vi,
           (count(*) FILTER (WHERE vi_eq_en))::int AS senses_vi_eq_en,
           (count(*) FILTER (WHERE vi_english))::int AS senses_vi_english,
           (count(*) FILTER (WHERE en_vietnamese))::int AS senses_en_vietnamese,
           (count(*) FILTER (WHERE placeholder))::int AS senses_placeholder,
           (array_agg(definition_en ORDER BY sense_order, pos))[1] AS first_en,
           (array_agg(definition_vi ORDER BY sense_order, pos))[1] AS first_vi,
           array_agg(DISTINCT pos) FILTER (WHERE NOT no_en AND NOT no_vi) AS defined_pos
      FROM sf
     GROUP BY entry_id
  )
  SELECT e.id, e.headword, e.lemma, e.pos, e.published, e.source,
         COALESCE(e.admin_note LIKE '[auto]%', false) AS is_auto,
         e.meaning_en, e.meaning_vi,
         COALESCE(s.senses, 0) AS senses,
         COALESCE(s.senses_no_en, 0) AS senses_no_en,
         COALESCE(s.senses_no_vi, 0) AS senses_no_vi,
         COALESCE(s.senses_vi_eq_en, 0) AS senses_vi_eq_en,
         COALESCE(s.senses_vi_english, 0) AS senses_vi_english,
         COALESCE(s.senses_en_vietnamese, 0) AS senses_en_vietnamese,
         COALESCE(s.senses_placeholder, 0) AS senses_placeholder,
         ARRAY(SELECT p FROM unnest(COALESCE(e.pos, '{}'::varchar[])) AS p
                WHERE NOT (p = ANY(COALESCE(s.defined_pos, '{}'::varchar[])))) AS pos_missing,
         s.first_en, s.first_vi
    FROM dictionary_entries e
    LEFT JOIN s ON s.entry_id = e.id
   ORDER BY lower(e.headword), e.id`;

/** Definitions that live in the other child tables (not part of the entry-level rule; reported so nothing is hidden). */
const CHILD_SQL = `
  SELECT 'entry_idioms' AS tbl, count(*)::int AS total,
         (count(*) FILTER (WHERE NULLIF(btrim(definition_en), '') IS NULL))::int AS no_en,
         (count(*) FILTER (WHERE NULLIF(btrim(definition_vi), '') IS NULL))::int AS no_vi FROM entry_idioms
  UNION ALL
  SELECT 'phrasal_verbs', count(*)::int,
         (count(*) FILTER (WHERE NULLIF(btrim(definition_en), '') IS NULL))::int,
         (count(*) FILTER (WHERE NULLIF(btrim(definition_vi), '') IS NULL))::int FROM phrasal_verbs`;

const COLUMNS_SQL = `
  SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND ((table_name = 'dictionary_entries' AND column_name IN ('meaning_en', 'meaning_vi'))
       OR (table_name = 'entry_senses' AND column_name IN ('definition_en', 'definition_vi')))
   ORDER BY table_name, column_name`;

const pct = (n: number, total: number): string => (total === 0 ? '0.0%' : `${((n * 100) / total).toFixed(1)}%`);
const pad = (s: string | number, n: number): string => String(s).padStart(n);

async function main(): Promise<void> {
  const client = await pool.connect();
  let entries: EntryRow[];
  let childRows: Array<{ tbl: string; total: number; no_en: number; no_vi: number }>;
  let columns: Array<{ table_name: string; column_name: string; is_nullable: string }>;
  let senseRows: Array<SenseRow & { entry_id: string }> = [];
  let failed = false;
  try {
    await client.query('BEGIN READ ONLY');
    entries = (await client.query(ENTRIES_SQL, [VI_ONLY_SOURCE, EN_STOP_SOURCE, PLACEHOLDER_SOURCE])).rows as EntryRow[];
    childRows = (await client.query(CHILD_SQL)).rows;
    columns = (await client.query(COLUMNS_SQL)).rows;

    const incomplete = entries.filter((e) => CHECKS.some((c) => c.kind === 'gap' && c.test(e)));
    if (LIST_FILE && incomplete.length > 0) {
      senseRows = (
        await client.query(
          `SELECT entry_id, id, pos, sense_order, definition_en, definition_vi
             FROM entry_senses WHERE entry_id = ANY($1::uuid[]) ORDER BY entry_id, sense_order, pos`,
          [incomplete.map((e) => e.id)]
        )
      ).rows;
    }
    await client.query('ROLLBACK');
  } catch (err) {
    failed = true; // an aborted transaction must not go back into the pool
    throw err;
  } finally {
    client.release(failed);
  }

  const total = entries.length;
  const published = entries.filter((e) => e.published).length;
  console.log(`\n=== dictionary: ${total} entries (${published} published, ${total - published} hidden) ===`);

  const bySource = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.source}${e.is_auto ? ' [auto]' : ''}`;
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }
  console.log('by source :', [...bySource.entries()].map(([k, n]) => `${k}=${n}`).join('   '));
  console.log(
    'column nullability :',
    columns.map((c) => `${c.table_name}.${c.column_name}=${c.is_nullable === 'YES' ? 'NULL allowed' : 'NOT NULL'}`).join('   ')
  );

  console.log('\n--- GAPS (a definition is missing) and QUALITY flags (a definition is present but suspect) ---');
  console.log(`${'check'.padEnd(22)} ${pad('all', 6)} ${pad('published', 10)} ${pad('hidden', 7)}   description`);
  for (const check of CHECKS) {
    const hit = entries.filter(check.test);
    const pub = hit.filter((e) => e.published).length;
    console.log(
      `${check.key.padEnd(22)} ${pad(hit.length, 6)} ${pad(pub, 10)} ${pad(hit.length - pub, 7)}   [${check.kind}] ${check.label}`
    );
    if (SAMPLE > 0 && hit.length > 0) {
      console.log(`${' '.repeat(22)} e.g. ${hit.slice(0, SAMPLE).map((e) => e.headword).join(', ')}`);
    }
  }

  const incomplete = entries.filter((e) => CHECKS.some((c) => c.kind === 'gap' && c.test(e)));
  const suspect = entries.filter((e) => !incomplete.includes(e) && CHECKS.some((c) => c.kind === 'quality' && c.test(e)));
  const incPub = incomplete.filter((e) => e.published).length;
  console.log(
    `\nINCOMPLETE (any gap): ${incomplete.length} of ${total} (${pct(incomplete.length, total)})  published ${incPub}, hidden ${incomplete.length - incPub}`
  );
  console.log(`COMPLETE but with a quality flag: ${suspect.length}`);
  console.log(`FULLY OK: ${total - incomplete.length - suspect.length} of ${total}`);

  const incBySource = new Map<string, number>();
  for (const e of incomplete) {
    const k = `${e.source}${e.is_auto ? ' [auto]' : ''} ${e.published ? 'published' : 'hidden'}`;
    incBySource.set(k, (incBySource.get(k) ?? 0) + 1);
  }
  console.log('incomplete by source:', [...incBySource.entries()].map(([k, n]) => `${k}=${n}`).join('   ') || '(none)');

  console.log('\n--- other child tables (not part of the entry-level rule) ---');
  for (const c of childRows) {
    console.log(`${c.tbl.padEnd(14)} rows=${c.total}  missing definition_en=${c.no_en}  missing definition_vi=${c.no_vi}`);
  }

  if (LIST_FILE) {
    const sensesByEntry = new Map<string, SenseRow[]>();
    for (const r of senseRows) {
      const list = sensesByEntry.get(r.entry_id) ?? [];
      list.push({ id: r.id, pos: r.pos, sense_order: r.sense_order, definition_en: r.definition_en, definition_vi: r.definition_vi });
      sensesByEntry.set(r.entry_id, list);
    }
    const payload = incomplete.map((e) => ({
      id: e.id,
      headword: e.headword,
      lemma: e.lemma,
      pos: e.pos,
      published: e.published,
      source: e.source,
      is_auto: e.is_auto,
      meaning_en: e.meaning_en,
      meaning_vi: e.meaning_vi,
      pos_missing: e.pos_missing,
      gaps: CHECKS.filter((c) => c.kind === 'gap' && c.test(e)).map((c) => c.key),
      senses: sensesByEntry.get(e.id) ?? [],
    }));
    fs.writeFileSync(LIST_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\nwrote ${payload.length} incomplete entries to ${LIST_FILE}`);
  }

  // A script for CI or a shell one-liner: non-zero when something is missing.
  if (incomplete.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('audit-definitions failed:', err?.message ?? err);
    process.exitCode = 2;
  })
  .finally(() => pool.end());
