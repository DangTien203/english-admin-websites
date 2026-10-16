import { Router } from 'express';
import ctrl from '../controllers/dictionaryController';
import { requireAuth, requireRole } from '../middlewares/auth';

const router = Router();

router.use(requireAuth);

// The entry page and the editor are also open to content_editor, so the review screen of the entries made by the
// enrichment job (/lookup/review) can send an editor to "Sửa". Creating, importing and deleting stay super_admin / moderator.
const staff = requireRole('super_admin', 'moderator');
const editors = requireRole('super_admin', 'moderator', 'content_editor');

// Static routes BEFORE /:id
router.get('/',            staff, ctrl.getIndex);
router.get('/create',      staff, ctrl.getCreate);
router.post('/create',     staff, ctrl.postCreate);
router.get('/import',      staff, ctrl.getImport);
router.post('/import',     staff, ctrl.postImport);

// Parameterized routes
router.get('/:id',         editors, ctrl.getShow);
router.get('/:id/edit',    editors, ctrl.getEdit);
router.post('/:id/edit',   editors, ctrl.postEdit);
router.post('/:id/delete', staff, ctrl.postDelete);

export = router;
