# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Dual-purpose Node.js application for an English learning platform:

1. **Admin web dashboard** — server-rendered EJS UI with session auth. Manages dictionary, lessons, decks, ebooks, games, users, approvals, subscriptions, AI content, and admin profile.
2. **Mobile REST API** (`/api/v1/*`) — JWT-authenticated JSON endpoints consumed by a Flutter mobile client.

Both surfaces share the same Express app, PG pool, and models. Source is TypeScript on CommonJS; dev runs via `tsx` against `.ts` files, prod compiles to `dist/`.

There is **no `src/` folder** — all source lives at the repo root in topical folders (`controllers/`, `models/`, `routes/`, etc.). All paths in this doc are relative to repo root.

## Commands

```bash
npm run dev           # tsx watch app.ts (dev server on :3000)
npm run build         # tsc → dist/
npm start             # node dist/app.js (production)
npm run typecheck     # tsc --noEmit

npm test              # jest (sequential, maxWorkers=1, forceExit, real PG)
npm test -- tests/auth.test.ts           # single file
npm test -- -t "login happy path"        # by test name
npm run test:watch

npm run db:migrate    # run all 32 migrations (idempotent, tracked in schema_migrations)
npm run admin:create -- --email <e> --name <n>   # insert ONE super_admin; random password printed once (or ADMIN_PASSWORD from the environment); never deletes, refuses an existing e-mail
npm run db:seed       # seed admin + sample data (scripts/seed.ts). WIPES ~32 tables first: lists them, refuses NODE_ENV=production or a non-local database unless --i-know-this-wipes-tables
npm run db:reset      # drop tables (all but the dictionary content; `-- --all`: everything) then migrate. Same latch as db:seed: prints the database and what it drops, refuses NODE_ENV=production or a non-local database unless --i-know-this-wipes-tables
npm run db:fresh      # reset + seed. npm hands extra arguments to the LAST command only, so the flag never reaches the reset half: on a non-local database run db:reset and db:seed as two commands
npm run db:backup     # dump SQL to file
npm run db:restore    # restore from SQL file

npm run precompute-audio   # batch TTS for every dictionary entry (resumable)
npm run re-segment         # rebuild ebook paragraph boundaries
```

Tests require `JWT_SECRET` in `.env` — `tests/setup.ts` throws otherwise. Tests hit the **same PostgreSQL the dev server uses** (no separate test DB, no mock layer); cleanup is fixture-pattern (DELETE WHERE email LIKE …).

## Architecture

### Mount order (app.ts)

1. `injectAdmin` middleware on every request (web + API). Loads admin from session, populates `res.locals.admin`, and for super_admin fetches pending-approvals + pending-transactions counts for sidebar badges. **Don't add expensive queries here.**
2. **Web routes** (`/auth`, `/dashboard`, `/approvals`, `/users`, `/profile`, `/dictionary`, `/lessons`, `/decks`, `/ebooks`, `/subscriptions`, `/settings`, `/games`, `/ai-content`).
3. **API routes** (`/api/v1/...`) — see "API surface" below.
4. **Catch-all** `/api/v1` cards mount must come **after** all specific `/api/v1/*` mounts (currently last, line ~142). Adding a new API resource? Mount it before the cards line.
5. `/api/*` 404 returns JSON via `apiError`. Web 404 renders `views/404.ejs`.
6. Global `errorHandler` (last middleware) maps PG errors (`23505`→409, `23503`→400) and Multer errors to JSON. Wrap every async API handler with `utils/asyncHandler.ts` so rejections reach this handler.

### Auth model

| Surface | Mechanism | Middleware | Notes |
|---|---|---|---|
| Web (`/dashboard`, `/users`, …) | `express-session` cookie | `requireAuth`, `requireRole(...)`, `redirectIfAuth`, `injectAdmin` (all in `middlewares/auth.ts`) | `SessionData.admin` augmented in `types/express.d.ts` |
| API (`/api/v1/*`) | JWT Bearer token | `requireApiAuth`, `optionalApiAuth` (`middlewares/apiAuth.ts`) | Verifies JWT, loads user from `users`, **blocks `status='banned'`**. Optional variant allows guest access (used on dictionary search, word-of-the-day, public game lists, public subscription plans). |
| API + plan gate | Subscription feature quota | `requireFeature('<feature_key>')` (`middlewares/requireFeature.ts`) | Loads active subscription, checks daily/quota limits from `plan_features`. Used on retrieval practice, translation, max decks. |

### API response shape

Every `/api/v1/*` response goes through `utils/apiResponse.ts`:

- Success: `apiSuccess(res, data, message?)` → `{ success: true, data, message? }`
- Error: `apiError(res, statusCode, code, message, details?)` → `{ success: false, error: { code, message, details? } }` with the given HTTP status

**Argument order: `(res, statusCode, code, ...)` — statusCode comes before the error code string.** Never hand-roll response shapes.

### Validation

API request bodies are validated with Zod via `validateBody(schema, { rejectEmpty? })` (`middlewares/validateBody.ts`). On success it **mutates `req.body`** to the parsed/typed result; on failure returns `400 VALIDATION_ERROR` with details. `rejectEmpty: true` rejects PATCH no-ops.

### Database

