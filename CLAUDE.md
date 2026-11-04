# CLAUDE.md

Express + TypeScript (CommonJS) app with two surfaces sharing one app, PG pool and models: an **admin dashboard** (EJS, session cookie) and a **mobile REST API** `/api/v1/*` (JWT, Flutter client). A pg-boss **enrichment worker** (`worker.ts`) fills the dictionary. No `src/`: source is at the repo root (`controllers/ models/ routes/ routes/api/ services/ middlewares/ utils/ views/ database/ scripts/ tests/`). Dev runs `.ts` via tsx; prod compiles to `dist/`.

Routes and mounts: read `app.ts`. Mobile endpoint list: `MOBILE_API_ENDPOINTS.md`. Schema: `database/migrations/`. Scripts: `package.json`.

## Commands

```bash
npm run dev | worker      # nodemon+tsx app.ts on :3000 | pg-boss enrichment worker
npm run typecheck | build # tsc --noEmit | tsc → dist/
npm test [-- file | -t "name"]   # jest, sequential, real PG; runs check:env-example first
npm run db:migrate        # idempotent, tracked in schema_migrations
```

- Tests hit the **same remote Postgres as dev** (no test DB, no mocks), `maxWorkers: 1` (never parallelize), and need `JWT_SECRET` in `.env`. Fixtures are cleaned by pattern; killed runs leave rows → `npm run clean:test-data` (dry run unless `-- --confirm`).
- `db:seed`, `db:reset`, `db:fresh`, `scripts/seed-mobile-test-users.ts` **wipe/drop tables**. They refuse `NODE_ENV=production` or a non-local DB unless `--i-know-this-wipes-tables` (test-users script: `--i-know-this-sets-a-known-password`). Don't run them or add the flag without the user's explicit go-ahead. `db:fresh` can't forward the flag; run `db:reset` and `db:seed` separately.
- `npm run admin:create -- --email <e> --name <n>` inserts one super_admin (random password printed once). No admin credentials live in the repo; never add any.
- Enrichment/lookup scripts (`enrich:*`, `oxford:apply-cefr`, `acceptance:lookup`, `scripts/dev/cleanup-auto-entries.ts`, …) spend API tokens and/or write to the shared DB: dry-run by default, act only with `--confirm` (`oxford:apply-cefr` applies unless `--dry-run`); script flags need `--` after the npm script name. Oxford seeding needs `ENRICHMENT_ENABLED=true` and `ENRICHMENT_PUBLISH_POLICY=review` set in the command's environment (never edit `.env`) and ONE worker. Procedures: `docs/lookup-runbook.md`.
- `.env.example` must match the schema in `config/lookup.ts` (names and defaults); change both together. Required env not in `.env.example`: `JWT_SECRET`, `GOOGLE_TTS_API_KEY`, `R2_*` (endpoint, keys, bucket, public URL), `OPENAI_API_KEY`; `DATABASE_URL` (Railway) overrides `DB_*`.
- `bench:api` (latency + statements per request, in-process on the `.env` DB), `test:chaos` (slow, not in `npm test`) — see Performance / `docs/lookup-chaos.md`.

## Architecture rules

