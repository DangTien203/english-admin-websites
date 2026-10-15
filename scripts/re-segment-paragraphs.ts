/**
 * Re-segment ebook paragraphs using the fixed `paragraphSegmenter`.
 *
 * What it does for each chapter (selected via CLI flags):
 *   1. Fetch existing paragraph rows ORDER BY paragraph_index.
 *   2. Reconstruct chapter text by joining current rows with double newlines
 *      (a best-effort reconstruction — the original author breaks were already
 *      lost when the broken splitter ran). The new splitter will re-form
 *      sentence-respecting paragraphs from the reconstructed text.
 *   3. Compare new segmentation vs current rows. If identical → skip (no-op).
 *   4. Otherwise, inside a transaction:
 *        - DELETE all paragraph rows for the chapter.
 *        - INSERT the new paragraphs (paragraph_index 0..N-1).
 *        - Reset the chapter's TTS state: tts_status='none', tts_progress=0,
 *          tts_started_at=NULL, tts_completed_at=NULL.
 *        - Reset user_reading_progress.current_paragraph_index for users
 *          currently reading this ebook (their progress on this chapter is
 *          no longer meaningful — accept ~minutes of UX cost per spec).
 *   5. Print a per-chapter summary.
 *
 * Side-effect notes:
 *   - paragraph_id changes for every row → audio_url, audio_status,
 *     translation_vi, duration_ms are all reset (they live on the row itself).
 *     TTS audio in R2 stays cached by content hash — re-generation will reuse
 *     it where text is unchanged.
 *   - word_lookups references ebook_id only (no paragraph_id FK) → unaffected.
 *
 * Usage:
 *   tsx scripts/re-segment-paragraphs.ts --dry-run                # preview only
 *   tsx scripts/re-segment-paragraphs.ts --ebook <ebook_uuid>     # one ebook
 *   tsx scripts/re-segment-paragraphs.ts --chapter <chapter_uuid> # one chapter
 *   tsx scripts/re-segment-paragraphs.ts --all                    # every ebook
 *   tsx scripts/re-segment-paragraphs.ts --ebook <id> --apply     # actually write
 *
 * SAFETY: --dry-run is the default. You must pass --apply to mutate the DB.
 */
import 'dotenv/config';
import pool from '../config/db';
import { segmentParagraphs, countWords } from '../utils/paragraphSegmenter';

interface CliArgs {
  apply: boolean;
  ebookId: string | null;
  chapterId: string | null;
  scope: 'all' | 'ebook' | 'chapter';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ebookIdx = args.indexOf('--ebook');
  const chapterIdx = args.indexOf('--chapter');
  const all = args.includes('--all');

  const ebookId = ebookIdx >= 0 ? args[ebookIdx + 1] : null;
  const chapterId = chapterIdx >= 0 ? args[chapterIdx + 1] : null;

  let scope: CliArgs['scope'];
  if (chapterId) scope = 'chapter';
  else if (ebookId) scope = 'ebook';
  else if (all) scope = 'all';
  else {
    console.error(
      'Usage: tsx scripts/re-segment-paragraphs.ts ' +
        '(--all | --ebook <id> | --chapter <id>) [--apply]'
    );
    process.exit(1);
  }

  return { apply, ebookId, chapterId, scope };
}

interface ChapterRow {
  id: string;
  ebook_id: string;
  chapter_index: number;
  title: string | null;
}

async function selectChapters(args: CliArgs): Promise<ChapterRow[]> {
  if (args.scope === 'chapter') {
    const { rows } = await pool.query<ChapterRow>(
      `SELECT id, ebook_id, chapter_index, title
         FROM chapters
        WHERE id = $1`,
      [args.chapterId]
    );
    return rows;
  }
  if (args.scope === 'ebook') {
    const { rows } = await pool.query<ChapterRow>(
      `SELECT id, ebook_id, chapter_index, title
         FROM chapters
        WHERE ebook_id = $1
        ORDER BY chapter_index ASC`,
      [args.ebookId]
    );
    return rows;
  }
  // scope === 'all'
  const { rows } = await pool.query<ChapterRow>(
    `SELECT id, ebook_id, chapter_index, title
       FROM chapters
      ORDER BY ebook_id ASC, chapter_index ASC`
  );
  return rows;
}

interface ParagraphRow {
  id: string;
  paragraph_index: number;
  text: string;
}

interface ChapterPlan {
  chapter: ChapterRow;
  oldCount: number;
  newCount: number;
  identical: boolean;
  newParagraphs: string[];
}