- Single `pg.Pool` from [config/db.ts](config/db.ts). Uses `DATABASE_URL` (Railway) when present, else discrete `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD` env vars. SSL only enabled with `NODE_ENV=production`.
- Models (`models/*.ts`) are **thin query wrappers** around `pool.query` — no ORM, no repository pattern. Read existing models before adding one.
- Migrations registered in [database/migrate.ts](database/migrate.ts) `migrations` array. Each runs in its own transaction; tracked in `schema_migrations` (key, name, checksum, executed_at, duration_ms). The migrate script auto-seeds the tracking table for legacy DBs that already had migrations applied (proxy: `users` table exists).
- Adding a new schema change: create the next-numbered file in `database/migrations/`, add a unique `key` to the migrations array, and **never rename the key after deploy** (the runner uses it for skip-on-replay).
- Tests share the dev DB. `maxWorkers: 1` is required for determinism — do not parallelize.

### TypeScript config quirks

- `strict: false`, `strictNullChecks: false`, `noImplicitAny: false` — codebase is loose about nullability. Don't rely on the compiler to catch null/undefined bugs; non-null assertions (`req.user!.id`) appear throughout.
- `tsconfig.json` excludes `scripts/` and `tests/`. Scripts use `tsconfig.scripts.json`; tests use `tsconfig.test.json`. Don't import test or script files from runtime code.
- CommonJS module output. A handful of one-off `.mts` ESM scripts exist in `scripts/` — run them with `tsx`, not `node`.

### Deployment

Railway (`railway.json`): build `npm run build`, start `node dist/database/migrate.js && node dist/app.js`. Migrations auto-run on every deploy. `app.set('trust proxy', 1)` is set so `express-rate-limit` sees the real client IP behind Railway's proxy.

---

## Web surface (admin dashboard)

| Mount | File | Roles | Purpose |
|---|---|---|---|
| `/auth` | `routes/auth.ts` → `authController` | public | login / logout (no register on web) |
| `/dashboard` | `routes/dashboard.ts` → `dashboardController` | any admin | stats: users, admins, dictionary entries, lessons; admin list |
| `/approvals` | `routes/approvals.ts` → `approvalController` | super_admin | pending approval queue, approve/reject with note |
| `/users` | `routes/users.ts` → `userController` | super_admin, moderator | mobile user CRUD, status toggle (active/inactive/banned) |
| `/profile` | `routes/profile.ts` → `profileController` | any admin | admin profile edit, avatar upload, password change, delete account |
| `/dictionary` | `routes/dictionary.ts` → `dictionaryController` | super_admin, moderator | dictionary entry CRUD, tag list, missing-IPA count, JSON import |
| `/lessons` | `routes/lessons.ts` → `lessonController` | super_admin, moderator | lesson CRUD, attach/detach entries, status toggle |
| `/decks` | `routes/decks.ts` → `deckController` | super_admin, moderator | premade/system deck CRUD, card add/remove, AJAX reorder |
| `/ebooks` | `routes/ebooks.ts` → `ebookController` | any admin | ebook CRUD, chapter TTS generation (202 fire-and-forget) |
| `/subscriptions` | `routes/subscriptions.ts` → `subscriptionController` | super_admin | plans, plan features, payment methods, transactions (approve/reject) |
| `/settings` | `routes/settings.ts` → `settingsController` | any admin | minimal settings page |
| `/games` | `routes/games.ts` → `gameController` | super_admin, moderator | word lists, levels, semantic sets CRUD; leaderboard view |
| `/ai-content` | `routes/ai-content.ts` → `aiContentController` | super_admin, moderator | retrieval sessions, moderation queue, prompt templates |

### Admin roles

`super_admin | content_editor | moderator` (column `admin_accounts.role`). Gate web routes with `requireRole(...)`.

| Capability | super_admin | moderator | content_editor |
|---|:---:|:---:|:---:|
| Dictionary, lessons, decks, games, ebooks, ai-content | ✅ | ✅ | ❌ (not currently gated to it) |
| Users CRUD | ✅ | ✅ | ❌ |
| Approvals (queue, approve/reject) | ✅ | ❌ | ❌ |
| Subscriptions (plans, payment methods, transactions) | ✅ | ❌ | ❌ |
| Sidebar pending counts (approvals + transactions) | ✅ | ❌ | ❌ |

> The codebase currently uses `('super_admin', 'moderator')` for content gates — `content_editor` is defined but not granted access on most routes. If you intend to add `content_editor`, update `requireRole(...)` lists explicitly.

### Admin accounts

No admin credentials are recorded in this repo (not here, not in README.md).

- **Create an admin**: `npm run admin:create -- --email <e> --name <n>` (`scripts/admin/create-admin.ts`). Inserts one `super_admin`; the password is random and printed exactly once, or taken from `ADMIN_PASSWORD` (then never printed). It never deletes or updates anything and refuses an e-mail that already exists. It does not accept a password on the command line.
- **`npm run db:seed`** (`scripts/seed.ts`) creates the demo admins listed there (with the demo password set in that script) and **wipes ~32 tables first**. It prints which database it is about to use and the table list, and refuses to start when `NODE_ENV=production` or when the database is not on this machine (`scripts/seedGuard.ts`), unless the command line has `--i-know-this-wipes-tables`. `db:reset` / `db:fresh` (`database/reset.ts`, which DROPs tables) and `scripts/seed-mobile-test-users.ts` (a fixed password for 6 accounts, written in the source, after deleting their study data) use the same latch: `guardReset` / `guardTestUsers` in `scripts/seedGuard.ts`, called before a connection is taken. The test-users script has its own flag, `--i-know-this-sets-a-known-password`. On a non-local database run `db:reset` and `db:seed` separately, each with its flag (`db:fresh` cannot pass it to the reset half).
- Tests make their own admin accounts with random names and delete them (`tests/helpers/lookupAdminFixtures.ts`).

