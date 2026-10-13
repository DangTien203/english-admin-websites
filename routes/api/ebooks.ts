import { Router, Response } from 'express';
import pool from '../../config/db';
import { ApiRequest } from '../../middlewares/apiAuth';
import { requireFeature } from '../../middlewares/requireFeature';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { s, n, b, a } from '../../utils/safeResponse';
import { parsePagination } from '../../utils/pagination';
import { getActiveSubscription } from '../../utils/subscriptionHelper';
import { translateText } from '../../services/translationService';
import { normalizeWord } from '../../services/wordTranslationService';
import { getWordLookupService } from '../../services/lookup';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_TIER: Record<string, number> = { free: 0, premium: 1, pro: 2 };

async function getUserPlanTier(userId: string): Promise<number> {
  const sub = await getActiveSubscription(userId);
  if (!sub) return PLAN_TIER.free;
  const name = String(sub.plan_name ?? '').toLowerCase();
  if (name.includes('pro')) return PLAN_TIER.pro;
  if (name.includes('premium')) return PLAN_TIER.premium;
  return PLAN_TIER.free;
}

const FULL_ENTRY_SQL = `
  SELECT e.*,
    (SELECT json_agg(
       json_build_object(
         'id', s.id, 'pos', s.pos, 'sense_order', s.sense_order,
         'definition_en', s.definition_en, 'definition_vi', s.definition_vi,
         'register', s.register, 'domain', s.domain,
         'grammar_note', s.grammar_note, 'usage_note', s.usage_note, 'region', s.region,
         'examples', (SELECT json_agg(
             json_build_object('example_en', ex.example_en, 'example_vi', ex.example_vi, 'source', ex.source)
             ORDER BY ex.sort_order
           ) FROM sense_examples ex WHERE ex.sense_id = s.id),
         'synonyms', (SELECT json_agg(ss.synonym_text) FROM sense_synonyms ss WHERE ss.sense_id = s.id),
         'antonyms', (SELECT json_agg(sa.antonym_text) FROM sense_antonyms sa WHERE sa.sense_id = s.id)
       ) ORDER BY s.sense_order
     ) FROM entry_senses s WHERE s.entry_id = e.id) AS senses,
    (SELECT json_agg(
       json_build_object(
         'id', wf.id, 'form_type', wf.form_type, 'form_value', wf.form_value,
         'ipa', wf.ipa, 'audio_url', wf.audio_url, 'tags', wf.tags
       ) ORDER BY wf.sort_order
     ) FROM word_forms wf WHERE wf.entry_id = e.id) AS word_forms,
    (SELECT json_agg(
       json_build_object(
         'id', pv.id, 'phrasal_verb', pv.phrasal_verb, 'particle', pv.particle,
         'is_separable', pv.is_separable, 'definition_en', pv.definition_en,
         'definition_vi', pv.definition_vi, 'example_en', pv.example_en, 'example_vi', pv.example_vi
       )
     ) FROM phrasal_verbs pv WHERE pv.entry_id = e.id) AS phrasal_verbs,
    (SELECT json_agg(
       json_build_object(
         'id', idi.id, 'idiom_text', idi.idiom_text,
         'definition_en', idi.definition_en, 'definition_vi', idi.definition_vi,
         'example_en', idi.example_en, 'example_vi', idi.example_vi, 'register', idi.register
       )
     ) FROM entry_idioms idi WHERE idi.entry_id = e.id) AS idioms,
    (SELECT json_agg(
       json_build_object(
         'id', col.id, 'sense_id', col.sense_id, 'collocation', col.collocation,
         'pattern', col.pattern, 'example_en', col.example_en, 'example_vi', col.example_vi,
         'frequency', col.frequency
       )
     ) FROM collocations col WHERE col.entry_id = e.id) AS collocations,
    (SELECT json_agg(t.name ORDER BY t.name)
     FROM entry_tags et JOIN tags t ON t.id = et.tag_id
     WHERE et.entry_id = e.id) AS tags,
    (SELECT json_build_object(
       'family_root', wf.family_root,
       'members', (SELECT json_agg(
          json_build_object('entry_id', m.entry_id, 'headword', de.headword, 'relation', m.relation)
        ) FROM word_family_members m
          JOIN dictionary_entries de ON de.id = m.entry_id
          WHERE m.family_id = wf.id AND m.entry_id != e.id)
     )
     FROM word_family_members wfm
     JOIN word_families wf ON wf.id = wfm.family_id
     WHERE wfm.entry_id = e.id
     LIMIT 1) AS word_family
  FROM dictionary_entries e
`;

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/reading-stats — MUST be before /:id
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/reading-stats',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;

    const [timeRows, booksRows, lookupRows, topBooksRows, topWordsRows, streakRows] =
      await Promise.all([
        // Total reading time
        pool.query<{ total_time_minutes: number }>(
          `SELECT COALESCE(SUM(total_time_sec), 0)::float / 60 AS total_time_minutes
           FROM user_reading_progress WHERE user_id = $1`,
          [userId]
        ),
        // Finished vs in-progress
        pool.query<{ books_finished: number; books_in_progress: number }>(
          `SELECT
             COUNT(*) FILTER (WHERE progress >= 1)::int        AS books_finished,
             COUNT(*) FILTER (WHERE progress > 0 AND progress < 1)::int AS books_in_progress
           FROM user_reading_progress WHERE user_id = $1`,
          [userId]
        ),
        // Total word lookups
        pool.query<{ words_looked_up: number }>(
          `SELECT COUNT(*)::int AS words_looked_up
           FROM word_lookups WHERE user_id = $1 AND source = 'ebook'`,
          [userId]
        ),
        // Top 5 books by time spent
        pool.query(
          `SELECT e.id AS ebook_id, e.title, e.cover_url,
                  urp.progress, urp.total_time_sec
           FROM user_reading_progress urp
           JOIN ebooks e ON e.id = urp.ebook_id
           WHERE urp.user_id = $1 AND urp.total_time_sec > 0
           ORDER BY urp.total_time_sec DESC
           LIMIT 5`,
          [userId]
        ),
        // Top 5 most looked-up words
        pool.query(
          `SELECT de.headword, COUNT(*)::int AS lookup_count
           FROM word_lookups wl
           JOIN dictionary_entries de ON de.id = wl.entry_id
           WHERE wl.user_id = $1 AND wl.source = 'ebook'
           GROUP BY de.headword
           ORDER BY lookup_count DESC
           LIMIT 5`,
          [userId]
        ),
        // Reading streak (distinct active days)
        pool.query<{ days_streak: number }>(
          `SELECT COUNT(DISTINCT DATE(last_read_at))::int AS days_streak
           FROM user_reading_progress
           WHERE user_id = $1 AND last_read_at >= NOW() - INTERVAL '30 days'`,
          [userId]
        ),
      ]);

    return apiSuccess(res, {
      total_time_minutes: Math.round(timeRows.rows[0]?.total_time_minutes ?? 0),
      books_finished: booksRows.rows[0]?.books_finished ?? 0,
      books_in_progress: booksRows.rows[0]?.books_in_progress ?? 0,
      words_looked_up: lookupRows.rows[0]?.words_looked_up ?? 0,
      top_books: topBooksRows.rows.map((r: any) => ({
        ebook_id: r.ebook_id,
        title: r.title,
        cover_url: r.cover_url ?? null,
        progress: r.progress,
        total_time_sec: r.total_time_sec,
      })),
      top_looked_up_words: topWordsRows.rows.map((r: any) => ({
        headword: r.headword,
        lookup_count: r.lookup_count,
      })),
      days_streak: streakRows.rows[0]?.days_streak ?? 0,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks — list published ebooks
//  query: search, filter=reading|finished|favorites, genre, level, page, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { page, limit, offset } = parsePagination(req);
    const filter = req.query.filter ? String(req.query.filter) : null;
    const genre  = req.query.genre  ? String(req.query.genre)  : null;
    const level  = req.query.level  ? String(req.query.level)  : null;

    // Search: free-text against title + author (ILIKE, case-insensitive).
    // Empty/whitespace → no search filter. Escape SQL LIKE wildcards (% _ \) so
    // a user typing "100%" doesn't accidentally match everything.
    const searchRaw = req.query.search ? String(req.query.search).trim() : '';
    const search = searchRaw.length > 0
      ? `%${searchRaw.replace(/[\\%_]/g, '\\$&')}%`
      : null;

    // ── Generic column filters (no userId dependency in WHERE) ────────────────
    // Each entry: condition template with $IDX replaced per-query, and value.
    const colFilters: Array<{ tpl: string; value: unknown }> = [];
    if (genre)  colFilters.push({ tpl: `$IDX = ANY(e.genre)`, value: genre });
    if (level)  colFilters.push({ tpl: `e.level = $IDX`,      value: level });
    if (search) colFilters.push({
      tpl: `(e.title ILIKE $IDX ESCAPE '\\' OR e.author ILIKE $IDX ESCAPE '\\')`,
      value: search,
    });

    // ── Items query ───────────────────────────────────────────────────────────
    // $1 = userId (LEFT JOIN conditions), filter params start at $2.
    const itemsParams: unknown[] = [userId];
    const itemsConditions: string[] = ["e.status = 'published'"];

    for (const f of colFilters) {
      itemsParams.push(f.value);
      // Use replaceAll-style regex — search tpl repeats $IDX (title + author).
      itemsConditions.push(f.tpl.replace(/\$IDX/g, `$${itemsParams.length}`));
    }

    if (filter === 'favorites') {
      itemsConditions.push('f.user_id IS NOT NULL');
    } else if (filter === 'reading') {
      itemsConditions.push('urp.user_id IS NOT NULL AND urp.progress > 0 AND urp.progress < 1');
    } else if (filter === 'finished') {
      itemsConditions.push('urp.progress >= 1');
    }

    itemsParams.push(limit, offset);
    const limitPh  = `$${itemsParams.length - 1}`;
    const offsetPh = `$${itemsParams.length}`;

    const itemsQuery = `
      SELECT e.id, e.title, e.author, e.cover_url, e.level, e.required_plan,
             e.total_chapters, e.total_words,
             COALESCE(urp.progress, 0) AS progress,
             urp.current_paragraph_index,
             (f.user_id IS NOT NULL)   AS is_favorite
      FROM ebooks e
      LEFT JOIN user_reading_progress urp ON urp.ebook_id = e.id AND urp.user_id = $1
      LEFT JOIN user_ebook_favorites  f   ON f.ebook_id  = e.id AND f.user_id  = $1
      WHERE ${itemsConditions.join(' AND ')}
      ORDER BY e.created_at DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}`;

    // ── Count query ───────────────────────────────────────────────────────────
    // For no-filter case: no userId needed → pass only colFilter params.
    // For user-filter cases: userId = $1, colFilter params shifted to $2, $3…
    const baseWhere = `e.status = 'published'`;

    // col filter conditions without userId ($1, $2, … for count-only context)
    const countOnlyParams: unknown[] = [];
    const countOnlyConditions = colFilters.map((f) => {
      countOnlyParams.push(f.value);
      return f.tpl.replace(/\$IDX/g, `$${countOnlyParams.length}`);
    });

    // col filter conditions shifted by +1 (when userId occupies $1)
    const countShiftedConditions = colFilters.map((f, i) =>
      f.tpl.replace(/\$IDX/g, `$${i + 2}`)
    );

    let countQuery: string;
    let countParams: unknown[];

    if (filter === 'favorites') {
      countQuery = `
        SELECT COUNT(*)::int AS total
        FROM user_ebook_favorites fav
        JOIN ebooks e ON e.id = fav.ebook_id
        WHERE fav.user_id = $1
          AND ${[baseWhere, ...countShiftedConditions].join(' AND ')}`;
      countParams = [userId, ...countOnlyParams];
    } else if (filter === 'reading') {
      countQuery = `
        SELECT COUNT(*)::int AS total
        FROM user_reading_progress urp
        JOIN ebooks e ON e.id = urp.ebook_id
        WHERE urp.user_id = $1
          AND urp.progress > 0 AND urp.progress < 1
          AND ${[baseWhere, ...countShiftedConditions].join(' AND ')}`;
      countParams = [userId, ...countOnlyParams];
    } else if (filter === 'finished') {
      countQuery = `
        SELECT COUNT(*)::int AS total
        FROM user_reading_progress urp
        JOIN ebooks e ON e.id = urp.ebook_id
        WHERE urp.user_id = $1
          AND urp.progress >= 1
          AND ${[baseWhere, ...countShiftedConditions].join(' AND ')}`;
      countParams = [userId, ...countOnlyParams];
    } else {
      countQuery = `
        SELECT COUNT(*)::int AS total
        FROM ebooks e
        WHERE ${[baseWhere, ...countOnlyConditions].join(' AND ')}`;
      countParams = countOnlyParams; // may be empty [] — that's fine
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[DEBUG ebooks list] itemsQuery:', itemsQuery.trim());
      console.log('[DEBUG ebooks list] itemsParams:', itemsParams);
      console.log('[DEBUG ebooks list] countQuery:', countQuery.trim());
      console.log('[DEBUG ebooks list] countParams:', countParams);
    }

    const [dataRows, countRows] = await Promise.all([
      pool.query(itemsQuery, itemsParams),
      pool.query(countQuery, countParams),
    ]);

    return apiSuccess(res, {
      items: dataRows.rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        cover_url: r.cover_url ?? null,
        level: r.level,
        required_plan: r.required_plan,
        total_chapters: r.total_chapters,
        total_words: r.total_words,
        progress: r.progress,
        current_paragraph_index: r.current_paragraph_index ?? null,
        is_favorite: r.is_favorite,
      })),
      total: countRows.rows[0]?.total ?? 0,
      page,
      limit,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/:id — ebook detail + chapters + lock status
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const ebookId = req.params.id;

    const [ebookRows, chaptersRows, progressRows, favoriteRows] = await Promise.all([
      pool.query(
        `SELECT id, title, author, isbn, description, cover_url,
                level, genre, required_plan,
                COALESCE(total_chapters, 0) AS total_chapters,
                COALESCE(total_words, 0)    AS total_words,
                tts_voice, tts_speed, status, created_at
         FROM ebooks WHERE id = $1 AND status = 'published'`,
        [ebookId]
      ),
      pool.query(
        `SELECT id, chapter_index, title,
                COALESCE(word_count, 0) AS word_count,
                has_tts
         FROM chapters WHERE ebook_id = $1 ORDER BY chapter_index ASC`,
        [ebookId]
      ),
      pool.query(
        `SELECT COALESCE(progress, 0)         AS progress,
                current_paragraph_index,
                COALESCE(total_time_sec, 0)   AS total_time_sec,
                COALESCE(words_looked_up, 0)  AS words_looked_up,
                started_at,
                last_read_at
         FROM user_reading_progress WHERE user_id = $1 AND ebook_id = $2`,
        [userId, ebookId]
      ),
      pool.query(
        `SELECT 1 FROM user_ebook_favorites WHERE ebook_id = $1 AND user_id = $2`,
        [ebookId, userId]
      ),
    ]);

    if (ebookRows.rows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Ebook không tồn tại');
    }

    const ebook = ebookRows.rows[0];
    const requiredTier = PLAN_TIER[ebook.required_plan] ?? 0;
    const userTier = await getUserPlanTier(userId);
    const locked = userTier < requiredTier;

    const chapters = chaptersRows.rows.map((c: any) => ({
      id: c.id,
      index: c.chapter_index,       // mobile expects 'index', not 'chapter_index'
      title: c.title,
      word_count: c.word_count as number,
      duration_ms: null,            // TTS not implemented yet (Phase 12)
    }));

    const prog = progressRows.rows[0] ?? null;
    const is_favorite = favoriteRows.rows.length > 0;

    // Always return reading_progress as object (never null) so mobile can safely
    // access numeric fields without null-check on the object itself.
    const reading_progress = {
      current_paragraph_index: prog?.current_paragraph_index ?? null,
      progress:        prog ? (prog.progress as number)       : 0,
      total_time_sec:  prog ? (prog.total_time_sec as number) : 0,
      words_looked_up: prog ? (prog.words_looked_up as number): 0,
      started_at:      prog?.started_at   ?? null,
      last_read_at:    prog?.last_read_at ?? null,
      finished_at:     null,   // column not in schema yet (Phase 12)
    };

    const payload: Record<string, unknown> = {
      id: ebook.id,
      title: ebook.title,
      author: ebook.author,
      isbn: ebook.isbn ?? null,
      description: ebook.description ?? null,
      cover_url: ebook.cover_url ?? null,
      level: ebook.level,
      genre: ebook.genre ?? [],
      required_plan: ebook.required_plan,
      total_chapters: ebook.total_chapters as number,
      total_words: ebook.total_words as number,
      tts_voice: ebook.tts_voice ?? null,
      tts_speed: ebook.tts_speed ?? 1.0,
      created_at: ebook.created_at,
      chapters,
      reading_progress,
      is_favorite,
    };

    if (locked) {
      payload.locked = true;
      payload.locked_reason = 'UPGRADE_REQUIRED';
      const firstChapter = chapters.find((c: any) => c.index === 0);
      payload.preview_chapter_ids = firstChapter ? [firstChapter.id] : [];
    }

    return apiSuccess(res, payload);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/:id/chapters/:chapter_id
//
//  Response shape (snake_case JSON, contract field name is `index` — not
//  `chapter_index` / `paragraph_index`; those are DB column names only):
//    {
//      chapter:    { id, index, title, word_count, tts_status, tts_progress },
//      paragraphs: [{ id, index, text, word_count, translation_vi,
//                     audio_url, audio_status, duration_ms }, ...],
//      progress:   { current_paragraph_index, total_time_sec }
//    }
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id/chapters/:chapter_id',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { id: ebookId, chapter_id: chapterId } = req.params;

    // Fetch ebook + chapter in parallel
    const [ebookRows, chapterRows] = await Promise.all([
      pool.query(
        `SELECT id, required_plan, status FROM ebooks WHERE id = $1`,
        [ebookId]
      ),
      pool.query(
        `SELECT id, chapter_index, title, word_count,
                COALESCE(tts_status, 'none') AS tts_status,
                COALESCE(tts_progress, 0)    AS tts_progress
         FROM chapters WHERE id = $1 AND ebook_id = $2`,
        [chapterId, ebookId]
      ),
    ]);

    if (ebookRows.rows.length === 0 || ebookRows.rows[0].status !== 'published') {
      return apiError(res, 404, 'NOT_FOUND', 'Ebook không tồn tại');
    }
    if (chapterRows.rows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Chapter không tồn tại');
    }

    const ebook = ebookRows.rows[0];
    const chapter = chapterRows.rows[0];

    // Access check: non-free ebook → only chapter_index 0 is free preview
    const requiredTier = PLAN_TIER[ebook.required_plan] ?? 0;
    const userTier = await getUserPlanTier(userId);

    if (userTier < requiredTier && chapter.chapter_index > 0) {
      return apiError(
        res, 403, 'FEATURE_NOT_AVAILABLE',
        'Upgrade required to read this chapter'
      );
    }

    const [paragraphRows, progressRows] = await Promise.all([
      pool.query(
        `SELECT id, paragraph_index, text, word_count, translation_vi,
                audio_url,
                COALESCE(audio_status, 'none') AS audio_status,
                duration_ms
         FROM paragraphs WHERE chapter_id = $1
         ORDER BY paragraph_index ASC`,
        [chapterId]
      ),
      pool.query(
        `SELECT current_paragraph_index, total_time_sec
         FROM user_reading_progress WHERE ebook_id = $1 AND user_id = $2`,
        [ebookId, userId]
      ),
    ]);

    // Update last_read_at (fire-and-forget)
    void pool.query(
      `INSERT INTO user_reading_progress (user_id, ebook_id, last_read_at, started_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id, ebook_id) DO UPDATE SET last_read_at = NOW()`,
      [userId, ebookId]
    ).catch((err) => console.error('[ebooks] last_read_at update failed:', err));

    const progressRow = progressRows.rows[0] ?? {};

    return apiSuccess(res, {
      chapter: {
        id: s(chapter.id),
        index: n(chapter.chapter_index),
        title: s(chapter.title),
        word_count: n(chapter.word_count),
        tts_status: s(chapter.tts_status) || 'none',
        tts_progress: n(chapter.tts_progress),
      },
      paragraphs: paragraphRows.rows.map((p: any) => ({
        id: s(p.id),
        index: n(p.paragraph_index),
        text: s(p.text),
        word_count: n(p.word_count),
        translation_vi: s(p.translation_vi),
        audio_url: p.audio_url ?? null,
        audio_status: s(p.audio_status) || 'none',
        duration_ms: n(p.duration_ms),
      })),
      progress: {
        current_paragraph_index: n(progressRow.current_paragraph_index),
        total_time_sec: n(progressRow.total_time_sec),
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/ebooks/:id/chapters/:chapter_id/audio-playlist
//
//  Optimized for continuous audio playback. Returns only paragraphs whose audio
//  is ready, plus aggregate playlist metadata. Mobile decides UX based on
//  `is_fully_ready` and `playable_paragraphs_count`.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id/chapters/:chapter_id/audio-playlist',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { id: ebookId, chapter_id: chapterId } = req.params;

    const [ebookRows, chapterRows] = await Promise.all([
      pool.query(
        `SELECT id, required_plan, status FROM ebooks WHERE id = $1`,
        [ebookId]
      ),
      pool.query(
        `SELECT id, chapter_index, title
         FROM chapters WHERE id = $1 AND ebook_id = $2`,
        [chapterId, ebookId]
      ),
    ]);

    if (ebookRows.rows.length === 0 || ebookRows.rows[0].status !== 'published') {
      return apiError(res, 404, 'NOT_FOUND', 'Ebook không tồn tại');
    }
    if (chapterRows.rows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Chapter không tồn tại');
    }

    const ebook = ebookRows.rows[0];
    const chapter = chapterRows.rows[0];

    // Access check: same rule as chapter detail — preview chapter is free.
    const requiredTier = PLAN_TIER[ebook.required_plan] ?? 0;
    const userTier = await getUserPlanTier(userId);
    if (userTier < requiredTier && chapter.chapter_index > 0) {
      return apiError(
        res, 403, 'FEATURE_NOT_AVAILABLE',
        'Upgrade required to listen to this chapter'
      );
    }

    const [totalRows, playableRows] = await Promise.all([
      pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
           FROM paragraphs WHERE chapter_id = $1`,
        [chapterId]
      ),
      pool.query(
        `SELECT id, paragraph_index, text, audio_url, duration_ms
           FROM paragraphs
          WHERE chapter_id = $1
            AND audio_status = 'ready'
            AND audio_url IS NOT NULL
            AND audio_url <> ''
          ORDER BY paragraph_index ASC`,
        [chapterId]
      ),
    ]);

    const totalParagraphs = n(totalRows.rows[0]?.total);
    const playableCount = playableRows.rows.length;
    const totalDurationMs = playableRows.rows.reduce(
      (sum: number, row: any) => sum + n(row.duration_ms),
      0
    );

    const playlist = a<any>(playableRows.rows).map((p: any) => ({
      paragraph_id: s(p.id),
      paragraph_index: n(p.paragraph_index),
      audio_url: s(p.audio_url),
      duration_ms: n(p.duration_ms),
      text_preview: s(p.text).slice(0, 100),
    }));

    return apiSuccess(res, {
      chapter_id: s(chapter.id),
      chapter_title: s(chapter.title),
      total_paragraphs_in_chapter: totalParagraphs,
      playable_paragraphs_count: n(playableCount),
      is_fully_ready: b(totalParagraphs > 0 && playableCount === totalParagraphs),
      total_duration_ms: n(totalDurationMs),
      playlist,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/ebooks/:id/chapters/:chapter_id/progress
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/chapters/:chapter_id/progress',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const { id: ebookId, chapter_id: chapterId } = req.params;
    const { current_paragraph_index, time_spent_sec } = req.body as {
      current_paragraph_index: number;
      time_spent_sec?: number;
    };

    if (typeof current_paragraph_index !== 'number' || current_paragraph_index < 0) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'current_paragraph_index phải là số nguyên >= 0');
    }

    // Verify chapter belongs to ebook
    const { rows: chRows } = await pool.query(
      `SELECT chapter_index FROM chapters WHERE id = $1 AND ebook_id = $2`,
      [chapterId, ebookId]
    );
    if (chRows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Chapter không tồn tại');
    }

    // Get total paragraphs to compute progress ratio
    const [totalParaRows, totalChapRows] = await Promise.all([
      pool.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM paragraphs WHERE chapter_id = $1`,
        [chapterId]
      ),
      pool.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM chapters WHERE ebook_id = $1`,
        [ebookId]
      ),
    ]);

    const totalParagraphs = totalParaRows.rows[0]?.cnt ?? 1;
    const totalChapters = totalChapRows.rows[0]?.cnt ?? 1;
    const chapterIndex = chRows[0].chapter_index as number;

    // Progress = (completed chapters + fractional current chapter) / total chapters
    const paraFraction = Math.min(1, (current_paragraph_index + 1) / totalParagraphs);
    const progress = Math.min(1, (chapterIndex + paraFraction) / totalChapters);

    await pool.query(
      `INSERT INTO user_reading_progress
         (user_id, ebook_id, current_chapter, current_paragraph_index, progress,
          total_time_sec, last_read_at, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id, ebook_id) DO UPDATE SET
         current_chapter          = EXCLUDED.current_chapter,
         current_paragraph_index  = EXCLUDED.current_paragraph_index,
         progress                 = GREATEST(user_reading_progress.progress, EXCLUDED.progress),
         total_time_sec           = user_reading_progress.total_time_sec + $6,
         last_read_at             = NOW()`,
      [userId, ebookId, chapterIndex, current_paragraph_index, progress, time_spent_sec ?? 0]
    );

    return res.status(204).send();
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/ebooks/:id/lookup
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/lookup',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const ebookId = req.params.id;
    const { word, paragraph_id } = req.body as { word: string; paragraph_id?: string };

    if (!word || typeof word !== 'string') {
      return apiError(res, 400, 'INVALID_WORD', 'word là bắt buộc');
    }

    // Normalize: strip surrounding punctuation, validate, lowercase for cache key.
    const normalized = normalizeWord(word);
    if (!normalized.isValid) {
      return apiError(res, 400, 'INVALID_WORD', `Invalid word: ${normalized.reason}`);
    }

    // Verify paragraph belongs to this ebook (optional context validation).
    let verifiedParagraphId: string | null = null;
    if (paragraph_id) {
      const { rows: pRows } = await pool.query(
        `SELECT p.id FROM paragraphs p
         JOIN chapters c ON c.id = p.chapter_id
         WHERE p.id = $1 AND c.ebook_id = $2`,
        [paragraph_id, ebookId]
      );
      verifiedParagraphId = pRows.length > 0 ? paragraph_id : null;
    }

    const lookupContext = {
      source: 'ebook' as const,
      ebook_id: ebookId,
      paragraph_id: verifiedParagraphId,
    };

    // Fire-and-forget: bump words_looked_up counter regardless of dict/translation path.
    void pool.query(
      `INSERT INTO user_reading_progress (user_id, ebook_id, words_looked_up, started_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, ebook_id) DO UPDATE SET
         words_looked_up = user_reading_progress.words_looked_up + 1`,
      [userId, ebookId]
    ).catch((err) => console.error('[ebooks] words_looked_up update failed:', err));

    // F4–F12 live in services/lookup (docs/lookup-spec.md §5): local dictionary (headword, lemma,
    // word_forms, local inflections) → fallback flag → per-user limit → Google + Free Dictionary → merge.
    const result = await getWordLookupService().lookup({
      userId,
      ebookId: String(ebookId),
      paragraphId: verifiedParagraphId,
      word: { normalized: normalized.normalized, display: normalized.display },
    });

    switch (result.kind) {
      case 'dictionary':
        // Flat shape with `source` discriminator at top level (no entry wrapper).
        // Note: spread entry first then assign `source` so the discriminator wins
        // over the dictionary entry's own `source` column ('manual', 'oxford', ...).
        return apiSuccess(res, {
          ...result.entry,
          source: 'dictionary',
          ...(result.matchedForm ? { matched_form: result.matchedForm } : {}),
          lookup_context: lookupContext,
        });

      case 'temporary':
        // A temporary result must never be cached by a proxy or the client (spec §4.4).
        res.set('Cache-Control', 'no-store');
        return apiSuccess(res, { ...result.body, lookup_context: lookupContext });

      case 'rate_limited':
        res.set('Cache-Control', 'no-store');
        res.set('Retry-After', String(result.retryAfterSeconds));
        return apiError(res, 429, 'LOOKUP_RATE_LIMITED', 'Bạn tra từ quá nhanh. Vui lòng thử lại sau ít giây.');

      case 'unavailable':
        res.set('Cache-Control', 'no-store');
        return apiError(
          res,
          503,
          'TRANSLATION_UNAVAILABLE',
          'Cannot translate this word right now. Please try again later.'
        );

      case 'not_found':
      default:
        res.set('Cache-Control', 'no-store');
        return apiError(res, 404, 'ENTRY_NOT_FOUND', `Không tìm thấy từ "${normalized.display}" trong từ điển`);
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/ebooks/:id/translate-paragraph
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/translate-paragraph',
  requireFeature('translation_daily'),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const ebookId = req.params.id;
    const { paragraph_id } = req.body as { paragraph_id: string };

    if (!paragraph_id || typeof paragraph_id !== 'string') {
      return apiError(res, 400, 'VALIDATION_ERROR', 'paragraph_id là bắt buộc');
    }

    // Verify paragraph belongs to ebook
    const { rows: pRows } = await pool.query(
      `SELECT p.id, p.text, p.translation_vi
       FROM paragraphs p
       JOIN chapters c ON c.id = p.chapter_id
       WHERE p.id = $1 AND c.ebook_id = $2`,
      [paragraph_id, ebookId]
    );

    if (pRows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Paragraph không tồn tại trong ebook này');
    }

    const para = pRows[0];

    // Precomputed translation already in the row
    if (para.translation_vi) {
      return apiSuccess(res, { translation_vi: para.translation_vi, source: 'precomputed' });
    }

    // Translate via service (checks translation_cache, then Google API)
    const result = await translateText(para.text);

    if (!result.translated_text) {
      return apiSuccess(res, { translation_vi: null, source: 'unavailable' });
    }

    // Persist fresh translation back to paragraph
    if (result.source === 'fresh') {
      void pool.query(
        `UPDATE paragraphs SET translation_vi = $1 WHERE id = $2`,
        [result.translated_text, paragraph_id]
      ).catch((err) => console.error('[ebooks] paragraph translation_vi update failed:', err));
    }

    return apiSuccess(res, { translation_vi: result.translated_text, source: result.source });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/ebooks/:id/favorite
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/favorite',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const ebookId = req.params.id;

    const { rows } = await pool.query(
      `SELECT 1 FROM ebooks WHERE id = $1 AND status = 'published'`,
      [ebookId]
    );
    if (rows.length === 0) {
      return apiError(res, 404, 'NOT_FOUND', 'Ebook không tồn tại');
    }

    await pool.query(
      `INSERT INTO user_ebook_favorites (user_id, ebook_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, ebookId]
    );

    return res.status(201).json({ success: true });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/v1/ebooks/:id/favorite
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/:id/favorite',
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const ebookId = req.params.id;

    await pool.query(
      `DELETE FROM user_ebook_favorites WHERE user_id = $1 AND ebook_id = $2`,
      [userId, ebookId]
    );

    return res.status(204).send();
  })
);

export default router;