- **app.ts order matters.** Session, `connect-flash` and `injectAdmin` are wrapped in `webOnly(...)`, so `/api/*` never gets a session or `connect.sid` (`tests/e2e/apiNoSession.test.ts`). A new session-authenticated route lives outside `/api` and must be added to the `requireSameOrigin` prefix list in `app.ts` (CSRF: refuses cross-origin POST/PUT/PATCH/DELETE; `/api/v1` is excluded on purpose).
- `injectAdmin` runs on every web request and fetches sidebar counts for super_admin (cached, `utils/pendingCounts.ts`). Don't add expensive queries to it.
- A new `/api/v1/<resource>` mount goes **before** the broad `app.use('/api/v1', requireApiAuth, apiCardsRoutes)` (it must stay last; it catches everything else).
- `errorHandler` (last middleware) maps PG `23505`→409, `23503`→400 and Multer errors to JSON. Wrap every async API handler in `utils/asyncHandler.ts`. Web routes don't use it: render or redirect locally.
- Responses: `apiSuccess(res, data, message?)`, `apiError(res, statusCode, code, message, details?)`. **Status code comes before the error code.** Never hand-roll `{ success }`.
- Body validation: `validateBody(zodSchema, { rejectEmpty? })` mutates `req.body` to the parsed result; failure is 400 `VALIDATION_ERROR`; `rejectEmpty` for PATCH.
- Web auth: `requireAuth`, `requireRole(...)`, `redirectIfAuth` (`middlewares/auth.ts`). API auth: `requireApiAuth` / `optionalApiAuth` (guest allowed), which loads `req.user` (cached 15 s) and blocks `status='banned'`. `requireFeature('<key>')` is the subscription-quota gate (403 `QUOTA_EXCEEDED`).
- Models are thin `pool.query` wrappers (no ORM). Read neighbouring models before adding one.
- Web views: EJS + express-ejs-layouts, `views/layouts/main.ejs` (auth pages use `layouts/auth`); `res.locals.admin`; flash `success|error|warning`. Admin e-mails match trimmed, case-insensitive (`normalizeEmail`, `LOWER(email)`).
- Rate limiters (`middlewares/rateLimiter.ts`, TTS limiter in `routes/api/dictionary.ts`) are skipped under `NODE_ENV=test` but real in prod; `trust proxy` = 1 (Railway).
- Single-word headwords: `utils/headword.ts` is the ONE rule (`isHeadword`, `headwordProblem`, …). Don't write another pattern (`tests/lookup/headword.test.ts` scans for one).
- Loose TS (`strict: false`, no null checks): the compiler won't catch null/undefined, so check by hand. `tsconfig.json` excludes `scripts/` and `tests/` (they use `tsconfig.scripts.json` / `tsconfig.test.json`); runtime code must not import them. `.mts` scripts run with `tsx`, not `node`.

### Admin roles

`super_admin | content_editor | moderator` (`admin_accounts.role`). The `requireRole(...)` calls in `routes/*.ts` are the source of truth; most content routes are `super_admin`+`moderator` only. Exceptions:

- `/admins`, `/approvals`, `/subscriptions`: super_admin only. `/admins` edits OTHER admins (own account → `/profile`); the last active super_admin can't be demoted/disabled; role/status/e-mail/password changes end the target's sessions (`utils/adminSessions.ts`); every change is written to `audit_logs`.
- `/lookup`: read for any admin; writes (send words, retry, publish, hide, bulk publish, edit a sense's Vietnamese) for super_admin and content_editor (moderator gets 403). `content_editor` can also open `/dictionary/:id` and `/dictionary/:id/edit`.
- `published` (entry editor, `POST /dictionary/create`) is settable only by super_admin and content_editor; for others it is ignored and logged `forbidden`, and a moderator's new entry is created hidden.

## Database

- One `pg.Pool` ([config/db.ts](config/db.ts)); any new `new Pool()` must call `attachPoolErrorHandlers` ([config/poolErrors.ts](config/poolErrors.ts)) so a dropped Neon connection doesn't crash the process.
- New migration: next-numbered file in `database/migrations/` + append to the `migrations` array in [database/migrate.ts](database/migrate.ts) with a unique `key`. Never rename a key or edit a deployed migration. Each runs in its own transaction. Railway start = `node dist/database/migrate.js && node dist/app.js`, so migrations run on every deploy.

## Performance

The DB is remote (Neon): a statement is a ~60 ms round trip (a NEW connection ~700 ms) and runs in 1–4 ms, so **cost = number of statements a request waits for in sequence**. `npm run bench:api` prints per call `queries` (statements before the response), `bg` (after), `conns`; compare `queries` first (network noise is large); flags `--only --runs --out --compare --trace --idle-test`. Rules:

- Independent reads go together (`Promise.all`). The user is already on `req.user`.
- A multi-statement write is ONE statement: data-modifying CTEs (`WITH … INSERT/UPDATE … RETURNING`) instead of BEGIN…COMMIT. **Never `await` a query in a loop**: pass arrays and `unnest()` / `jsonb_to_recordset`.
- "Lock, then act" is one statement: read-committed CTEs of a statement share one snapshot taken before any lock wait, so lock the deciding row with `FOR UPDATE` in a `claim` CTE that every later CTE reads from, and use earlier reads only for facts that can't change. Examples: Leitner answer `ANSWER_STEP_SQL` (`services/leitnerSessionService.ts`, shares `moveCardCtes()` with `moveCard`); practice completion in `routes/api/practice.ts` (`UPDATE … WHERE completed_at IS NULL` claim gates `practiceAdvanceCtes()`). A new statement of this kind needs a test firing the same request many times at once (`tests/leitnerSessionConcurrency.test.ts`, `tests/practiceSessionCompletion.test.ts`).
- Caches go through `utils/ttlCache.ts` (`TtlCache`: TTL + size cap + single flight; **off under `NODE_ENV=test`**, a cache test flips it briefly, see `tests/authCacheE2E.test.ts`). EVERY writer in this process must call the cache's `invalidate…`; another process's write shows after the TTL. A new cache needs all its invalidations plus a test. Existing:
  - `utils/authUserCache.ts` (`req.user`, 15 s): dropped by the `User` model writes, profile API PATCH/avatar, and streak changes (not a 2nd activity the same day).
  - `utils/subscriptionHelper.ts` (active subscription + badge per user 30 s; plan features 5 min): `invalidateSubscriptionCache(userId)` on payment approve/reject, checkout, cancel; `invalidatePlanCache()` on every plan edit in `Subscription`.
  - `utils/pendingCounts.ts` (sidebar badges, 10 s): `Approval` create/approve/reject, `Subscription` approve/reject, mobile checkout.
  - `utils/gameCatalogCache.ts` (public game catalogs, 60 s): every write in `models/Game.ts`.
  - TTL only: answer-grading prompt templates (60 s), `/dictionary/categories` (5 min).
- Already one-statement paths; don't undo with extra sequential reads: answer grading (`ENTRY_REFERENCE_SQL`, `services/answerGradingService.ts`), streak (`loadStreakSummary`, `recordActivity` logs + updates in one statement), ebook lookup (`LookupInput.paragraphId` may be a promise so the paragraph check overlaps the lookup).

## Domain notes

### Mobile server support

| Endpoint | Behavior | Tests |
|---|---|---|
| `GET /api/v1/health` | Public, no DB by default; `?db=1` runs one `SELECT 1` (503 on failure); never cached. | `mobileHealth.test.ts` |
| `POST /api/v1/practice/questions` | Auth; 1–20 `card_ids`, `type=swift_choice\|cloze`, optional `level` (default 1). Ordered array of existing question shapes or per-item errors; one bulk data statement, same builders/access rules as singles. Enables 5–10-question client prefetch. | `practiceQuestions.test.ts` |

- **Leitner** (`utils/leitnerManager.ts`, `services/leitnerSessionService.ts`): boxes 1–5. In review sessions, box 4/5 words are checked on both English and Vietnamese meaning, ≥2 steps apart (both right → next box, one right → box kept and due again in 1 day in box 4 / 2 days in box 5 instead of the box's own interval, `HOLD_INTERVAL_DAYS` in `leitnerManager.ts`; none → box 1). `POST /leitner/review` is box 1–3 only (409 `REVIEW_SESSION_REQUIRED` otherwise). `/session/start` takes optional `box_number` and offers only that box's DUE words. A Vietnamese answer to an English check is wrong, decided before cache/OpenAI (`utils/answerLanguage.ts`). Legacy `/api/v1/review` stays for old client builds.
- **TTS**: Google Cloud TTS REST → R2 → `tts_cache`, via `services/ttsService.ts` `generateAudio({ text, accent, source_type, source_id? })`. New audio uses it with another `source_type`; no parallel service. The cache hash includes `voice_name`, so changing `VOICE_US`/`VOICE_UK` invalidates the whole cache (plan a regen + bucket cleanup). SSML is billed 2×; update the estimator in `scripts/precompute-dictionary-audio.ts` if adopted. `flutter_tts` is only an offline fallback, never the default.
- **Lookup / enrichment** (`POST /api/v1/ebooks/:id/lookup`, pg-boss worker, `[auto]` entries reviewed in `/lookup/review`): docs are in Vietnamese in `docs/lookup-*.md`. Precedence on conflict: real migrations > `docs/lookup-spec.md` > prompts. Start with `lookup-spec.md` (design), `lookup-runbook.md` (ops and scripts), `lookup-admin.md` (admin pages), `lookup-queue.md`, `lookup-enrichment.md`, `lookup-api.md` (response changes are additive only: never rename, move or retype an existing field).
- Subscription gates in use: `flashcard_max_decks` (POST decks/create), `retrieval_practice_daily` (retrieval start/sentence), `translation_daily` (ebook word translation).