### Views (EJS + express-ejs-layouts)

- Master layout: `views/layouts/main.ejs` (header, sidebar, footer). All pages inherit.
- `res.locals.admin` available in every view (set by `injectAdmin`).
- Flash messages via `connect-flash` (`success`, `error`, `warning`).
- Folder structure mirrors web routes: `views/{auth,dashboard,approvals,users,profile,dictionary,lessons,decks,ebooks,subscriptions,settings,games,ai-content}/...` plus `views/partials/` (sidebar, header, pagination).

---

## API surface (`/api/v1/*`)

Order in `app.ts` matters — specific mounts before the broad cards mount.

| Mount | File | Auth at mount | Per-route notes |
|---|---|---|---|
| `/api/v1/auth` | `routes/api/auth.ts` | none (per-route) | POST `/register`, `/login`, `/refresh`, `/logout`, `/logout-all`; GET `/me`. JWT pair issuance, refresh-token rotation in `user_refresh_tokens`. Rate-limited per endpoint. |
| `/api/v1/profile` | `routes/api/profile.ts` | `requireApiAuth` | GET `/me`, PATCH `/update`, POST `/change-password`, POST `/avatar` (multer), DELETE account. Subscription badge computed inline via `subscriptionHelper`. |
| `/api/v1/dictionary` | `routes/api/dictionary.ts` | none (per-route mix) | GET `/search` (optionalAuth, pos+cefr filters), GET `/:id` (full entry SQL with senses/word_forms/idioms/collocations), POST `/:id/tts` (auth + 30/min/user). Saved-words and recent-lookups endpoints. |
| `/api/v1/decks` | `routes/api/decks.ts` | `requireApiAuth` | GET `/system`, `/mine`, `/:id`; POST `/create` (gated by `requireFeature('flashcard_max_decks')`); PATCH `/:id`, DELETE `/:id`; POST `/:id/favorite/toggle`, `/:id/cards`, DELETE `/:id/cards/:entryId`. Ownership gate on writes. |
| `/api/v1/cards` | `routes/api/cards.ts` | `requireApiAuth` (broad mount) | GET/POST/DELETE under broad `/api/v1` prefix — **must mount last**. |
| `/api/v1/review` | `routes/api/review.ts` | `requireApiAuth` | Legacy review endpoints (swift-choice, cloze). Kept for older client builds; new clients use `/practice`. |
| `/api/v1/leitner` | `routes/api/leitner.ts` | `requireApiAuth` | GET `/overview` (box distribution + retention), GET `/question` (swift-choice / cloze / pair-link), POST `/answer`, POST `/batch-add`. SRS box transitions in `utils/leitnerManager.ts`. Review sessions (`/session/start|answer|complete`, GET `/session/:id`; `services/leitnerSessionService.ts`, step ordering in `utils/leitnerReviewQueue.ts`): box 4/5 words are checked on both English and Vietnamese meaning, ≥2 steps apart; summary counts original words; `/session/start` takes optional `box_number` (1–5) to study one box on demand. `POST /review` is box 1–3 only (409 `REVIEW_SESSION_REQUIRED` otherwise). |
| `/api/v1/practice` | `routes/api/practice.ts` | `requireApiAuth` | POST `/session/start`, `/session/:id/question`, `/session/:id/answer`, `/session/:id/complete`. Modes: flashcard, swift-choice, cloze, pair-link. Tracks practice sessions + answers; updates streak. |
| `/api/v1/subscriptions` | `routes/api/subscriptions.ts` | none (per-route) | GET `/plans` (public, 5-min in-memory cache), GET `/plans/:id`, GET `/:userId/active`, POST `/initiate` (transaction creation). |
| `/api/v1/retrieval` | `routes/api/retrieval.ts` | `requireApiAuth` + `requireFeature('retrieval_practice_daily')` on POST | POST `/start`, `/sentence`, `/answer`, `/complete`. AI sentence grading via OpenAI; word translation fallback via Codex. |
| `/api/v1/ebooks` | `routes/api/ebooks.ts` | `requireApiAuth` | GET ebook list, `/:id/chapters`, `/chapters/:id`, `/chapters/:id/paragraphs`. POST `/chapters/:id/read-progress`. POST translation gated by `requireFeature('translation_daily')`. Favorites endpoints. |
| `/api/v1/games` | `routes/api/games.ts` | none (per-route) | GET `/levels`, `/word-lists`, `/semantic-sets`, `/leaderboard` (public), POST `/runs`, `/runs/:id/submit` (auth). Anti-cheat checks on submit. |
| `/api/v1/home` | `routes/api/home.ts` | none (per-route) | GET `/dashboard` (auth, ~9 sections, 30s in-memory cache), GET `/word-of-the-day` (optionalAuth, deterministic via FNV-1a hash of date). |
| `/api/v1/notifications` | `routes/api/notifications.ts` | `requireApiAuth` | GET list (filters: all/unread/system, 10s cache), POST `/:id/read`, `/read-all`, DELETE `/:id`, POST `/fcm-tokens` (FCM token registration). |
| `/api/v1` (broad) | `routes/api/cards.ts` | `requireApiAuth` | Card endpoints for legacy URLs. **Mount last** (catches anything not handled above). |

