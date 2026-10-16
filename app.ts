import 'dotenv/config';
// Validates lookup / enrichment env vars at boot: invalid values stop the process with a clear message.
import { lookupConfig } from './config/lookup';
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import flash from 'connect-flash';
import path from 'path';
import expressLayouts from 'express-ejs-layouts';

import { injectAdmin } from './middlewares/auth';
import { requireSameOrigin } from './middlewares/sameOrigin';
import { errorHandler } from './middlewares/errorHandler';
import pool from './config/db';
import { startEnrichmentRuntime } from './services/queue';
import { errMessage, logEvent } from './services/queue/log';
import { installShutdownHandlers } from './services/queue/shutdown';
import { apiError } from './utils/apiResponse';

import cors from 'cors';
import { requireApiAuth } from './middlewares/apiAuth';
import apiAuthRoutes from './routes/api/auth';
import apiProfileRoutes from './routes/api/profile';
import apiDictionaryRoutes from './routes/api/dictionary';
import apiDecksRoutes from './routes/api/decks';
import apiCardsRoutes from './routes/api/cards';
import apiReviewRoutes from './routes/api/review';
import apiLeitnerRoutes from './routes/api/leitner';
import apiPracticeRoutes from './routes/api/practice';
import apiSubscriptionsRoutes from './routes/api/subscriptions';
import apiEbooksRoutes from './routes/api/ebooks';
import apiGamesRoutes from './routes/api/games';
import apiRetrievalRoutes from './routes/api/retrieval';
import apiHomeRoutes from './routes/api/home';
import apiNotificationsRoutes from './routes/api/notifications';

import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import approvalsRoutes from './routes/approvals';
import usersRoutes from './routes/users';
import profileRoutes from './routes/profile';
import dictionaryRoutes from './routes/dictionary';
import lessonsRoutes from './routes/lessons';
import decksRoutes from './routes/decks';
import ebooksRoutes from './routes/ebooks';
import subscriptionsRoutes from './routes/subscriptions';
import settingsRoutes from './routes/settings';
import gamesRoutes from './routes/games';
import aiContentRoutes from './routes/ai-content';
import lookupRoutes from './routes/lookup';

const app = express();

// Trust Railway's reverse proxy so req.ip reflects the real client (rate limiter depends on this).
app.set('trust proxy', 1);

// Resolve project root — works both in dev (tsx from root) and prod (node dist/app.js from root).
const PROJECT_ROOT = process.cwd();

// ── View Engine ──
app.set('view engine', 'ejs');
app.set('views', path.join(PROJECT_ROOT, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// ── Static Files ──
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// ── Body Parser ──
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));

// CORS — cho phép mobile app gọi API
app.use(cors());

// ── API request logger (dev only) ──
if (process.env.NODE_ENV !== 'production') {
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(
        `${req.method} ${req.originalUrl} — ${res.statusCode} — ${Date.now() - start}ms`
      );
    });
    next();
  });
}

// ── Session ──
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      // Not sent on cross-site POST / fetch (CSRF); still sent when an admin follows a link to the dashboard.
      sameSite: 'lax',
      // HTTPS only in production (trust proxy above lets express-session see Railway's X-Forwarded-Proto).
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

// ── Flash Messages ──
app.use(flash());

// ── CSRF: reject cross-site writes on every path that authenticates with the session cookie ──
// /api/v1/* is left out on purpose (JWT Bearer, no cookie). A new session-authenticated mount below must be added here too.
app.use(
  [
    '/auth', '/dashboard', '/approvals', '/users', '/profile', '/dictionary', '/lessons', '/decks',
    '/ebooks', '/subscriptions', '/settings', '/games', '/ai-content', '/lookup',
  ],
  requireSameOrigin
);

// ── Inject Admin Data vào tất cả Views ──
app.use(injectAdmin);

