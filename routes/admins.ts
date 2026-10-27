import { Router } from 'express';
import adminController from '../controllers/adminController';
import { requireRole } from '../middlewares/auth';

const router = Router();

// Editing admin accounts is a super admin power: roles, status and passwords of other admins.
router.use(requireRole('super_admin'));

router.get('/',          adminController.getIndex);
router.get('/:id/edit',  adminController.getEdit);
router.post('/:id/edit', adminController.postEdit);

export = router;
