import { Router } from 'express';
import {
  approveOrConfirmExpense,
  createExpense,
  listExpenses,
  softDeleteExpense,
  updateExpense,
} from '../controllers/expenseController.js';
import { requireTripRole } from '../middleware/auth.js';

export const expenseRouter = Router({ mergeParams: true });

expenseRouter.get('/', requireTripRole(), listExpenses);
expenseRouter.post(
  '/',
  requireTripRole(['ORGANIZER', 'CONTRIBUTOR', 'FAMILY_REP']),
  createExpense
);
expenseRouter.patch(
  '/:expenseId',
  requireTripRole(['ORGANIZER', 'CONTRIBUTOR', 'FAMILY_REP']),
  updateExpense
);
expenseRouter.post(
  '/:expenseId/approve',
  requireTripRole(['ORGANIZER']),
  approveOrConfirmExpense
);
expenseRouter.delete(
  '/:expenseId',
  requireTripRole(['ORGANIZER']),
  softDeleteExpense
);
