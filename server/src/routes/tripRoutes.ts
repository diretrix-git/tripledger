import { Router } from 'express';
import { createParticipantInviteHandlers } from '../controllers/participantInviteController.js';
import {
  addParticipant,
  closeTrip,
  createFamily,
  createTrip,
  deleteFamily,
  getTripById,
  joinTripByInviteCode,
  listTrips,
  removeParticipant,
  updateChecklistItem,
  updateFamily,
  updateParticipant,
  updateTrip,
} from '../controllers/tripController.js';
import { getDashboardSummary } from '../controllers/dashboardController.js';
import { requireAuth, requireTripRole, requireVerifiedEmail } from '../middleware/auth.js';
import type { EmailDeliveryService } from '../services/emailService.js';
import { expenseRouter } from './expenseRoutes.js';
import {
  balanceRouter,
  reportRouter,
  settlementRouter,
} from './settlementAndReportRoutes.js';
import {
  createTripRateLimiters,
  resolveEffectiveRateLimitConfig,
  type TripRateLimiters,
} from '../services/rateLimitStore.js';

export const dashboardRouter = Router();
dashboardRouter.get('/summary', requireAuth, getDashboardSummary);

export interface CreateTripRouterOptions {
  rateLimiters?: TripRateLimiters;
  emailDeliveryService?: EmailDeliveryService;
}

export function createTripRouter(options: CreateTripRouterOptions = {}): Router {
  const effective = resolveEffectiveRateLimitConfig();
  const limiters =
    options.rateLimiters ??
    createTripRateLimiters({
      enabled: effective.enabled,
      storeType: effective.storeType,
    });

  const inviteHandlers = createParticipantInviteHandlers({
    emailDeliveryService: options.emailDeliveryService,
  });

  const router = Router();

  router.use(requireAuth);

  router.post('/', createTrip);
  router.get('/', listTrips);
  router.get('/invites/pending', requireVerifiedEmail, inviteHandlers.listPendingParticipantInvites);
  router.post(
    '/invites/claim',
    limiters.inviteClaimByUser,
    limiters.inviteClaimByIp,
    inviteHandlers.claimParticipantInvite
  );
  router.post(
    '/join/:inviteCode',
    limiters.joinByIp,
    limiters.joinByUser,
    joinTripByInviteCode
  );

  router.get('/:tripId', requireTripRole(), getTripById);
  router.patch('/:tripId', requireTripRole(['ORGANIZER']), updateTrip);
  router.patch('/:tripId/checklist', requireTripRole(['ORGANIZER']), updateChecklistItem);
  router.post('/:tripId/close', requireTripRole(['ORGANIZER']), closeTrip);

  // Role Invitations (Organizer-only)
  router.get('/:tripId/invites', requireTripRole(['ORGANIZER']), inviteHandlers.listTripParticipantInvites);
  router.post(
    '/:tripId/invites/:inviteId/revoke',
    requireTripRole(['ORGANIZER']),
    inviteHandlers.revokeParticipantInvite
  );

  // Participants
  router.post('/:tripId/participants', requireTripRole(['ORGANIZER']), addParticipant);
  router.post(
    '/:tripId/participants/:participantId/invites',
    requireTripRole(['ORGANIZER']),
    inviteHandlers.createParticipantInvite
  );
  router.patch(
    '/:tripId/participants/:participantId',
    requireTripRole(['ORGANIZER']),
    updateParticipant
  );
  router.delete(
    '/:tripId/participants/:participantId',
    requireTripRole(['ORGANIZER']),
    removeParticipant
  );

  // Families
  router.post('/:tripId/families', requireTripRole(['ORGANIZER']), createFamily);
  router.patch('/:tripId/families/:familyId', requireTripRole(['ORGANIZER']), updateFamily);
  router.delete('/:tripId/families/:familyId', requireTripRole(['ORGANIZER']), deleteFamily);

  // Expenses
  router.use('/:tripId/expenses', expenseRouter);

  // Balances, Settlements & Reports
  router.use('/:tripId/balances', balanceRouter);
  router.use('/:tripId/settlements', settlementRouter);
  router.use('/:tripId/reports', reportRouter);

  return router;
}

export const tripRouter = createTripRouter();