### Rate limiting

`middlewares/rateLimiter.ts` — per-endpoint limits, **all skipped under `NODE_ENV=test`**:

- Login: 5 / 15min / IP
- Register: 3 / 15min / IP
- Refresh: 10 / 15min / IP
- TTS: 30 / min / user

---

## Domain map: controllers, models, services, utils

### Controllers (`controllers/`)

| File | Bound to | Responsibilities |
|---|---|---|
| `authController.ts` | `/auth` | login (email lowercase + bcrypt), register (disabled in UI), logout |
| `dashboardController.ts` | `/dashboard` | aggregate counts, admin list |
| `userController.ts` | `/users` | mobile user CRUD with paginated filters, status toggle |
| `profileController.ts` | `/profile` | admin profile edit, avatar upload, password change, soft-delete |
| `dictionaryController.ts` | `/dictionary` | entry CRUD, tag aggregation, missing-IPA count, JSON bulk import |
| `lessonController.ts` | `/lessons` | lesson CRUD, attach/detach entries via `lesson_entries` |
| `deckController.ts` | `/decks` | premade deck CRUD, card add/remove, AJAX reorder by `sort_order` |
| `ebookController.ts` | `/ebooks` | ebook CRUD, paragraph editing, chapter TTS trigger |
| `gameController.ts` | `/games` | word lists, levels, semantic sets CRUD; leaderboard view |
| `subscriptionController.ts` | `/subscriptions` | plans (CRUD + features), payment methods (CRUD + activate/deactivate), transactions (approve/reject) |
| `approvalController.ts` | `/approvals` | pending approval queue, approve/reject with note |
| `aiContentController.ts` | `/ai-content` | retrieval sessions list/detail, moderation queue, prompt templates |
| `settingsController.ts` | `/settings` | minimal placeholder |

### Models (`models/`)

Thin SQL wrappers — each function does one query (or a small batch). No business logic.

| File | Tables touched | Highlights |
|---|---|---|
| `Admin.ts` | `admin_accounts` | `findByEmail`, `findById`, `create`, `updateLastLogin`, `getAll`, `countByRole` |
| `User.ts` | `users` | paginated list with filters, `updateStatus`, status counts, streak fields |
| `Approval.ts` | `approval_requests` | `create`, `findPending(module)`, `approve`, `reject`, `countPending` |
| `DictionaryEntry.ts` | `dictionary_entries` + senses/word_forms/idioms/collocations/tags | full-entry SQL via `utils/entryQueries.ts`, missing-IPA count, tag list |
| `Lesson.ts` | `lessons`, `lesson_entries` | CRUD, entry attach/detach, ordered listing |
| `Deck.ts` | `decks` | system vs user (`is_system`, `user_id`, `deck_type`), `sort_order`, card count |
| `Ebook.ts` | `ebooks`, `chapters`, `paragraphs` | book CRUD, chapter and paragraph fetch, word counts |
| `Game.ts` | `game_word_lists`, `game_word_list_items`, `game_levels`, `game_semantic_sets` | content CRUD across game tables |
| `PaymentMethod.ts` | `payment_methods` | CRUD, `findActive`, type validation (direct_transfer/e_wallet/bank_card) |
| `Subscription.ts` | `subscription_plans`, `plan_features`, `user_subscriptions`, `subscription_transactions` | plan CRUD with features, active subscription, usage calc, expire-old |
| `AIContent.ts` | `retrieval_sessions`, `moderation_requests`, `prompt_templates` | listing + detail for AI dashboards |

### Services (`services/`)

External integrations and reusable workflows.

| File | Exports | Purpose |
|---|---|---|
| `ttsService.ts` | `generateAudio({ text, accent, source_type, source_id? })` | Google Cloud TTS via REST + R2 upload + `tts_cache` insert. SHA-256 hash includes `text + accent + voice_name`. |
| `storageClient.ts` | `uploadAudio(key, buffer)`, `audioExists(key)` | R2 (S3-compatible) S3Client lazy init |
| `chapterTtsService.ts` | `generateChapterAudio(chapterId, accent)` | Iterates a chapter's paragraphs, calls `ttsService` per paragraph, updates `chapter_tts_status`. Used by ebook admin's 202-async endpoint. |
| `openaiService.ts` | `moderateInput`, `gradeSentences` | OpenAI moderation + retrieval-practice sentence grading |
| `wordTranslationService.ts` | `normalizeWord`, `translateWord`, `TranslationFailedError` | Anthropic Codex single/batch word translation, with `word_translation_cache` table + LRU |
| `translationService.ts` | `translateText` | Generic Google Translate wrapper |
| `notificationService.ts` | `createNotification`, `fireNotification` | Insert into `user_notifications` + dispatch FCM push if `user_fcm_tokens` present |

### Middlewares (`middlewares/`)

