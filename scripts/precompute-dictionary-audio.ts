/**
 * Precompute Google TTS audio for every dictionary entry (US + UK).
 *
 * Usage:
 *   npm run precompute-audio -- --dry-run    # estimate cost, no API calls
 *   npm run precompute-audio                 # run (skips entries that already have audio)
 *   npm run precompute-audio -- --resume     # alias for above — resume is automatic via DB
 *
 * Parallelism: p-limit(8) → 8 entries × 2 accents = up to 16 concurrent Google TTS calls.
 * Rate limit: each 429 response is retried up to 3 times with exponential backoff (2s, 4s, 8s).
 * Resume: entries with both audio_us_url and audio_uk_url already set are skipped automatically.
 * Aborts if total errors reach MAX_ERRORS to prevent burning quota on a misconfig.
 */
import 'dotenv/config';
import pool from '../config/db';
import pLimit from 'p-limit';
import { generateAudio, type GenerateAudioInput } from '../services/ttsService';

const CONCURRENCY = 8;             // 8 entries × 2 accents = 16 concurrent calls — stays under Google's per-minute quota
const BATCH_SIZE = 100;
const MAX_ERRORS = 20;
const MAX_RETRIES = 3;             // retry up to 3 times on 429
const GOOGLE_TTS_USD_PER_MILLION = 16; // Neural2 voice pricing

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function generateAudioWithRetry(input: GenerateAudioInput): ReturnType<typeof generateAudio> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await generateAudio(input);
    } catch (err: any) {
      const is429 = err?.message?.includes('429');
      if (is429 && attempt < MAX_RETRIES) {
        const waitMs = 1000 * Math.pow(2, attempt + 1); // 2s, 4s, 8s
        console.warn(`[retry] 429 rate limit for "${input.text}" (${input.accent}) — waiting ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

function estimateCostUsd(totalChars: number): string {
  return ((totalChars * GOOGLE_TTS_USD_PER_MILLION) / 1_000_000).toFixed(4);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const resume = process.argv.includes('--resume');

  if (dryRun) console.log('[dry-run] No API calls or DB updates will be made.\n');
  if (resume) console.log('[resume] Auto-resuming via DB state (entries with existing audio are skipped).\n');

  // Count stats upfront.
  const { rows: countRows } = await pool.query<{ total: number; has_audio: number }>(`
    SELECT
      COUNT(*)::int                                                               AS total,
      COUNT(*) FILTER (WHERE audio_us_url IS NOT NULL AND audio_uk_url IS NOT NULL)::int AS has_audio
    FROM dictionary_entries
  `);
  const { total, has_audio } = countRows[0];
  const missing = total - has_audio;

  console.log(`Total entries : ${total}`);
  console.log(`Has audio     : ${has_audio}`);
  console.log(`Missing audio : ${missing}`);
  console.log(`Concurrency   : ${CONCURRENCY} entries × 2 accents\n`);

  if (missing === 0) {
    console.log('All entries already have audio. Nothing to do.');
    return;
  }

  const limit = pLimit(CONCURRENCY);

  let completed = 0;
  let skipped = 0;
  let failedCount = 0;
  let totalChars = 0;
  let aborted = false;
  let lastId = '00000000-0000-0000-0000-000000000000';

  while (!aborted) {
    const { rows: entries } = await pool.query<{
      id: string;
      headword: string;
      audio_us_url: string | null;
      audio_uk_url: string | null;
    }>(
      `SELECT id, headword, audio_us_url, audio_uk_url
         FROM dictionary_entries
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [lastId, BATCH_SIZE]
    );

    if (entries.length === 0) break;

    await Promise.all(
      entries.map((entry) =>
        limit(async () => {
          if (aborted) return;

          // Skip entries that already have both audio URLs (resume behaviour).
          if (entry.audio_us_url && entry.audio_uk_url) {
            skipped++;
            return;
          }

          try {
            if (!dryRun) {
              // Generate US + UK in parallel for each entry.
              const [us, uk] = await Promise.all([
                generateAudioWithRetry({
                  text: entry.headword,
                  accent: 'us',
                  source_type: 'dictionary_headword',
                  source_id: entry.id,
                }),
                generateAudioWithRetry({
                  text: entry.headword,
                  accent: 'uk',
                  source_type: 'dictionary_headword',
                  source_id: entry.id,
                }),
              ]);

              await pool.query(
                `UPDATE dictionary_entries
                    SET audio_us_url = $1,
                        audio_uk_url = $2
                  WHERE id = $3`,
                [us.audio_url, uk.audio_url, entry.id]
              );
            }

            completed++;
            totalChars += entry.headword.length * 2; // us + uk

            if (completed % 50 === 0) {
              console.log(
                `Progress: ${completed + skipped}/${total} | Done: ${completed} | Skipped: ${skipped} | Failed: ${failedCount} | Est cost: $${estimateCostUsd(totalChars)}${dryRun ? ' [dry-run]' : ''}`
              );
            }
          } catch (err: any) {
            failedCount++;
            console.error(
              `[fail] entry ${entry.id} (${entry.headword}): ${err?.message ?? String(err)}`
            );
            if (failedCount >= MAX_ERRORS) {
              aborted = true;
              console.error(
                `[abort] ${MAX_ERRORS} errors reached — stopping. Fix the issue then re-run (already-processed entries will be skipped).`
              );
            }
          }
        })
      )
    );

    lastId = entries[entries.length - 1].id;
  }

  console.log(
    `\n${aborted ? '[ABORTED]' : '[Done]'} Completed: ${completed} | Skipped: ${skipped} | Failed: ${failedCount} | Est cost: $${estimateCostUsd(totalChars)}${dryRun ? ' [dry-run]' : ''}`
  );
}

main()
  .catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
  })
  .finally(() => pool.end());
