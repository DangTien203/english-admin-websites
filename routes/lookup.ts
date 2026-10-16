import { Router } from 'express';
import pages from '../controllers/lookupAdminController';
import api from '../controllers/lookupAdminApiController';
import { requireAuth, requireRole } from '../middlewares/auth';
import { requireAdminJson } from '../middlewares/adminJson';
import { LOOKUP_ADMIN_READ_ROLES, LOOKUP_ADMIN_WRITE_ROLES } from '../services/lookup/adminRules';

const router = Router();

// ── JSON endpoints (docs/lookup-admin.md) ──
// Declared before the page guard: that one redirects to the login page, which a fetch() call cannot use.
// Reading: any admin. Writing: super_admin and content_editor; a moderator gets 403 (docs/lookup-spec.md §12.6).
const read = requireAdminJson(...LOOKUP_ADMIN_READ_ROLES);
const write = requireAdminJson(...LOOKUP_ADMIN_WRITE_ROLES);
const apiRouter = Router();
apiRouter.use(read);

apiRouter.get('/jobs',                         api.listJobs);
apiRouter.post('/jobs',                  write, api.addWords);
apiRouter.post('/jobs/:id/retry',        write, api.retryJob);

// Static paths BEFORE /:id
apiRouter.get('/auto-entries',                  api.listAutoEntries);
apiRouter.post('/auto-entries/bulk-publish', write, api.bulkPublish);
apiRouter.get('/auto-entries/:id',              api.getAutoEntry);
apiRouter.post('/auto-entries/:id/publish', write, api.publishEntry);
apiRouter.post('/auto-entries/:id/hide',    write, api.hideEntry);

apiRouter.get('/health',                        api.getHealth);
apiRouter.get('/missing-words',                 api.getMissingWords);
apiRouter.use(api.notFound);

router.use('/api', apiRouter);

// ── Pages ──
router.use(requireAuth);
router.use(requireRole(...LOOKUP_ADMIN_READ_ROLES));

router.get('/',                        pages.getIndex);
router.get('/jobs',                    pages.getJobs);
router.get('/review',                  pages.getReview);
router.get('/review/:id/detail',       pages.getReviewDetail);
router.get('/health',                  pages.getHealth);

export = router;