| File | Notes |
|---|---|
| `auth.ts` | `requireAuth`, `requireRole(...roles)`, `redirectIfAuth`, `injectAdmin` (also fetches sidebar badge counts for super_admin) |
| `apiAuth.ts` | `requireApiAuth`, `optionalApiAuth`, `ApiRequest` type. JWT verify → load user → reject if banned. |
| `validateBody.ts` | Zod schema → 400 on failure, mutates `req.body` on success. `rejectEmpty: true` for PATCH. |
| `errorHandler.ts` | Global error → JSON; PG codes (`23505`→409 unique violation, `23503`→400 FK), Multer codes mapped. |
| `rateLimiter.ts` | Per-endpoint `express-rate-limit`. Skipped under `NODE_ENV=test`. |
| `requireFeature.ts` | Subscription quota gate using `plan_features.feature_value` against today's usage. |
| `trackActivity.ts` | Insert into `user_activity_log` (action + details). Used to drive streaks. |
| `upload.ts` | Multer configs: `uploadImage` (disk), `uploadJson` (memory), `uploadFile`. |

### Utils (`utils/`)

| File | Highlights |
|---|---|
| `apiResponse.ts` | `apiSuccess(res, data, message?)`, `apiError(res, statusCode, code, message, details?)` |
| `asyncHandler.ts` | Wraps async handler; forwards rejection to `errorHandler` |
| `pagination.ts` | `parsePagination(req)` → `{ page, limit, offset }`. Defaults: page=1, limit=20, max=100 |
| `entryQueries.ts` | `FULL_ENTRY_SQL` — canonical projection of dictionary entry with senses, word_forms, idioms, collocations, tags |
| `questionHelpers.ts` | `buildSwiftChoiceQuestion`, `buildClozeQuestion`, `shuffleArray`; `InsufficientDistractorsError`, `NoExamplesError` |
| `leitnerManager.ts` | Box 1–5 SRS: `getIntervals`, `addBatchToBox1`, `moveCard(userId, entryId, newBox)`, `addToBox1IfNotExists` |
| `subscriptionHelper.ts` | `getActiveSubscription`, `getFeaturesForUser`, `getUsage`, `computeSubscriptionBadge`, `calcPeriodEnd` |
| `streakCalculator.ts` | `updateStreak`, `calculateStreak` (from `user_activity_log`) |
| `deckService.ts` | `computeCompletionPercent(mastered, total)` — clamp 0..1 |
| `paymentMethodValidator.ts` | Per-type config validation for payment methods |
| `paragraphSegmenter.ts` | Text → paragraph boundaries (used by ebook ingest) |
| `safeResponse.ts` | `s/n/b/a` — null-safe coercion helpers for response shaping |

### Helpers (`helpers/`)

| File | Use |
|---|---|
| `pagination.ts` | `paginate(query, countQuery, params, countParams, page, limit)` — runs data + count in parallel |

---

## Database design

### Migration order (`database/migrate.ts`)

The runner uses opaque `key` strings — **do not rename keys post-deploy**. New schema goes in the next-numbered file, registered at the end of the array. Each migration is wrapped in its own transaction.

| # | Key | Purpose |
|---|---|---|
| 1 | `01_auth_content` | Domains 1–2 — `users, admin_accounts, tags, dictionary_entries, senses, word_forms, idioms, collocations, …` (~22 tables) |
| 2 | `02_learning_srs` | Domains 3–4 — `leitner_cards, leitner_reviews, practice_sessions, practice_answers, user_activity_log, retrieval_sessions` |
| 3 | `03_reading_ebook` | Domain 5 — `ebooks, chapters, paragraph_segments, user_reading_progress, tts_cache (legacy v1), chapter_tts_status` |
| 4 | `04_gaming` | Domain 6 — `game_word_lists, game_word_list_items, game_levels, game_semantic_sets, game_runs, game_answers` |
| 5 | `05_commerce` | Domain 7 — `subscription_plans, plan_features, user_subscriptions, subscription_transactions` |
| 6 | `06_ai_sync` | Domain 8 — `retrieval_sessions, moderation_requests, ai_content_blocks, ai_sync_logs, prompt_templates, prompt_parameters` |
| 7 | `07_system` | Domain 9 — `system_config, feature_flags, audit_logs, schema_migrations` |
| 8 | `08_indexes` | Performance indexes (GIN on `pos[]`, B-tree on `created_at, user_id, status, published`) |
| 9 | `09_approvals` | `approval_requests` (Domain 10) |
| 10 | `10_refresh_tokens` | `user_refresh_tokens` (token rotation) |
| 11 | `11_user_saved_words` | `user_saved_words` (bookmarks) |
| 12 | `12_dictionary_indexes` | GIN + B-tree on dictionary search columns |
| 13 | `13_decks_user_study` | `user_card_progress`, `user_deck_study_stats` |
| 14 | `14_decks_user_id` | ADD `decks.user_id` (safety pass for Phase 4) |
| 15 | `15_leitner_rewrite` | Replace old SRS — new `leitner_cards (box 1–5)` and `leitner_reviews` |
| 16 | `16_practice_sessions` | `practice_sessions, practice_answers` (session lifecycle) |
| 17 | `17_clean_user_card_progress` | Drop legacy SRS table |
| 18 | `18_payment_methods` | `payment_methods, plan_payment_methods` + `subscription_transactions.admin_note` |
| 19 | `19_user_subscription_pending` | ADD `user_subscriptions.pending_payment_status` |
| 20 | `20_paragraphs` | `paragraphs` + extend `user_reading_progress` per-paragraph |
| 21a | `21_user_ebook_favorites` | `user_ebook_favorites` |
| 21b | `21_tts_cache_update` | TTS cache v1 → snake_case (transitional) |
| 22a | `22_retrieval_feature_quotas` | Add `retrieval_practice_daily` rows in `plan_features`, columns on `user_subscriptions` |
| 22b | `22_tts_cache_recreate` | **Canonical** `tts_cache` schema (drops legacy `chapter_id` col) |
| 23 | `23_decks_system_flag` | ADD `decks.is_system, decks.sort_order` |
| 24 | `24_user_deck_favorites` | `user_deck_favorites` |
| 25 | `25_chapter_tts_progress` | ADD `chapters.tts_status` (pending/in_progress/completed/failed) + progress columns |
| 26 | `26_word_translation_cache` | `word_translation_cache` + fallback fields on `word_lookups` |
| 27 | `27_rename_plan_features` | Rename feature keys to mobile contract; add `translation_daily` quotas |
| 28 | `28_user_notifications` | `user_notifications, user_fcm_tokens` (FCM push) |
| 29 | `29_answer_grading` | `entry_answer_aliases, answer_semantic_cache` + grading columns on `practice_answers` |
| 30 | `30_answer_cache_lang` | `answer_semantic_cache.lang` (vi/en) + unique `(entry_id, lang, normalized_answer)` |
| 31 | `31_leitner_review_sessions` | `leitner_review_sessions, leitner_review_steps` (box 4/5 dual-meaning checks) |
| 32 | `32_leitner_session_box` | `leitner_review_sessions.box_number` (study one box), `leitner_review_steps.start_total_reviews` (reviewed-elsewhere guard) |