// ── Routes ──
app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/approvals', approvalsRoutes);
app.use('/users', usersRoutes);
app.use('/profile', profileRoutes);
app.use('/dictionary', dictionaryRoutes);
app.use('/lessons', lessonsRoutes);
app.use('/decks', decksRoutes);
app.use('/ebooks', ebooksRoutes);
app.use('/subscriptions', subscriptionsRoutes);
app.use('/settings', settingsRoutes);
app.use('/games', gamesRoutes);
app.use('/ai-content', aiContentRoutes);
app.use('/lookup', lookupRoutes);

// API routes cho mobile app
//Phase 1: auth
app.use('/api/v1/auth', apiAuthRoutes);
//Phase 2: profile
app.use('/api/v1/profile', requireApiAuth, apiProfileRoutes);
//Phase 3: dictionary
app.use('/api/v1/dictionary', apiDictionaryRoutes);
//Phase 4: decks & Flashcards
app.use('/api/v1/decks', requireApiAuth, apiDecksRoutes);
//Phase 5: review
app.use('/api/v1/review', requireApiAuth, apiReviewRoutes);
//Phase 6: leitner
app.use('/api/v1/leitner', requireApiAuth, apiLeitnerRoutes);
//Phase 6: practice (replaces /study/* and /review/* for mobile)
app.use('/api/v1/practice', requireApiAuth, apiPracticeRoutes);
//Phase 7: subscriptions (plans public, others auth) — must be before broad /api/v1 catch-all
app.use('/api/v1/subscriptions', apiSubscriptionsRoutes);
//Phase 8: retrieval practice
app.use('/api/v1/retrieval', requireApiAuth, apiRetrievalRoutes);
//Phase 9: ebooks
app.use('/api/v1/ebooks', requireApiAuth, apiEbooksRoutes);
//Phase 10: games (levels/word-lists/semantic-sets public; runs/leaderboard/stats auth handled per-route)
app.use('/api/v1/games', apiGamesRoutes);
//Phase 11: home (dashboard auth, word-of-the-day public — handled per-route)
app.use('/api/v1/home', apiHomeRoutes);
//Phase 11: notifications (all endpoints auth)
app.use('/api/v1/notifications', requireApiAuth, apiNotificationsRoutes);
// Cards routes use broad /api/v1 prefix — must come after all specific /api/v1/* mounts
app.use('/api/v1', requireApiAuth, apiCardsRoutes);

// API 404 — mọi path /api/* không match route trả JSON
app.use('/api', (_req: Request, res: Response) => {
  apiError(res, 404, 'NOT_FOUND', 'Endpoint not found');
});

// Root redirect
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/dashboard');
});

// 404 (web)
app.use((_req: Request, res: Response) => {
  res.status(404).render('404', { title: '404' });
});

// Global error handler (API JSON shape; web routes don't currently throw here)
app.use(errorHandler);


// ── Start ── (chỉ listen khi chạy trực tiếp; import trong tests không khởi server)
if (require.main === module) {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const server = app.listen(PORT, () => {
    console.log(`\n══════════════════════════════════════`);
    console.log(`  English Admin Dashboard`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`══════════════════════════════════════\n`);
  });

  // Background enrichment queue (pg-boss). Nothing happens unless ENRICHMENT_ENABLED=true.
  // ENRICHMENT_WORKER_ENABLED decides whether this process also works the queue or only sends jobs.
  if (lookupConfig.flags.enrichmentEnabled) {
    startEnrichmentRuntime('api')
      .then((runtime) => {
        // Graceful shutdown only when the queue is in use: stop taking requests, let running jobs finish, close pools.
        installShutdownHandlers([
          {
            name: 'http_server',
            run: () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeIdleConnections();
              }),
          },
          { name: 'stop_queue', run: async () => void (await runtime?.stop()) },
          { name: 'close_pool', run: () => pool.end() },
        ]);
      })
      .catch((err) => {
        // The API keeps serving: lookups still work, and an enqueue retries the pg-boss start on its next call.
        logEvent('error', 'enrichment_runtime_start_failed', { error: errMessage(err) });
      });
  }
}

export default app;