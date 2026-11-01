import { Router, Response } from 'express';
import { z } from 'zod';
import pool from '../../config/db';
import { requireApiAuth, ApiRequest } from '../../middlewares/apiAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { apiSuccess, apiError } from '../../utils/apiResponse';
import { validateBody } from '../../middlewares/validateBody';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface DeckRow {
  id: string;
  deck_type: string;
  user_id: string | null;
  status: string;
}

const loadDeck = async (deckId: string): Promise<DeckRow | null> => {
  const { rows } = await pool.query(
    `SELECT id, deck_type, user_id, status FROM decks WHERE id = $1`,
    [deckId]
  );
  return rows[0] ?? null;
};

// Returns deck row if user can read it; sends 404/403 and returns null otherwise.
const checkDeckForRead = (deck: DeckRow | null, userId: string, res: Response) => {
  if (!deck) {
    apiError(res, 404, 'DECK_NOT_FOUND', 'Deck không tồn tại');
    return null;
  }
  const isPublicDeck =
    deck.status === 'published' &&
    (deck.deck_type === 'premade' || deck.deck_type === 'system_generated');
  const isOwner = deck.deck_type === 'user_created' && deck.user_id === userId;
  if (!isPublicDeck && !isOwner) {
    apiError(res, 403, 'DECK_ACCESS_DENIED', 'Bạn không có quyền truy cập deck này');
    return null;
  }
  return deck;
};