### Schema by domain

**Domain 1 — Identity & admin**
- `users` — mobile user (id, email, password_hash, full_name, avatar_url, status active/inactive/banned, current_streak, longest_streak, last_active_at, created_at)
- `admin_accounts` — dashboard admin (id, email, password_hash, full_name, avatar_url, role super_admin/content_editor/moderator, last_login_at)
- `user_refresh_tokens` — JWT refresh-token rotation (token_hash, user_id, expires_at, revoked_at)

**Domain 2 — Dictionary content**
- `dictionary_entries` — headword, ipa_us, ipa_uk, meaning_vi, cefr, frequency_rank, audio_us_url, audio_uk_url, pos[]
- `senses`, `word_forms`, `idioms`, `collocations` — child tables joined into the `FULL_ENTRY_SQL` projection
- `tags`, `dictionary_entry_tags` — tag taxonomy

**Domain 3 — Learning / SRS**
- `leitner_cards` (box 1–5, last_review_at, next_review_at, mastered)
- `leitner_reviews` (history per answer)
- `practice_sessions` (mode, started_at, completed_at, score)
- `practice_answers` (per-question result)
- `user_activity_log` (action, details JSONB) — drives streaks
- `user_card_progress`, `user_deck_study_stats` — per-deck progression

**Domain 4 — Retrieval (AI)**
- `retrieval_sessions` (target_word_ids, started_at)
- `word_translation_cache` (text → translation, last_used_at)

**Domain 5 — Reading / Ebook / TTS**
- `ebooks` (title, author, cover_url, total_chapters, total_words, required_plan, …)
- `chapters` (ebook_id, idx, title, content, tts_status, …)
- `paragraphs` (chapter_id, idx, text, word_count, audio_us_url, audio_uk_url)
- `user_reading_progress` (per-chapter and per-paragraph)
- `user_ebook_favorites` (user_id, ebook_id)
- `tts_cache` (canonical, see TTS section)
- `chapter_tts_status` / `chapter_tts_progress` — track async batch TTS jobs

**Domain 6 — Gaming**
- `game_word_lists`, `game_word_list_items`, `game_levels`, `game_semantic_sets`
- `game_runs` (user_id, level_id, started_at, score, anti_cheat_flags)
- `game_answers` (per-answer log)

**Domain 7 — Commerce**
- `subscription_plans` (free / premium / pro), `plan_features` (feature_key → feature_value JSON)
- `user_subscriptions` (user_id, plan_id, current_period_start/end, status, pending_payment_status)
- `subscription_transactions` (transaction id, amount, payment_method_id, admin_note, status pending/approved/rejected)
- `payment_methods`, `plan_payment_methods` — many-to-many

**Domain 8 — AI / sync**
- `moderation_requests`, `ai_content_blocks`, `ai_sync_logs`
- `prompt_templates`, `prompt_parameters` — admin-editable prompt library

**Domain 9 — System**
- `system_config`, `feature_flags`, `audit_logs`, `schema_migrations`

**Domain 10 — Approvals & misc**
- `approval_requests` — generic audit trail (module, requested_by, reviewed_by, status, note)
- `user_saved_words`, `user_deck_favorites`, `user_ebook_favorites`
- `user_notifications` (id, user_id, type, title, message, link_url, read_at, created_at)
- `user_fcm_tokens` (user_id, fcm_token, device_id, last_seen_at)

---

## Tests (`tests/`)

Real PostgreSQL, sequential (`maxWorkers: 1`). Cleanup via DELETE WHERE email LIKE pattern. Rate limiters skipped via `NODE_ENV=test`.