/** Heuristic: row text ends at a real sentence boundary. */
function endsAtSentence(text: string): boolean {
  return /[.!?…]['"’”\)\]]?\s*$/.test(text.trim());
}

async function planChapter(chapter: ChapterRow): Promise<ChapterPlan> {
  const { rows: oldRows } = await pool.query<ParagraphRow>(
    `SELECT id, paragraph_index, text
       FROM paragraphs
      WHERE chapter_id = $1
      ORDER BY paragraph_index ASC`,
    [chapter.id]
  );

  // Reconstruct chapter text in a way that does NOT preserve the bad splits
  // from the old segmenter. Walk the old rows in order; whenever a row does
  // NOT end at a sentence boundary, glue it to the next row with a space
  // (this is almost certainly a broken split). Only insert \n\n between rows
  // that DO end cleanly, since those are the only places we can confidently
  // call "author paragraph break".
  const blocks: string[] = [];
  let buffer = '';
  for (const row of oldRows) {
    const text = row.text.trim();
    if (!buffer) {
      buffer = text;
      continue;
    }
    if (!endsAtSentence(buffer)) {
      buffer = `${buffer} ${text}`;
    } else {
      blocks.push(buffer);
      buffer = text;
    }
  }
  if (buffer) blocks.push(buffer);

  const reconstructed = blocks.join('\n\n');
  const newParagraphs = segmentParagraphs(reconstructed);

  // Identical? Compare normalized whitespace, length-aware.
  const oldNormalized = oldRows.map((r) => r.text.trim().replace(/\s+/g, ' '));
  const newNormalized = newParagraphs.map((p) => p.trim().replace(/\s+/g, ' '));
  const identical =
    oldNormalized.length === newNormalized.length &&
    oldNormalized.every((t, i) => t === newNormalized[i]);

  return {
    chapter,
    oldCount: oldRows.length,
    newCount: newParagraphs.length,
    identical,
    newParagraphs,
  };
}

async function applyChapter(plan: ChapterPlan): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DELETE FROM paragraphs WHERE chapter_id = $1`, [plan.chapter.id]);

    for (let i = 0; i < plan.newParagraphs.length; i++) {
      const text = plan.newParagraphs[i];
      await client.query(
        `INSERT INTO paragraphs (chapter_id, paragraph_index, text, word_count, audio_status)
         VALUES ($1, $2, $3, $4, 'none')`,
        [plan.chapter.id, i, text, countWords(text)]
      );
    }

    // Reset chapter TTS state — paragraph_id changed, so audio is invalid.
    await client.query(
      `UPDATE chapters
          SET tts_status       = 'none',
              tts_progress     = 0,
              tts_started_at   = NULL,
              tts_completed_at = NULL,
              has_tts          = FALSE,
              word_count       = $2
        WHERE id = $1`,
      [
        plan.chapter.id,
        plan.newParagraphs.reduce((sum, p) => sum + countWords(p), 0),
      ]
    );

    // Reset reader progress on this ebook — paragraph indices shifted.
    await client.query(
      `UPDATE user_reading_progress
          SET current_paragraph_index = 0
        WHERE ebook_id = $1 AND current_chapter = $2`,
      [plan.chapter.ebook_id, plan.chapter.chapter_index]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = parseArgs();

  console.log(`Mode: ${args.apply ? 'APPLY (will mutate DB)' : 'DRY-RUN (no DB writes)'}`);
  console.log(`Scope: ${args.scope}${args.ebookId ? ` ebook=${args.ebookId}` : ''}${
    args.chapterId ? ` chapter=${args.chapterId}` : ''
  }`);

  const chapters = await selectChapters(args);
  console.log(`Chapters to process: ${chapters.length}\n`);

  let totalChanged = 0;
  let totalUnchanged = 0;
  let totalOldRows = 0;
  let totalNewRows = 0;

  for (const ch of chapters) {
    const plan = await planChapter(ch);
    totalOldRows += plan.oldCount;
    totalNewRows += plan.newCount;

    const tag = plan.identical ? 'unchanged' : `re-split: ${plan.oldCount} → ${plan.newCount}`;
    const titleStr = plan.chapter.title ? ` "${plan.chapter.title}"` : '';
    console.log(
      `  [${plan.chapter.chapter_index}] ${plan.chapter.id}${titleStr} — ${tag}`
    );

    if (plan.identical) {
      totalUnchanged++;
      continue;
    }

    totalChanged++;

    if (args.apply) {
      try {
        await applyChapter(plan);
      } catch (err) {
        console.error(`    ❌ apply failed for chapter ${plan.chapter.id}:`, err);
      }
    }
  }

  console.log('\n──────────── Summary ────────────');
  console.log(`Chapters changed:    ${totalChanged}`);
  console.log(`Chapters unchanged:  ${totalUnchanged}`);
  console.log(`Old paragraph rows:  ${totalOldRows}`);
  console.log(`New paragraph rows:  ${totalNewRows}`);
  console.log(
    args.apply
      ? '✅ Applied to DB. Affected chapters: TTS reset, reader progress reset to paragraph 0.'
      : 'ℹ️  Dry-run only. Re-run with --apply to mutate the DB.'
  );

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
