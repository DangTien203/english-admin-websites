/**
 * Prints how the notes of Haiku (`notes_for_review`) of every entry made by the enrichment job are classified, and which entries a
 * bulk publish would take (docs/lookup-admin.md §3.4). READ-ONLY: it changes nothing. Use it to check the rule after editing
 * REVIEW_NOTE_CATEGORIES in services/lookup/reviewNotes.ts.
 *
 *   npx tsx scripts/dev/classify-review-notes.ts            # the table by category, then the entries
 *   npx tsx scripts/dev/classify-review-notes.ts --entries  # only the entries
 *   npx tsx scripts/dev/classify-review-notes.ts --md       # Markdown tables (to paste into a document)
 */
import 'dotenv/config';
import pool from '../../config/db';
import * as AutoEntry from '../../models/AutoEntry';
import { tierAMissing } from '../../services/lookup/adminRules';
import { classifyReviewNote, REVIEW_NOTE_CATEGORIES } from '../../services/lookup/reviewNotes';
import { parseAutoNote } from '../../utils/autoEntryNote';

const argv = process.argv.slice(2);
const md = argv.includes('--md');
const onlyEntries = argv.includes('--entries');

async function main(): Promise<void> {
  const { rows } = await pool.query(`SELECT id, headword, published, admin_note FROM dictionary_entries WHERE admin_note LIKE '[auto]%' ORDER BY headword`);
  const facts = await AutoEntry.tierAFactsFor(pool, rows.map((r) => r.id));

  const byCategory = new Map<string, Array<{ headword: string; text: string }>>();
  const entries = rows.map((r) => {
    const notes = parseAutoNote(r.admin_note).review_notes.map(classifyReviewNote);
    for (const n of notes) {
      if (!byCategory.has(n.category)) byCategory.set(n.category, []);
      byCategory.get(n.category)!.push({ headword: r.headword, text: n.text });
    }
    const missing = tierAMissing(facts.get(r.id) as any);
    const blocking = notes.filter((n) => n.blocks);
    return {
      headword: r.headword as string,
      published: Boolean(r.published),
      notes: notes.length,
      blocking,
      tierA: missing.length === 0,
      eligible: !r.published && missing.length === 0 && blocking.length === 0,
    };
  });

  const total = [...byCategory.values()].reduce((n, l) => n + l.length, 0);
  if (!onlyEntries) {
    if (md) {
      console.log('| Nhóm | Chặn xuất bản hàng loạt | Số ghi chú | Mô tả |\n|---|:---:|---:|---|');
      for (const c of REVIEW_NOTE_CATEGORIES) console.log(`| ${c.label} (\`${c.id}\`) | ${c.blocks ? 'có (cần xem)' : 'không (nhẹ)'} | ${byCategory.get(c.id)?.length ?? 0} | ${c.description} |`);
      console.log(`| **Tổng** | | **${total}** | ${rows.length} mục từ \`[auto]\` |`);
    } else {
      console.log(`${rows.length} mục từ [auto], ${total} ghi chú\n`);
      for (const c of REVIEW_NOTE_CATEGORIES) {
        const list = byCategory.get(c.id) ?? [];
        console.log(`── ${c.label} (${c.id}) · ${c.blocks ? 'CHẶN' : 'nhẹ'} · ${list.length} ghi chú`);
        for (const x of list) console.log(`     ${x.headword}: ${x.text}`);
      }
    }
  }

  const eligible = entries.filter((e) => e.eligible);
  console.log(
    `\nMục từ: ${rows.length} · đã xuất bản ${entries.filter((e) => e.published).length} · đủ tầng A ${entries.filter((e) => e.tierA).length} · ` +
      `không có ghi chú chặn ${entries.filter((e) => e.blocking.length === 0).length} · ĐỦ ĐIỀU KIỆN xuất bản hàng loạt ${eligible.length}`
  );
  if (!md) {
    console.log(`Đủ điều kiện: ${eligible.map((e) => e.headword).join(', ') || '(không có)'}`);
    for (const e of entries.filter((x) => !x.eligible && !x.published)) {
      const why = !e.tierA ? 'thiếu tầng A' : `${e.blocking.length} ghi chú chặn (${[...new Set(e.blocking.map((b) => b.category))].join(', ')})`;
      console.log(`  không: ${e.headword.padEnd(14)} ${why}`);
    }
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(String(err?.message ?? err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