| File | Covers |
|---|---|
| `setup.ts` | Enforces `JWT_SECRET`, sets `NODE_ENV=test`, fixture cleanup |
| `auth.test.ts` | register/login/refresh/logout, banned-user block |
| `profile.test.ts` | GET/PATCH `/me`, change password, avatar |
| `dictionary.test.ts` | search filters (pos+cefr), entry detail, TTS cache + audio URL persistence |
| `decks.test.ts`, `decks-system.test.ts` | system vs user decks, ownership gates, favorites |
| `cards.test.ts` | cards CRUD under broad mount |
| `leitner.test.ts` | overview, question, answer, batch-add |
| `practice.test.ts`, `practice-session-start.test.ts` | session lifecycle, mode dispatch |
| `review.test.ts` | legacy swift-choice + cloze endpoints |
| `subscriptions.test.ts` | plans cache, active subscription, feature quotas |
| `ebooks.test.ts`, `audio-playlist.test.ts` | chapter/paragraph fetch, audio playlists |
| `games.test.ts` | run start, submit, anti-cheat, leaderboard |
| `home.test.ts` | dashboard sections, word-of-the-day determinism |
| `notifications.test.ts` | listing, mark read, delete |
| `retrieval.test.ts` | start/sentence/answer flow, feature gating |
| `word-translation.test.ts` | Codex translation cache hit/miss |
| `paragraphSegmenter.test.ts` | text → paragraph boundary unit tests |

---

## Scripts (`scripts/`)

One-off tooling, run with `tsx`. Excluded from `tsc` build via `tsconfig.scripts.json`.

| File | Purpose |
|---|---|
| `seed.ts` | App seed: admins, demo users, plans, payment methods, ebook stubs (NOT dictionary) |
| `seed-flashcards.ts` | Premade system decks populated with dictionary entries |
| `seed-games.ts` | Word lists, levels, semantic sets, anagram configs |
| `seed-prompt-templates.ts` | AI prompt template library |
| `precompute-dictionary-audio.ts` | Batch TTS for every dictionary entry; resumable via `scripts/precompute-checkpoint.json` |
| `re-segment-paragraphs.ts` | Rebuild ebook paragraph boundaries after text edits |
| `ingest-ebook.ts`, `import-ebook.mts`, `extract-pdf-ebook.mts` | Ebook ingest pipeline (TS + .mts ESM variants) |
| `import-enriched.mts` | Bulk dictionary import from enriched JSON |
| `cleanup-dictionary.mts`, `cleanup-ebooks.mts` | One-off cleanup |
| `backfill-ebook-counts.ts` | Populate `ebooks.total_chapters`, `total_words` |
| `expire-subscriptions.ts` | Cron: mark `current_period_end < NOW()` as expired |
| `deactivate-incomplete-payment-methods.ts` | Mark payment methods with missing config as inactive |
| `audit-plan-features.ts`, `check-plan-features.ts` | Verify plan-feature contract matches mobile expectations |
| `demo-*.ts` | End-to-end demo flows for SRS, Leitner, practice — not part of normal pipeline |
| `smoke-test.http` | REST Client manual smoke tests |

---

## TTS Integration — DONE ✅

### Tech stack
- **TTS provider**: Google Cloud Text-to-Speech REST API (NOT the SDK — `fetch` directly).
- **Auth**: API Key via env var `GOOGLE_TTS_API_KEY`.
- **Voices**:
  - US: `en-US-Neural2-D` (male)
  - UK: `en-GB-Neural2-B` (male)
- **Audio format**: MP3, 24 kHz, `speakingRate: 0.95`, `effectsProfileId: ['headphone-class-device']`.
- **Storage**: Cloudflare R2 (S3-compatible) via `@aws-sdk/client-s3`.
- **R2 bucket**: `english-app-audio` (public via R2.dev URL).

### Env vars required

```
GOOGLE_TTS_API_KEY
R2_ACCOUNT_ID            # informational; not read by code (R2_ENDPOINT is used directly)
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_ENDPOINT
R2_BUCKET
R2_PUBLIC_URL
ANTHROPIC_API_KEY        # for word translation (services/wordTranslationService.ts)
OPENAI_API_KEY           # for retrieval grading + moderation (services/openaiService.ts)
JWT_SECRET               # required by tests/setup.ts and runtime JWT
SESSION_SECRET           # express-session cookie secret
```

### Files

- [services/storageClient.ts](services/storageClient.ts) — R2 `uploadAudio(key, buffer)` and `audioExists(key)`. Lazy-init S3Client.
- [services/ttsService.ts](services/ttsService.ts) — `generateAudio({ text, accent, source_type, source_id? })`. Validates input, hashes, checks DB cache, calls Google TTS REST with 15 s `AbortController` timeout, uploads to R2, INSERTs into `tts_cache`.
- [services/chapterTtsService.ts](services/chapterTtsService.ts) — async batch chapter TTS; updates `chapter_tts_status`.
- [routes/api/dictionary.ts](routes/api/dictionary.ts) — `POST /api/v1/dictionary/entries/:id/tts` (auth + 30 req/min/user rate limit).
- [scripts/precompute-dictionary-audio.ts](scripts/precompute-dictionary-audio.ts) — batch-generate audio for every dictionary entry; resumable via `scripts/precompute-checkpoint.json`.
- [database/migrations/22_tts_cache_recreate.ts](database/migrations/22_tts_cache_recreate.ts) — **canonical** `tts_cache` schema. Guarded on legacy `chapter_id` column so it only DROPs once.

### Database

