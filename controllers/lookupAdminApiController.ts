import type { Request, RequestHandler, Response } from 'express';
import { AdminHttpError, getLookupAdminService, type LookupAdminService } from '../services/lookup/adminService';
import { apiError, apiSuccess } from '../utils/apiResponse';
import { logAdminAction, type AdminAction } from '../utils/adminAudit';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * JSON endpoints of the lookup / enrichment admin pages (P8), mounted at /lookup/api (routes/lookup.ts). Answers use the same
 * envelope as the mobile API (apiSuccess / apiError); JSON fields are snake_case. Session auth, roles in routes/lookup.ts.
 *
 * Reads just answer. Every write goes through `write()`, which logs one admin_action line (docs/lookup-admin.md) however it ends.
 */

const service = (): LookupAdminService => getLookupAdminService();

function refuse(res: Response, err: AdminHttpError): void {
  apiError(res, err.status, err.code, err.message, err.details);
}

/** A read: the data, or the refusal. */
const read = (work: (req: Request) => Promise<unknown>): RequestHandler =>
  asyncHandler(async (req, res) => {
    try {
      apiSuccess(res, await work(req));
    } catch (err) {
      if (err instanceof AdminHttpError) return refuse(res, err);
      throw err;
    }
  });

interface WriteOutcome {
  data: unknown;
  /** counters for the log line */
  log?: AdminAction['extra'];
}

/** A write: logs admin_action (ok / rejected:<code> / error) and answers. `target` says what the call is about. */
const write = (
  action: string,
  target: (req: Request) => AdminAction['target'],
  work: (req: Request, adminId: string) => Promise<WriteOutcome>
): RequestHandler =>
  asyncHandler(async (req, res) => {
    const adminId = req.session.admin!.id;
    try {
      const out = await work(req, adminId);
      logAdminAction({ adminId, action, target: target(req), result: 'ok', extra: out.log });
      apiSuccess(res, out.data);
    } catch (err) {
      if (err instanceof AdminHttpError) {
        logAdminAction({ adminId, action, target: target(req), result: `rejected:${err.code}` });
        return refuse(res, err);
      }
      logAdminAction({ adminId, action, target: target(req), result: 'error' });
      throw err;
    }
  });

const idParam = (req: Request) => String(req.params.id ?? '');

const lookupAdminApiController = {
  // GET /lookup/api/jobs
  listJobs: read((req) => service().listJobs(req.query as Record<string, unknown>)),

  // GET /lookup/api/auto-entries
  listAutoEntries: read((req) => service().listAutoEntries(req.query as Record<string, unknown>)),

  // GET /lookup/api/auto-entries/:id
  getAutoEntry: read((req) => service().getAutoEntryDetail(idParam(req))),

  // GET /lookup/api/health   (the snapshot of `npm run health:snapshot`, keys as they are)
  getHealth: read(() => service().getHealth()),

  // GET /lookup/api/missing-words?days=7|30
  getMissingWords: read((req) => service().missingWords(req.query.days)),

  // POST /lookup/api/jobs   { words: string[] | string }
  addWords: write(
    'jobs.add_words',
    () => ({ type: 'job' }),
    async (req) => {
      const out = await service().addWords((req.body ?? {}).words);
      return { data: out, log: out.summary };
    }
  ),

  // POST /lookup/api/jobs/:id/retry
  retryJob: write(
    'jobs.retry',
    (req) => ({ type: 'job', id: idParam(req) }),
    async (req) => {
      const out = await service().retryJob(idParam(req));
      return { data: out, log: { word_sent: out.result.status === 'queued', result_status: out.result.status } };
    }
  ),

  // POST /lookup/api/auto-entries/:id/publish
  publishEntry: write(
    'entry.publish',
    (req) => ({ type: 'entry', id: idParam(req) }),
    async (req, adminId) => {
      const out = await service().setPublished(idParam(req), true, adminId);
      return { data: out, log: { changed: out.changed, tier_a_missing: out.tier_a_missing.length } };
    }
  ),

  // POST /lookup/api/auto-entries/:id/hide
  hideEntry: write(
    'entry.hide',
    (req) => ({ type: 'entry', id: idParam(req) }),
    async (req, adminId) => {
      const out = await service().setPublished(idParam(req), false, adminId);
      return { data: out, log: { changed: out.changed } };
    }
  ),

  // PATCH /lookup/api/auto-entries/:id/senses/:senseId   { definition_vi?: string, examples?: [{ id, example_vi }] }
  editSense: write(
    'entry.edit_sense',
    (req) => ({ type: 'entry', id: idParam(req) }),
    async (req, adminId) => {
      const out = await service().editSense(idParam(req), String(req.params.senseId ?? ''), req.body, adminId);
      return { data: out, log: { changed: out.changed, fields: out.changes.length } };
    }
  ),

  // POST /lookup/api/auto-entries/bulk-publish   { entry_ids: string[] }
  bulkPublish: write(
    'entry.bulk_publish',
    () => ({ type: 'entry' }),
    async (req, adminId) => {
      const out = await service().bulkPublish((req.body ?? {}).entry_ids, adminId);
      return { data: out, log: { requested: out.requested, published: out.published.length, skipped: out.skipped.length } };
    }
  ),

  // anything else under /lookup/api
  notFound: ((_req: Request, res: Response) => {
    apiError(res, 404, 'NOT_FOUND', 'Endpoint not found');
  }) as RequestHandler,
};

export = lookupAdminApiController;
