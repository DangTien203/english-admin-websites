import type { Request, Response } from 'express';
import { lookupConfig } from '../config/lookup';
import { AdminHttpError, getLookupAdminService, isUuid, type PageInfo } from '../services/lookup/adminService';
import { MAX_BULK_PUBLISH, MAX_WORDS_PER_REQUEST, canWriteLookupAdmin } from '../services/lookup/adminRules';
import { lk } from '../utils/lookupAdminView';

/**
 * HTML pages of the lookup / enrichment admin (P8): the enrichment queue, the review of entries made by the job, and the
 * health of the lookup path. Server-rendered like the other admin pages (EJS, flash messages, query-string filters); only the
 * actions (send words, retry, publish, hide) call the JSON endpoints of controllers/lookupAdminApiController.ts from the browser.
 *
 * Everybody with an admin account may open the pages; the buttons that change something are drawn only for the roles that
 * may use them (the endpoints refuse everybody else on their own: routes/lookup.ts).
 */

const service = () => getLookupAdminService();

/** The pagination partial (views/partials/pagination.ejs) wants camelCase. */
const forPartial = (p: PageInfo) => ({ page: p.page, limit: p.limit, total: p.total, totalPages: p.total_pages });

const common = (req: Request) => ({
  active: 'lookup',
  canWrite: canWriteLookupAdmin(req.session.admin?.role),
  enrichmentEnabled: lookupConfig.flags.enrichmentEnabled,
  lk,
});

/** A refusal of the service (bad filter, unknown entry) goes back to the page with the message; anything else is a failure. */
function fail(req: Request, res: Response, err: unknown, where: string, back: string) {
  if (err instanceof AdminHttpError) {
    req.flash('error', err.message);
  } else {
    console.error(`[LookupAdmin] ${where} error:`, err);
    req.flash('error', 'Đã xảy ra lỗi. Vui lòng thử lại.');
  }
  return res.redirect(back);
}

const q = (v: unknown): string => (typeof v === 'string' ? v : '');

const lookupAdminController = {
  // GET /lookup
  getIndex(_req: Request, res: Response) {
    return res.redirect('/lookup/jobs');
  },

  // GET /lookup/jobs
  async getJobs(req: Request, res: Response) {
    try {
      const result = await service().listJobs(req.query as Record<string, unknown>);
      res.render('lookup/jobs', {
        title: 'Hàng đợi làm giàu',
        section: 'jobs',
        ...common(req),
        jobs: result.items,
        pagination: forPartial(result.pagination),
        filters: { status: q(req.query.status), reason: q(req.query.reason), q: q(req.query.q), from: q(req.query.from), to: q(req.query.to) },
        maxWords: MAX_WORDS_PER_REQUEST,
      });
    } catch (err) {
      return fail(req, res, err, 'getJobs', '/lookup/jobs');
    }
  },

  // GET /lookup/review[?status=pending|published|all&q=&entry=<id>]
  async getReview(req: Request, res: Response) {
    try {
      const status = q(req.query.status) || 'pending';
      const result = await service().listAutoEntries({ ...req.query, status });

      let detail = null;
      const wanted = q(req.query.entry);
      if (wanted) {
        try {
          detail = await service().getAutoEntryDetail(wanted);
        } catch (err) {
          if (!(err instanceof AdminHttpError)) throw err;
          req.flash('warning', 'Không tìm thấy mục từ được chọn (có thể không phải mục từ tự tạo).');
        }
      }
      res.render('lookup/review', {
        title: 'Duyệt mục từ tự tạo',
        section: 'review',
        ...common(req),
        entries: result.items,
        pagination: forPartial(result.pagination),
        filters: { status, q: q(req.query.q) },
        selectedId: detail ? detail.id : '',
        entry: detail,
        maxBulk: MAX_BULK_PUBLISH,
      });
    } catch (err) {
      return fail(req, res, err, 'getReview', '/lookup/review');
    }
  },

  // GET /lookup/review/:id/detail   (an HTML fragment for the right-hand pane)
  async getReviewDetail(req: Request, res: Response) {
    try {
      const id = String(req.params.id ?? '');
      const entry = isUuid(id) ? await service().getAutoEntryDetail(id) : null;
      if (!entry) return res.status(404).send('<div class="alert alert-error">Không tìm thấy mục từ tự tạo.</div>');
      return res.render('lookup/entry-detail', { layout: false, ...common(req), entry });
    } catch (err) {
      if (err instanceof AdminHttpError) return res.status(err.status).send('<div class="alert alert-error">Không tìm thấy mục từ tự tạo.</div>');
      console.error('[LookupAdmin] getReviewDetail error:', err);
      return res.status(500).send('<div class="alert alert-error">Đã xảy ra lỗi. Vui lòng thử lại.</div>');
    }
  },

  // GET /lookup/health[?days=7|30]
  async getHealth(req: Request, res: Response) {
    try {
      const days = q(req.query.days) === '30' ? 30 : 7;
      const [snapshot, missing] = await Promise.all([service().getHealth(), service().missingWords(days)]);
      res.render('lookup/health', {
        title: 'Sức khỏe tra từ',
        section: 'health',
        ...common(req),
        snapshot,
        missing,
        limits: { googleMonthlyChars: lookupConfig.google.monthlyCharLimit, maxJobsPerDay: lookupConfig.queue.maxJobsPerDay },
        flags: {
          translationFallback: lookupConfig.flags.translationFallbackEnabled,
          enrichment: lookupConfig.flags.enrichmentEnabled,
          worker: lookupConfig.flags.enrichmentWorkerEnabled,
          publishPolicy: lookupConfig.flags.enrichmentPublishPolicy,
        },
      });
    } catch (err) {
      return fail(req, res, err, 'getHealth', '/dashboard');
    }
  },
};

export = lookupAdminController;
