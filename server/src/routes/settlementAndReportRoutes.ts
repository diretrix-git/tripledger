import { Router } from 'express';
import {
  createSettlement,
  getBalancesAndSuggestions,
  listSettlements,
  updateSettlementStatus,
} from '../controllers/settlementController.js';
import {
  getPublicSharedReport,
  getTripActivityLogs,
  getTripReportSummary,
} from '../controllers/reportController.js';
import { requireTripRole } from '../middleware/auth.js';

export const settlementRouter = Router({ mergeParams: true });

settlementRouter.get('/', requireTripRole(), listSettlements);
settlementRouter.post('/', requireTripRole(), createSettlement);
settlementRouter.patch(
  '/:settlementId/status',
  requireTripRole(),
  updateSettlementStatus
);

export const balanceRouter = Router({ mergeParams: true });
balanceRouter.get('/', requireTripRole(), getBalancesAndSuggestions);

export const reportRouter = Router({ mergeParams: true });
reportRouter.get('/summary', requireTripRole(), getTripReportSummary);
reportRouter.get('/activity', requireTripRole(), getTripActivityLogs);

export const publicSharedRouter = Router();
publicSharedRouter.get('/:shareToken', getPublicSharedReport);
