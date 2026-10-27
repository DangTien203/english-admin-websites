# Mobile API Endpoints Contract

This file is written for Codex and mobile-client work. Treat it as a code-derived map of the mobile API surface, not as product copy.

Source of truth scanned on 2026-07-01:

- `app.ts`
- `routes/api/*.ts`
- `middlewares/apiAuth.ts`
- `middlewares/requireFeature.ts`
- `utils/apiResponse.ts`
- `utils/pagination.ts`

If this file conflicts with route code, route code wins. Update this file in the same change whenever a mobile endpoint changes.

## Global Contract

Base path:

```text
/api/v1
```

Default request format:

- Most endpoints expect `Content-Type: application/json`.
- `POST /api/v1/profile/avatar` expects `multipart/form-data` with file field `avatar`.
- Authenticated endpoints require `Authorization: Bearer <access_token>`.
- Query pagination uses `page` and `limit`; default is `page=1&limit=20`, max `limit=100`.

Standard success response:

```json
{
  "success": true,
  "data": {}
}
```

Optional success message:

```json
{
  "success": true,
  "data": {},
  "message": "..."
}
```

Standard error response:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "...",
    "details": {}
  }
}
```

Important exception: endpoints returning HTTP `204` have no body. Do not try to decode JSON for `204`.

Auth labels used below:

- `Public`: no token required.
- `Optional auth`: endpoint works as guest; valid token adds user context.
- `Auth`: requires Bearer access token.
- `Feature gate`: requires auth plus subscription feature quota.

Global auth errors from `requireApiAuth`:

- `401 NO_TOKEN`
- `401 TOKEN_EXPIRED`
- `401 INVALID_TOKEN`
- `403 ACCOUNT_BANNED`

Feature gate errors from `requireFeature(feature_key)`:

- `403 FEATURE_NOT_AVAILABLE`
- `403 QUOTA_EXCEEDED` with `{ limit, used }`

Token TTLs from `routes/api/auth.ts`:

- Access token: `7d`
- Refresh token: `30d`
- Refresh is rotated on every `/auth/refresh`.

## Mount Order Notes

Mobile API mounts in `app.ts`:

- `/api/v1/auth`
- `/api/v1/profile`
- `/api/v1/dictionary`
- `/api/v1/decks`
- `/api/v1/review`
- `/api/v1/leitner`
- `/api/v1/practice`
- `/api/v1/subscriptions`
- `/api/v1/retrieval`
- `/api/v1/ebooks`
- `/api/v1/games`
- `/api/v1/home`
- `/api/v1/notifications`
- broad `/api/v1` cards routes, mounted last

Cards routes live in `routes/api/cards.ts`, but because they are mounted at broad `/api/v1`, their final paths are `/api/v1/decks/:deckId/cards...`.

## Do Not Call These Stale Paths

These paths appear in older docs or comments but are not current route code:

- `POST /api/v1/decks/create` - use `POST /api/v1/decks`.
- `POST /api/v1/decks/:id/favorite/toggle` - use `POST /api/v1/decks/:id/favorite` and `DELETE /api/v1/decks/:id/favorite`.
- `POST /api/v1/decks/:id/cards` from `routes/api/decks.ts` - actual cards routes are served by broad cards router as `/api/v1/decks/:deckId/cards`.
- `GET /api/v1/ebooks/:id/chapters` - no separate route currently. Chapter summaries are included in `GET /api/v1/ebooks/:id`.
- `GET /api/v1/ebooks/chapters/:id` - current route is `GET /api/v1/ebooks/:id/chapters/:chapter_id`.
- `POST /api/v1/retrieval/sentence`, `/answer`, `/complete` - current retrieval flow is `/start` then `/submit`.
- `GET /api/v1/subscriptions/:userId/active` - use `GET /api/v1/subscriptions/me`.
- `POST /api/v1/subscriptions/initiate` - use checkout preview/confirm.
- `POST /api/v1/notifications/fcm-tokens` - current route is singular `POST /api/v1/notifications/fcm-token`.

## Auth Endpoints

### `POST /api/v1/auth/register`

- Auth: Public
- Rate limit: register limiter, skipped under `NODE_ENV=test`
- Body:
  - `email`: email
  - `password`: string, min 6
  - `full_name`: string, min 2
  - `phone`: optional string
  - `level`: optional `beginner | intermediate | advanced`
- Returns: `201`, `{ access_token, refresh_token, user }`
- Notable errors: validation errors, unique email conflict via global PG error handler.

### `POST /api/v1/auth/login`

- Auth: Public
- Rate limit: login limiter, skipped under `NODE_ENV=test`
- Body: `{ email, password }`
- Returns: `{ access_token, refresh_token, user }`
- Errors:
  - `401 INVALID_CREDENTIALS`
  - `403 ACCOUNT_BANNED`

### `POST /api/v1/auth/refresh`

- Auth: Public
- Rate limit: refresh limiter, skipped under `NODE_ENV=test`
- Body: `{ refresh_token }`
- Returns: new `{ access_token, refresh_token, user }`
- Behavior: revokes old refresh token and inserts a new token record.
- Errors:
  - `401 INVALID_REFRESH_TOKEN`
  - `401 REFRESH_TOKEN_EXPIRED`
  - `403 ACCOUNT_BANNED`

### `GET /api/v1/auth/me`

- Auth: Auth
- Returns: `{ user: req.user }`

### `POST /api/v1/auth/logout`

- Auth: Auth
- Body: `{ refresh_token?: string }`
- Returns: `204`, no body
- Behavior: revokes the supplied refresh token if it belongs to current user.

### `POST /api/v1/auth/logout-all`

- Auth: Auth
- Returns: `204`, no body
- Behavior: revokes all active refresh tokens for current user.

## Profile Endpoints

All profile endpoints are mounted behind `requireApiAuth`.

### `GET /api/v1/profile/me`

- Auth: Auth
- Returns: user profile, subscription badge, `total_words_saved`, `days_active`.

### `PATCH /api/v1/profile/me`

- Auth: Auth
- Body, at least one field required:
  - `full_name?`: string, min 2
  - `phone?`: Vietnamese phone regex `(\+84|0)\d{9,10}`
  - `avatar_url?`: URL
  - `level?`: `beginner | intermediate | advanced`
- Returns: updated user row.

### `POST /api/v1/profile/change-password`

- Auth: Auth
- Body:
  - `currentPassword`: string
  - `newPassword`: string, min 6
- Returns: `{ success: true, data: null, message }`
- Behavior: revokes all refresh tokens after password change.
- Errors:
  - `400 SAME_PASSWORD`
  - `401 INVALID_CURRENT_PASSWORD`
  - `404 USER_NOT_FOUND`

### `POST /api/v1/profile/avatar`

- Auth: Auth
- Body: `multipart/form-data`, file field `avatar`
- Returns: `{ avatar_url }`
- Errors: `400 NO_FILE`

### `DELETE /api/v1/profile/avatar`

- Auth: Auth
- Returns: `{ success: true, data: null, message }`

### `GET /api/v1/profile/stats`

- Auth: Auth
- Returns: streaks, review totals, study time, learned words, last 30 days activity.
- Codex note: this route queries `reviews`; verify schema compatibility before relying on it.

## Dictionary Endpoints

### `GET /api/v1/dictionary/search`

- Auth: Public
- Query:
  - `q`: required, min length 1
  - `page?`, `limit?`
  - `pos?`: comma-separated POS values
  - `cefr?`: CEFR level, uppercased by server
- Returns: `{ items, meta: { total, page, limit } }`
- Cache header: public, 1 hour
- Errors: `400 VALIDATION_ERROR`

### `GET /api/v1/dictionary/trending`

- Auth: Public
- Returns: top 20 looked-up words in last 7 days.
- Cache: in-memory 1 hour, bypassed under test.

### `GET /api/v1/dictionary/categories`

- Auth: Public
- Returns: tag list with `entry_count`.

### `GET /api/v1/dictionary/categories/:tag_id/entries`

- Auth: Public
- Query: `page?`, `limit?`
- Returns: entries for tag with pagination meta.

### `GET /api/v1/dictionary/entries/:id`

- Auth: Optional auth
- Query:
  - `source?`: `ebook` logs ebook lookup, anything else logs manual search
  - `ebook_id?`: used only when `source=ebook`
- Returns: full dictionary entry projection from `FULL_ENTRY_SQL`.
- Behavior: if token is valid, inserts a word lookup asynchronously.
- Errors: `404 ENTRY_NOT_FOUND`

### `GET /api/v1/dictionary/entries/by-headword/:headword`

- Auth: Optional auth
- Query: same lookup logging query as `entries/:id`
- Returns: full dictionary entry for exact case-insensitive headword.
- Errors: `404 ENTRY_NOT_FOUND`

### `POST /api/v1/dictionary/entries/:id/tts`

- Auth: Auth
- Rate limit: 30 per minute per user, skipped under test
- Body: `{ accent: "us" | "uk" }`
- Returns: `{ audio_url, cached }`
- Behavior: first checks `audio_us_url` or `audio_uk_url`; otherwise calls server TTS and updates dictionary entry.
- Errors:
  - `404 NOT_FOUND`
  - `500 TTS_GENERATION_FAILED`
  - `429 TOO_MANY_REQUESTS`

### `POST /api/v1/dictionary/entries/:id/bookmark`

- Auth: Auth
- Body: `{ note?: string }`
- Returns: `201`, `{ saved: true, saved_word_id }`
- Behavior: upserts `user_saved_words`.

### `DELETE /api/v1/dictionary/entries/:id/bookmark`

- Auth: Auth
- Returns: `{ saved: false }`
- Errors: `404 BOOKMARK_NOT_FOUND`

### `GET /api/v1/dictionary/saved-words`

- Auth: Auth
- Query:
  - `page?`, `limit?`
  - `mastery_level?`
  - `cefr?`
  - `pos?`: comma-separated
- Returns: `{ stats, items, meta }`

### `GET /api/v1/dictionary/lookup-history`

- Auth: Auth
- Query:
  - `page?`, `limit?`
  - `source?`
  - `ebook_id?`
- Returns: lookup items grouped by UTC date.

## Deck Endpoints

All deck endpoints are mounted behind `requireApiAuth`.

### `GET /api/v1/decks/system`

- Auth: Auth
- Query:
  - `page?`, `limit?`
  - `search?`: min 1, max 100
  - `level?`: `beginner | intermediate | advanced`
  - `tag?`: string or repeated query param; values are tag UUIDs
- Returns: `{ items, total, page, limit }`
- Items include `user_progress`, `tags`, `is_favorite`, `is_system`.

### `GET /api/v1/decks/mine`

- Auth: Auth
- Query: `page?`, `limit?`
- Returns: current user's non-system decks.

### `GET /api/v1/decks`

- Auth: Auth
- Deprecated: use `/decks/mine` or `/decks/system`.
- Returns old shape with `summary`, `items`, `meta`.
- Response header: `X-Deprecated`.

### `GET /api/v1/decks/:id`

- Auth: Auth
- Returns: deck detail, card preview, tags, progress.
- Access: published system deck or deck owned by current user.
- Errors: `404 DECK_NOT_FOUND`

### `POST /api/v1/decks`

- Auth: Auth plus feature gate `flashcard_max_decks`
- Body:
  - `title`: string, min 3, max 500
  - `description?`: string, max 2000
  - `level?`: `beginner | intermediate | advanced`, default `beginner`
  - `tag_ids?`: UUID array
- Returns: `201`, created user deck.
- Behavior: hard-codes `deck_type='user_created'`.

### `PATCH /api/v1/decks/:id`

- Auth: Auth
- Access: owner only, system decks forbidden
- Body, at least one:
  - `title?`
  - `description?`: string or null
  - `level?`
- Returns: updated deck.
- Errors:
  - `403 SYSTEM_DECK_FORBIDDEN`
  - `403 DECK_ACCESS_DENIED`
  - `404 DECK_NOT_FOUND`

### `DELETE /api/v1/decks/:id`

- Auth: Auth
- Access: owner only, system decks forbidden
- Returns: `{ success: true, data: null, message }`

### `POST /api/v1/decks/:id/favorite`

- Auth: Auth
- Access: published system decks only
- Returns: `204`, no body
- Errors:
  - `400 INVALID_OPERATION`
  - `404 DECK_NOT_FOUND`

### `DELETE /api/v1/decks/:id/favorite`

- Auth: Auth
- Returns: `204`, no body
- Behavior: idempotent delete.

## Card Endpoints

Cards routes are mounted through broad `/api/v1`, so final paths still begin with `/api/v1/decks/...`. Every cards endpoint also applies `requireApiAuth` inside the router.

### `GET /api/v1/decks/:deckId/cards`

- Auth: Auth
- Access: public premade/system deck or own user-created deck
- Returns: `{ items, total }`
- Items include dictionary preview plus per-user `user_card_progress` and `leitner_cards` state.

### `POST /api/v1/decks/:deckId/cards`

- Auth: Auth
- Access: own user-created deck only
- Body: `{ entry_id: uuid }`
- Returns: `201`, created card with entry preview and `srs`.
- Errors:
  - `404 ENTRY_NOT_FOUND`
  - `409 CARD_ALREADY_EXISTS`

### `POST /api/v1/decks/:deckId/cards/batch`

- Auth: Auth
- Access: own user-created deck only
- Body: `{ entry_ids: uuid[] }`, min 1, max 100
- Returns: `201`, `{ added, skipped, entry_ids_added }`

### `DELETE /api/v1/decks/:deckId/cards/:cardId`

- Auth: Auth
- Access: own user-created deck only
- Returns: `{ success: true, data: null, message }`
- Errors: `404 CARD_NOT_FOUND`

## Legacy Review Endpoints

These are mounted at `/api/v1/review` and require auth. They are kept for older clients. New client work should prefer `/api/v1/practice` for deck practice and `/api/v1/leitner` for SRS review.

### `POST /api/v1/review/swift-choice/question`

- Auth: Auth
- Body: `{ card_id: uuid }`
- Returns: multiple-choice meaning question with `correct_index`.
- Errors:
  - `404 CARD_NOT_FOUND`
  - `422 INSUFFICIENT_DISTRACTORS`

### `POST /api/v1/review/cloze/question`

- Auth: Auth
- Body: `{ card_id: uuid, level: 1 | 2 | 3 }`
- Returns: cloze question data.
- Errors:
  - `404 CARD_NOT_FOUND`
  - `422 NO_EXAMPLES`

### `POST /api/v1/review/pair-link/session`

- Auth: Auth
- Body:
  - `deck_id?`: uuid or null
  - `count?`: integer 1-10, default 5
- Returns: `{ session_id, pairs }`

## Leitner Endpoints

All Leitner endpoints are mounted behind `requireApiAuth`.

### `GET /api/v1/leitner/overview`

- Auth: Auth
- Returns: box distribution, due counts, retention stats, mastered count.

### `GET /api/v1/leitner/due`

- Auth: Auth
- Query:
  - `limit?`: default 20, max 100
  - `offset?`: default 0
- Returns: due Leitner cards with nested entry preview and meta.

### `GET /api/v1/leitner/box/:box_number`

- Auth: Auth
- Path: `box_number` must be 1-5
- Query: `page?`, `limit?`
- Returns: `{ box_number, items, total, due_count, page, limit }` - cards in a specific Leitner box. `total` = all cards in the box, `due_count` = the ones due now (the words "Ôn tập các từ đến hạn" of this box can use).
- Errors: `400 INVALID_BOX_NUMBER`

### `POST /api/v1/leitner/review`

- Auth: Auth
- Body:
  - `leitner_card_id`: string
  - `correct?`: boolean (client-graded)
  - `user_answer?`: string (Vietnamese meaning; server-graded, wins over `correct`)
  - `time_ms?`: number
- Behavior: for cards in **box 1-3 only**. Box 4/5 cards must be checked on both the English and the Vietnamese meaning, spaced apart, which is only possible inside a review session (below).
- Returns: `{ new_box_number, next_due_at, mastered_now, grading }`
- Errors:
  - `400 VALIDATION_ERROR`
  - `404 CARD_NOT_FOUND`
  - `409 REVIEW_SESSION_REQUIRED` (card is in box 4/5 - use `/session/start`)

### Leitner review session (box 4/5 are checked on BOTH meanings)

Words in Leitner **box 4/5** must be answered twice: the **English meaning** (`check: "en"`: definition / paraphrase / synonym) first, the **Vietnamese meaning** (`check: "vi"`) later. The two checks of one word are always at least **2 other steps apart** (English at step 1 -> Vietnamese at step 4 or later). Words in box 1-3 have a single Vietnamese check. So 10 due words with 3 of them in box 4/5 = **13 steps**, but every count in the summary is per **original word** (10, never 13).

If a session has fewer than 3 words and contains a box 4/5 word, the gap cannot be reached; the checks are then placed as far apart as possible (see `min_steps_between_checks`).

#### `POST /api/v1/leitner/session/start`

- Auth: Auth
- Body: `{ limit?: 1-100, box_number?: 1-5 }`
  - `limit`: number of **words** (default 20), not steps. The server takes the first `limit` cards by `due_at` (most overdue / closest to due first), then shuffles them.
  - `box_number` omitted: **"Review due now"** - due cards only.
  - `box_number` 1-5: **review the due words of one box** - ONLY cards of that box that are due now (most overdue first); words that are not due yet are never included, so words just promoted out of the previous box cannot be reviewed again in the next one. Same rules apply: box 1-3 = one Vietnamese check per word; box 4/5 = English + Vietnamese check per word (2 steps, summary still 1 word; both right -> next box, exactly one right -> stays in the same box, both wrong -> box 1). If fewer than `limit` words are due, all of them are used (e.g. 3 due words -> 3 words, even if the client asked for 10). "All due words" of a box = `limit: min(due words in box, 100)`; the number of due words comes from `GET /leitner/box/:n` (`due_count`) or `GET /leitner/overview` (`boxes[].due_today`).
  - Box 4/5 with fewer than 3 words cannot keep the 2-step gap between the two checks; they are then spread as far apart as possible.
- Returns: `{ session_id, box_number (null for "due now"), total_words, total_steps, completed, min_steps_between_checks, progress, steps }`; each step: `{ step_index, leitner_card_id, entry_id, check: "en"|"vi", check_number, checks_total, box_number, typed_answer_required, answered, correct, entry }`. `entry` never contains the meaning.
- Errors: `400 NO_DUE_CARDS` - nothing is due; for a box session `error.details.box_number` names the box.

#### `POST /api/v1/leitner/session/answer`

- Auth: Auth
- Body: `{ session_id, step_index, user_answer?, correct?, time_ms? }` (one of `user_answer` / `correct`; `user_answer` max 500 chars)
  - `user_answer` is the meaning asked by the step's `check`; the server grades it.
  - `correct` (client-graded, e.g. swift-choice) is only accepted for single-check words (`typed_answer_required: false`).
- English check (`check: "en"`): the answer must be written in **English**. A Vietnamese answer (with or without diacritics, or the entry's own Vietnamese meaning) is graded wrong without any model call (`grading_source: "deterministic_miss"`, `reason_vi` asks for English). The same rule applies to `user_answer_en` in `/practice/session/answer`.
- Steps must be answered **in order** (`step_index` = `progress.next_step_index`).
- Behavior: a word's Leitner box moves **once**, when its last step is answered (`word.result`):
  - `advance`: every check right (box 4/5: English **and** Vietnamese) -> up one box (box 5 stays 5).
  - `hold`: box 4/5 word with **exactly one** of its two meanings right (either one) -> stays in its current box; the due date is rescheduled with that box's interval.
  - `reset`: no check right (box 4/5: both wrong; box 1-3: the single check wrong) -> back to box 1.
  If the card was already reviewed elsewhere in the meantime, its box is left alone (`word.applied: false`).
- Returns: `{ step_index, check, grading, word: { checks_total, checks_done, checks_correct, resolved, correct, result, applied, new_box_number, next_due_at, mastered_now }, progress: { answered_steps, total_steps, resolved_words, total_words, next_step_index } }`
- Errors:
  - `400 VALIDATION_ERROR`, `400 TYPED_ANSWER_REQUIRED`, `400 SESSION_ALREADY_COMPLETED`
  - `404 SESSION_NOT_FOUND`, `404 STEP_NOT_FOUND`, `404 CARD_NOT_FOUND`
  - `409 STEP_OUT_OF_ORDER` (details: `expected_step_index`), `409 STEP_ALREADY_ANSWERED`

#### `POST /api/v1/leitner/session/complete`

- Auth: Auth
- Body: `{ session_id }`
- Returns: `{ session_id, summary: { total_words, correct_words, partial_words, wrong_words, skipped_words, accuracy, mastered_now, time_total_ms }, words }`. `words` has one entry per original word, with `status` `correct` (every check right, box up) | `partial` (box 4/5 word with exactly one meaning right, box kept) | `wrong` (nothing right, back to box 1) | `skipped` (its steps were not all answered), plus `result` (`advance` | `hold` | `reset` | null). `correct` is true only when every check was right. `accuracy` = `correct_words` / answered words (`correct + partial + wrong`).
- Errors: `400 SESSION_ALREADY_COMPLETED`, `404 SESSION_NOT_FOUND`

#### `GET /api/v1/leitner/session/:id`

- Auth: Auth
- Returns: same shape as `/session/start` (resume / re-sync after a network error).
- Errors: `404 SESSION_NOT_FOUND`

### `GET /api/v1/leitner/stats`

- Auth: Auth
- Query: `range=7d|30d|all`, default `30d`
- Returns: distribution, retention rate, hardest/easiest words.
- Cache: per-user/range 5 minutes.

### `POST /api/v1/leitner/swift-choice/question`

- Auth: Auth
- Body: `{ leitner_card_id: uuid }`
- Returns: question data based on Leitner card.
- Errors:
  - `404 LEITNER_CARD_NOT_FOUND`
  - `422 INSUFFICIENT_DISTRACTORS`

### `POST /api/v1/leitner/cloze/question`

- Auth: Auth
- Body: `{ leitner_card_id: uuid, level: 1 | 2 | 3 }`
- Returns: cloze question data.
- Errors:
  - `404 LEITNER_CARD_NOT_FOUND`
  - `422 NO_EXAMPLES`

### `POST /api/v1/leitner/pair-link/session`

- Auth: Auth
- Body: `{ leitner_card_ids: uuid[] }`, schema min 1/max 20; functional minimum is 2 valid cards.
- Returns: `{ pairs }`
- Errors:
  - `400 INSUFFICIENT_PAIRS`
  - `404 LEITNER_CARD_NOT_FOUND` with invalid ids in details

## Practice Endpoints

All practice endpoints are mounted behind `requireApiAuth`.

### `POST /api/v1/practice/session/start`

- Auth: Auth
- Body:
  - `deck_id`: uuid
  - `mode`: `flashcard | swift_choice | cloze_craft | pair_link`
  - `limit?`: integer 1-100
  - `card_ids?`: uuid array, min 1, max 200
- Behavior:
  - If `card_ids` is present, manual selection wins and `limit` is ignored.
  - Random selection picks words NOT yet in the user's Leitner boxes first (random). Only if the deck has fewer unlearned words than `limit` is the remainder filled with random words already in Leitner (boxes 1-5, mastered included). The returned list is shuffled.
- Returns: `{ session_id, mode, cards, total_count }`; each card also has `leitner_box_number` (null = new word), `is_new_word`, and `requires_english_meaning` (true for box 4/5).
- Errors:
  - `404 DECK_NOT_FOUND`
  - `400 INVALID_CARDS`

### `POST /api/v1/practice/session/answer`

- Auth: Auth
- Body:
  - `session_id`: string
  - `card_id`: string
  - `correct`: boolean
  - `time_ms?`: number
  - `user_answer?`: string (Vietnamese meaning; server-graded when `correct` is omitted)
  - `user_answer_en?`: string (English meaning/definition; required when the card has `requires_english_meaning: true`)
- Behavior:
  - Cards in Leitner box 4/5 are `correct` only when BOTH the Vietnamese and the English meaning are right. A missing `user_answer_en` counts as wrong.
- Returns: progress counters, `grading` (`grading.correct` is the overall result), `requires_english_meaning`, and `english_grading` (null unless the English check applied).
- Errors:
  - `404 SESSION_NOT_FOUND`
  - `400 SESSION_ALREADY_COMPLETED`
  - `404 CARD_NOT_FOUND`

### `POST /api/v1/practice/session/complete`

- Auth: Auth
- Body: `{ session_id: string }`
- Behavior: correctly answered words that are not in Leitner go to box 1; words already in a box move up one box (box 5 stays in box 5).
- Returns: summary, `xp_earned`, `leitner_added` (`{ added, skipped }`), `leitner_advanced`, `leitner_mastered_now`, streak update flag, correct card ids.
- Errors:
  - `404 SESSION_NOT_FOUND`
  - `400 SESSION_ALREADY_COMPLETED`

### `POST /api/v1/practice/swift-choice/question`

- Auth: Auth
- Body: `{ card_id: string }`
- Returns: multiple-choice meaning question.
- Errors:
  - `404 CARD_NOT_FOUND`
  - `422 INSUFFICIENT_DISTRACTORS`

### `POST /api/v1/practice/cloze/question`

- Auth: Auth
- Body: `{ card_id: string, level: 1 | 2 | 3 }`
- Returns: cloze question data.
- Errors:
  - `404 CARD_NOT_FOUND`
  - `422 NO_EXAMPLES`

### `POST /api/v1/practice/pair-link/session`

- Auth: Auth
- Body:
  - `deck_id`: string
  - `count?`: number, clamped to 1-10, default 5
- Returns: `{ pairs }`

### `GET /api/v1/practice/history`

- Auth: Auth
- Query: `page?`, `limit?`
- Returns: previous practice sessions with pagination meta.

## Subscription Endpoints

### `GET /api/v1/subscriptions/plans`

- Auth: Optional auth
- Returns: active subscription plans with features and active payment methods.
- Cache: 5 minutes.

### `GET /api/v1/subscriptions/plans/:id`

- Auth: Optional auth
- Returns: plan detail, including inactive plan if id exists.
- Errors: `404 NOT_FOUND`

### `GET /api/v1/subscriptions/me`

- Auth: Auth
- Returns: current plan, active subscription, features map, usage map.

### `POST /api/v1/subscriptions/checkout/preview`

- Auth: Auth
- Body:
  - `plan_id`: uuid
  - `billing_cycle`: `monthly | yearly | weekly`
  - `payment_method_code`: string
- Returns: pricing, payment method, payment instructions, `expires_at`.
- Errors:
  - `404 NOT_FOUND`
  - `400 PAYMENT_METHOD_NOT_AVAILABLE`
  - `400 PAYMENT_METHOD_NOT_CONFIGURED`

### `POST /api/v1/subscriptions/checkout/confirm`

- Auth: Auth
- Body:
  - `plan_id`: uuid
  - `billing_cycle`: `monthly | yearly | weekly`
  - `payment_method_code`: string
  - `payment_ref?`: string
  - `amount_paid`: integer >= 0
- Returns: pending subscription and transaction ids.
- Errors:
  - `409 ALREADY_SUBSCRIBED`
  - `400 VALIDATION_ERROR`
  - `400 PAYMENT_METHOD_NOT_AVAILABLE`
  - `400 PAYMENT_METHOD_NOT_CONFIGURED`
- Codex note: handler writes to `transactions` and admin `notifications` tables; verify schema names if migrations change.

### `POST /api/v1/subscriptions/cancel`

- Auth: Auth
- Returns: `204`, no body
- Errors: `404 NOT_FOUND`

### `GET /api/v1/subscriptions/transactions`

- Auth: Auth
- Query:
  - `page?`, `limit?`
  - `status?`
- Returns: `{ items, total, page, limit }`

## Retrieval Practice Endpoints

All retrieval endpoints are mounted behind `requireApiAuth`.

### `POST /api/v1/retrieval/start`

- Auth: Auth plus feature gate `retrieval_practice_daily`
- Returns: exactly up to 3 target words from due Leitner cards, deck cards, then dictionary fallback.
- Response data: `{ target_words: [{ entry_id, headword, pos, ipa, meaning_vi, audio_url }] }`

### `POST /api/v1/retrieval/submit`

- Auth: Auth plus feature gate `retrieval_practice_daily`
- Body:
  - `target_words`: string array of length 3; accepts entry UUIDs or headword strings
  - `sentences`: string array of length 3; each sentence must have at least 6 words
- Behavior:
  - Moderates combined text.
  - Resolves target words.
  - Grades via active `retrieval_practice_grader` prompt template and OpenAI service.
  - Persists retrieval session.
  - Adds passed target words to Leitner box 1.
- Returns: `session_id`, per-sentence results, score, feedback, XP, Leitner added/skipped.
- Errors:
  - `400 VALIDATION_ERROR`
  - `400 FLAGGED_CONTENT`
  - `503 SERVICE_UNAVAILABLE`
  - `504 GPT_TIMEOUT`
  - `429 GPT_RATE_LIMITED`
  - `500 INTERNAL_ERROR`

### `GET /api/v1/retrieval/history`

- Auth: Auth
- Query:
  - `page?`: default 1
  - `limit?`: default 10, max 50
- Returns: retrieval session summaries.

### `GET /api/v1/retrieval/sessions/:id`

- Auth: Auth
- Returns: full retrieval session detail.
- Errors:
  - `404 NOT_FOUND`
  - `403 FORBIDDEN`

## Ebook Endpoints

All ebook endpoints are mounted behind `requireApiAuth`.

### `GET /api/v1/ebooks/reading-stats`

- Auth: Auth
- Returns: total reading time, finished/in-progress counts, lookup stats, top books, top looked-up words, days streak.
- Route order note: this static route must stay before `/:id`.

### `GET /api/v1/ebooks`

- Auth: Auth
- Query:
  - `search?`: matches title or author, SQL LIKE wildcards escaped
  - `filter?`: `reading | finished | favorites`
  - `genre?`
  - `level?`
  - `page?`, `limit?`
- Returns: published ebooks with progress and favorite flag.

### `GET /api/v1/ebooks/:id`

- Auth: Auth
- Returns: ebook detail, chapter summaries, reading progress object, favorite flag.
- Lock behavior:
  - If user plan tier is below `required_plan`, response includes `locked: true`, `locked_reason: "UPGRADE_REQUIRED"`, and `preview_chapter_ids`.
  - First chapter index 0 is preview.
- Errors: `404 NOT_FOUND`

### `GET /api/v1/ebooks/:id/chapters/:chapter_id`

- Auth: Auth
- Returns:
  - `chapter`: `{ id, index, title, word_count, tts_status, tts_progress }`
  - `paragraphs`: array with `{ id, index, text, word_count, translation_vi, audio_url, audio_status, duration_ms }`
  - `progress`: `{ current_paragraph_index, total_time_sec }`
- Access: for locked ebooks, only chapter index 0 is readable without plan tier.
- Behavior: fire-and-forget update of `last_read_at`.
- Errors:
  - `404 NOT_FOUND`
  - `403 FEATURE_NOT_AVAILABLE`

### `GET /api/v1/ebooks/:id/chapters/:chapter_id/audio-playlist`

- Auth: Auth
- Returns: playable ready-audio paragraphs only plus playlist metadata.
- Access: same preview/plan rule as chapter detail.
- Errors:
  - `404 NOT_FOUND`
  - `403 FEATURE_NOT_AVAILABLE`

### `POST /api/v1/ebooks/:id/chapters/:chapter_id/progress`

- Auth: Auth
- Body:
  - `current_paragraph_index`: number >= 0
  - `time_spent_sec?`: number
- Returns: `204`, no body
- Behavior: upserts reading progress and adds reading time.
- Errors:
  - `400 VALIDATION_ERROR`
  - `404 NOT_FOUND`

### `POST /api/v1/ebooks/:id/lookup`

- Auth: Auth
- Body:
  - `word`: string
  - `paragraph_id?`: string
- Behavior:
  - Normalizes word.
  - Tries dictionary exact headword/lemma first.
  - If no dictionary hit and `TRANSLATION_FALLBACK_ENABLED === "true"`, falls back to AI translation.
  - Increments ebook word lookup counters.
- Returns:
  - Dictionary hit: full entry projection with `source: "dictionary"` and `lookup_context`.
  - Translation hit: `{ source: "translation", word, translation_vi, phonetic, audio_url, pos, definitions_en, examples, providers, cached, lookup_context }`
- Errors:
  - `400 INVALID_WORD`
  - `404 ENTRY_NOT_FOUND`
  - `503 TRANSLATION_UNAVAILABLE`

### `POST /api/v1/ebooks/:id/translate-paragraph`

- Auth: Auth plus feature gate `translation_daily`
- Body: `{ paragraph_id: string }`
- Returns: `{ translation_vi, source }`, where source can be `precomputed`, service cache/fresh source, or `unavailable`.
- Errors:
  - `400 VALIDATION_ERROR`
  - `404 NOT_FOUND`

### `POST /api/v1/ebooks/:id/favorite`

- Auth: Auth
- Returns: `201`, `{ success: true }`
- Errors: `404 NOT_FOUND`

### `DELETE /api/v1/ebooks/:id/favorite`

- Auth: Auth
- Returns: `204`, no body

## Game Endpoints

### `GET /api/v1/games/levels`

- Auth: Optional auth
- Query:
  - `type?`: `lexisweep | anagram | ladder`
- Returns: active game levels.
- Errors: `400 VALIDATION_ERROR`

### `GET /api/v1/games/word-lists`

- Auth: Optional auth
- Query:
  - `type?`: `lexisweep | anagram`
  - `topic?`
  - `level?`: `beginner | intermediate | advanced | 1 | 2 | 3`
- Returns: published word list metadata only.

### `GET /api/v1/games/word-lists/:id`

- Auth: Auth
- Returns: full published word list with entries.
- Errors: `404 NOT_FOUND`

### `GET /api/v1/games/semantic-sets`

- Auth: Optional auth
- Query:
  - `level?`: `beginner | intermediate | advanced | 1 | 2 | 3`
- Returns: published semantic set metadata.

### `GET /api/v1/games/semantic-sets/:id`

- Auth: Auth
- Returns: semantic set items shuffled server-side. `correct_order` is deliberately not returned.
- Errors: `404 NOT_FOUND`

### `POST /api/v1/games/runs`

- Auth: Auth
- Body common fields:
  - `game_type`: `lexisweep | anagram | ladder`
  - `level_id?`
  - `list_id?`
  - `set_id?`
  - `score`: number >= 0
  - `accuracy?`: number, clamped 0-1 for non-ladder
  - `time_sec`: number >= 0
  - `completed`: boolean
  - `details`: object
- Type-specific body rules:
  - `lexisweep`: requires `list_id` and `details.words_found` array
  - `anagram`: requires `list_id` and `details.anagrams_solved` number
  - `ladder`: requires `set_id` and `details.user_order` array of entry ids
- Behavior:
  - Ladder accuracy is computed server-side against correct order.
  - Anti-cheat flags are stored inside `details.admin_note`.
  - Completed ladder run with accuracy >= 0.8 adds set entries to Leitner box 1.
  - Can create top-50 achievement notification.
- Returns: `{ run_id, xp_earned, leitner_added? }`

### `GET /api/v1/games/leaderboard`

- Auth: Auth
- Query:
  - `game_type`: required `lexisweep | anagram | ladder`
  - `range?`: `all_time | monthly | weekly | daily`, default `all_time`
- Returns: `{ top_3, rank_4_to_100, my_rank }`
- Cache: 60 seconds by game type and range.

### `GET /api/v1/games/me/stats`

- Auth: Auth
- Returns: aggregate completed-game stats and recent top games.

## Home Endpoints

### `GET /api/v1/home/dashboard`

- Auth: Auth
- Returns: aggregated mobile home dashboard:
  - user profile summary
  - streak
  - due review counts
  - continue decks
  - word of the day
  - recent activity
  - reading progress
  - game stats
  - unread notification count
- Cache: per user, 30 seconds.
- Errors: `404 USER_NOT_FOUND`

### `GET /api/v1/home/word-of-the-day`

- Auth: Optional auth
- Returns: `{ date, entry }` with full dictionary entry projection.
- Selection: deterministic by UTC date.
- Cache: 24 hours by date.
- Errors: `404 NO_ENTRIES`

## Notification Endpoints

All notification endpoints are mounted behind `requireApiAuth`.

### `GET /api/v1/notifications`

- Auth: Auth
- Query:
  - `filter?`: `all | unread | system`, default `all`
  - `page?`, `limit?`
- Returns: notification items plus `total`, `page`, `limit`, `unread_count`.
- Errors: `400 VALIDATION_ERROR`

### `GET /api/v1/notifications/unread-count`

- Auth: Auth
- Returns: `{ count }`
- Cache: per user, 10 seconds; invalidated by read/delete writes.

### `POST /api/v1/notifications/read-all`

- Auth: Auth
- Returns: `204`, no body

### `POST /api/v1/notifications/fcm-token`

- Auth: Auth
- Body:
  - `token`: string, max 500
  - `device_id`: string, max 200
  - `platform`: `ios | android | web`
- Returns: `204`, no body
- Behavior: upserts by `(user_id, device_id)`.

### `POST /api/v1/notifications/:id/read`

- Auth: Auth
- Returns: `204`, no body
- Errors: `404 NOT_FOUND`

### `DELETE /api/v1/notifications/:id`

- Auth: Auth
- Returns: `204`, no body
- Errors: `404 NOT_FOUND`

## Current Implementation Caveats For Codex

Use this section to avoid making mobile assumptions that are not true in the current code.

1. `GET /api/v1/decks` is explicitly deprecated. New mobile work should not build against it.
2. `/api/v1/review/*` is legacy. Keep compatibility if old clients use it, but new flows should use `/practice` or `/leitner`.
3. Some successful endpoints intentionally return `204` with no body. Mobile should branch on HTTP status before JSON decoding.
4. A few handlers still hand-roll `res.status(...).json(...)`; most preserve the same `success` envelope, but `POST /api/v1/ebooks/:id/favorite` returns only `{ success: true }`.
5. Public endpoints with `optionalApiAuth` silently treat invalid/expired tokens as guest. Do not use optional-auth endpoints to validate a token.
6. Tests use the real configured PostgreSQL database. Be careful before running broad endpoint tests in a dev database with valuable data.