// Returns deck row if user is the owner (user_created); otherwise sends error.
const checkDeckForWrite = (deck: DeckRow | null, userId: string, res: Response) => {
  if (!deck) {
    apiError(res, 404, 'DECK_NOT_FOUND', 'Deck không tồn tại');
    return null;
  }
  if (deck.deck_type !== 'user_created' || deck.user_id !== userId) {
    apiError(res, 403, 'DECK_ACCESS_DENIED', 'Bạn không có quyền thêm/xóa cards trong deck này');
    return null;
  }
  return deck;
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/v1/decks/:deckId/cards
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/decks/:deckId/cards',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const deckId = req.params.deckId as string;

    // Per-user SRS state lives in `leitner_cards` (renamed from "leitner_progress"
    // in user prompt). LEFT JOIN on (user_id, entry_id) — the table's UNIQUE
    // index covers this lookup.
    //
    // Field rename for canonical card shape:
    //   leitner_box_number → leitner_box
    //   leitner_due_at     → due_at
    // Plus new fields surfaced for mobile SRS UI: last_reviewed_at,
    // correct_streak, total_reviews. Cards not yet in Leitner: leitner_box +
    // due_at + last_reviewed_at = null; correct_streak + total_reviews = 0.
    //
    // The access check and the cards are independent reads, asked together (one round trip, not two); the cards are dropped when
    // the deck turns out not to be readable.
    const [deck, { rows }] = await Promise.all([
      loadDeck(deckId),
      pool.query(
        `SELECT c.id AS card_id, c.entry_id, c.note_html, c.sort_order,
           de.headword, de.ipa_us, de.pos,
           LEFT(SPLIT_PART(de.meaning_vi, E'\\n', 1), 200) AS meaning_preview,
           ucp.times_seen, ucp.times_correct, ucp.first_seen_at, ucp.last_review,
           lc.box_number             AS leitner_box,
           lc.due_at                 AS due_at,
           lc.last_reviewed_at       AS last_reviewed_at,
           COALESCE(lc.correct_streak, 0) AS correct_streak,
           COALESCE(lc.total_reviews, 0)  AS total_reviews,
           CASE WHEN ucp.card_id IS NULL THEN TRUE ELSE FALSE END AS is_new
         FROM cards c
         JOIN dictionary_entries de ON de.id = c.entry_id
         LEFT JOIN user_card_progress ucp ON ucp.card_id = c.id AND ucp.user_id = $2
         LEFT JOIN leitner_cards lc ON lc.entry_id = c.entry_id AND lc.user_id = $2
         WHERE c.deck_id = $1
         ORDER BY c.sort_order ASC`,
        [deckId, userId]
      ),
    ]);
    if (!checkDeckForRead(deck, userId, res)) return;

    return apiSuccess(res, { items: rows, total: rows.length });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/decks/:deckId/cards
// ─────────────────────────────────────────────────────────────────────────────
const addCardSchema = z.object({
  entry_id: z.string().uuid('entry_id phải là UUID hợp lệ'),
});

router.post(
  '/decks/:deckId/cards',
  requireApiAuth,
  validateBody(addCardSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const deckId = req.params.deckId as string;
    const { entry_id } = req.body;

    // The deck check and the entry check are independent: asked together.
    const [deckRow, { rows: entryRows }] = await Promise.all([
      loadDeck(deckId),
      pool.query(
        `SELECT id, headword, meaning_vi, pos, ipa_us FROM dictionary_entries WHERE id = $1`,
        [entry_id]
      ),
    ]);
    const deck = checkDeckForWrite(deckRow, userId, res);
    if (!deck) return;
    if (entryRows.length === 0) {
      return apiError(res, 404, 'ENTRY_NOT_FOUND', 'Từ điển entry không tồn tại');
    }

    // Insert the card (a conflict means it already exists), start the user's progress on it and read back the SRS state: ONE
    // statement (it was four round trips in a row).
    const { rows: cardRows } = await pool.query(
      `WITH ins AS (
         INSERT INTO cards (deck_id, entry_id, sort_order)
         VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cards WHERE deck_id = $1))
         ON CONFLICT (deck_id, entry_id) DO NOTHING
         RETURNING id, deck_id, entry_id, sort_order, created_at
       ), prog AS (
         INSERT INTO user_card_progress (user_id, card_id)
         SELECT $3::uuid, id FROM ins
         ON CONFLICT (user_id, card_id) DO NOTHING
         RETURNING card_id, times_seen, times_correct, first_seen_at
       )
       SELECT ins.id, ins.deck_id, ins.entry_id, ins.sort_order, ins.created_at,
              prog.times_seen, prog.times_correct, prog.first_seen_at,
              lc.box_number AS leitner_box_number, lc.due_at AS leitner_due_at
         FROM ins
         LEFT JOIN prog ON prog.card_id = ins.id
         LEFT JOIN leitner_cards lc ON lc.entry_id = ins.entry_id AND lc.user_id = $3::uuid`,
      [deckId, entry_id, userId]
    );

    if (cardRows.length === 0) {
      return apiError(res, 409, 'CARD_ALREADY_EXISTS', 'Entry này đã có trong deck');
    }

    const { id, deck_id, entry_id: cardEntryId, sort_order, created_at, ...srsRow } = cardRows[0];
    const card = { id, deck_id, entry_id: cardEntryId, sort_order, created_at };

    return res.status(201).json({
      success: true,
      data: {
        ...card,
        headword: entryRows[0].headword,
        meaning_vi: entryRows[0].meaning_vi,
        pos: entryRows[0].pos,
        ipa_us: entryRows[0].ipa_us,
        srs: srsRow ?? null,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/v1/decks/:deckId/cards/batch
// ─────────────────────────────────────────────────────────────────────────────
const batchAddSchema = z.object({
  entry_ids: z
    .array(z.string().uuid())
    .min(1, 'Cần ít nhất 1 entry_id')
    .max(100, 'Tối đa 100 entry mỗi lần'),
});

router.post(
  '/decks/:deckId/cards/batch',
  requireApiAuth,
  validateBody(batchAddSchema),
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const deckId = req.params.deckId as string;
    const { entry_ids }: { entry_ids: string[] } = req.body;

    const deck = checkDeckForWrite(await loadDeck(deckId), userId, res);
    if (!deck) return;

    // One statement, atomic on its own (it was BEGIN, read the highest sort order, insert, insert the progress rows, COMMIT).
    // Positions are numbered from the highest existing one in the order the ids were sent, and an id that is skipped (the card is
    // already in the deck, or the id is repeated) keeps its number unused, exactly as before.
    const { rows: inserted } = await pool.query(
      `WITH base AS (
         SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM cards WHERE deck_id = $1
       ), ins AS (
         INSERT INTO cards (deck_id, entry_id, sort_order)
         SELECT $1::uuid, t.entry_id, base.max_order + t.ord
           FROM unnest($2::uuid[]) WITH ORDINALITY AS t(entry_id, ord)
          CROSS JOIN base
         ON CONFLICT (deck_id, entry_id) DO NOTHING
         RETURNING id, entry_id, sort_order
       ), prog AS (
         -- Init user_card_progress for newly added cards
         INSERT INTO user_card_progress (user_id, card_id)
         SELECT $3::uuid, id FROM ins
         ON CONFLICT (user_id, card_id) DO NOTHING
       )
       SELECT id, entry_id FROM ins ORDER BY sort_order`,
      [deckId, entry_ids, userId]
    );

    const added = inserted.length;
    const skipped = entry_ids.length - added;

    return res.status(201).json({
      success: true,
      data: {
        added,
        skipped,
        entry_ids_added: inserted.map((r: any) => r.entry_id),
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/v1/decks/:deckId/cards/:cardId
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/decks/:deckId/cards/:cardId',
  requireApiAuth,
  asyncHandler(async (req: ApiRequest, res: Response) => {
    const userId = req.user!.id;
    const deckId = req.params.deckId as string;
    const cardId = req.params.cardId as string;

    // The deck check and "does the card belong to this deck?" are independent reads: asked together.
    const [deckRow, { rows }] = await Promise.all([
      loadDeck(deckId),
      pool.query(`SELECT id FROM cards WHERE id = $1 AND deck_id = $2`, [cardId, deckId]),
    ]);
    const deck = checkDeckForWrite(deckRow, userId, res);
    if (!deck) return;
    if (rows.length === 0) {
      return apiError(res, 404, 'CARD_NOT_FOUND', 'Card không tồn tại trong deck này');
    }

    // CASCADE deletes user_card_progress + reviews
    await pool.query('DELETE FROM cards WHERE id = $1', [cardId]);

    return apiSuccess(res, null, 'Card đã xóa');
  })
);

export default router;