`tts_cache` columns (after migration 22):
`id, source_text_hash, accent, voice_name, audio_url, char_count, source_type, source_id, created_at`.

Indexes:
- `UNIQUE (source_text_hash, accent, voice_name)` → cache lookup.
- `(source_type, source_id)` → reverse lookup by source.

`dictionary_entries.audio_us_url` and `audio_uk_url` are populated by the precompute script and by the API endpoint on first request.

### API endpoint

`POST /api/v1/dictionary/entries/:id/tts`
- Auth: required (JWT).
- Rate limit: 30 req/min/user (skipped under `NODE_ENV=test`).
- Body: `{ accent: 'us' | 'uk' }` (snake_case JSON).
- Response: `{ success: true, data: { audio_url, cached } }`.
- Logic: short-circuit `cached: true` if `audio_us_url` / `audio_uk_url` already set on the entry. Otherwise call `ttsService.generateAudio(...)` and `UPDATE` the entry.
- Errors: 404 `NOT_FOUND` (entry missing), 400 `VALIDATION_ERROR` (bad accent), 500 `TTS_GENERATION_FAILED` (TTS service threw).

### Storage path convention

R2 keys:
- `dictionary/us/<hash>.mp3`
- `dictionary/uk/<hash>.mp3`
- `dictionary_example/us|uk/<hash>.mp3` (when `source_type === 'dictionary_example'`)
- `ebook_paragraph/us|uk/<hash>.mp3` (when `source_type === 'ebook_paragraph'`)

`<hash>` = `sha256(text + '|' + accent + '|' + voice_name).slice(0, 16)`.
Folder is `dictionary` only when `source_type === 'dictionary_headword'`; otherwise folder = the raw `source_type`.

### Rules for future TTS work

1. **Adding TTS for new content** (example sentences, ebook paragraphs):
   - Reuse `ttsService.generateAudio` with a different `source_type`. Do NOT create a parallel service.
2. **Changing voice** (`VOICE_US` / `VOICE_UK` in [services/ttsService.ts](services/ttsService.ts)):
   - The hash includes `voice_name`, so changing voice invalidates the entire cache. Plan for a regen pass + bucket cleanup if you switch voices.
3. **SSML support** (custom IPA, stress):
   - Switch the request body from `{ input: { text } }` to `{ input: { ssml } }`. Google bills SSML at 2× the per-character rate — update the cost estimator in [scripts/precompute-dictionary-audio.ts](scripts/precompute-dictionary-audio.ts) if you do this.
4. **On-device TTS** (`flutter_tts`):
   - Server-side Google TTS is the primary path. `flutter_tts` is reserved as an offline fallback for Phase 12 — do NOT ship it as the default.

---

## Word Translation (AI) — DONE ✅

- Provider: Anthropic Codex via `@anthropic-ai/sdk`.
- Service: [services/wordTranslationService.ts](services/wordTranslationService.ts) — `normalizeWord`, `translateWord(entry, context?)`, plus batch fallback. Throws `TranslationFailedError` on hard fail.
- Cache: `word_translation_cache` (text → translation_vi, last_used_at) — added by migration 26. In-memory LRU on top.
- Used by: retrieval practice (`/api/v1/retrieval`), ebook translation endpoint (gated by `requireFeature('translation_daily')`).

## Notifications + FCM — DONE ✅

- Service: [services/notificationService.ts](services/notificationService.ts) — `createNotification(userId, type, title, message, link_url?)`, `fireNotification` (insert + push).
- Tables: `user_notifications`, `user_fcm_tokens` (migration 28).
- API: `routes/api/notifications.ts` — list (filter all/unread/system, 10s cache), mark-read, mark-all-read, delete, register/unregister FCM token.

## Subscription feature gating — DONE ✅

- Middleware: [middlewares/requireFeature.ts](middlewares/requireFeature.ts) — looks up active subscription's `plan_features.feature_value`, compares against today's usage, returns 403 `QUOTA_EXCEEDED` when out.
- Currently gates:
  - `flashcard_max_decks` on POST `/api/v1/decks/create`
  - `retrieval_practice_daily` on POST `/api/v1/retrieval/start` and `/sentence`
  - `translation_daily` on ebook word-translation endpoint
- Helpers: [utils/subscriptionHelper.ts](utils/subscriptionHelper.ts) — `getActiveSubscription`, `getFeaturesForUser`, `getUsage`, `computeSubscriptionBadge`, `calcPeriodEnd`.

---

## Conventions and gotchas

- **Always** use `apiSuccess` / `apiError` for `/api/v1/*` responses; never hand-roll `res.json(...)` with `{success}`.
- **Always** wrap async API handlers with `asyncHandler` so `errorHandler` catches PG errors.
- **Web routes** don't currently flow through `errorHandler` (they render or redirect on failure) — keep web errors local.
- New API resource? Mount **before** the broad `/api/v1` cards mount in `app.ts`.
- New migration? Append to the `migrations` array in `database/migrate.ts` with a never-changing `key`. Do not edit historical migrations once deployed.
- Rate limiters skip under `NODE_ENV=test` — production rate limits are real, watch the per-user TTS limit (30/min).
- The codebase has loose TS strictness — actively check for null/undefined; the compiler won't.
- `injectAdmin` runs on every request including API. It's cheap for non-super_admin but does sidebar count queries for super_admin sessions — keep it that way.
