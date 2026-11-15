import { Router } from 'express';
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
import { requireAuth, requireTripRole } from '../middleware/auth.js';

export const dashboardRouter = Router();
dashboardRouter.get('/summary', requireAuth, getDashboardSummary);

export const tripRouter = Router();

tripRouter.use(requireAuth);

tripRouter.post('/', createTrip);
tripRouter.get('/', listTrips);
tripRouter.post('/join/:inviteCode', joinTripByInviteCode);

tripRouter.get('/:tripId', requireTripRole(), getTripById);
tripRouter.patch('/:tripId', requireTripRole(['ORGANIZER']), updateTrip);
tripRouter.patch('/:tripId/checklist', requireTripRole(['ORGANIZER']), updateChecklistItem);
tripRouter.post('/:tripId/close', requireTripRole(['ORGANIZER']), closeTrip);

// Participants
tripRouter.post('/:tripId/participants', requireTripRole(['ORGANIZER']), addParticipant);
tripRouter.patch(
  '/:tripId/participants/:participantId',
  requireTripRole(['ORGANIZER']),
  updateParticipant
);
tripRouter.delete(
  '/:tripId/participants/:participantId',
  requireTripRole(['ORGANIZER']),
  removeParticipant
);

// Families
tripRouter.post('/:tripId/families', requireTripRole(['ORGANIZER']), createFamily);
tripRouter.patch('/:tripId/families/:familyId', requireTripRole(['ORGANIZER']), updateFamily);
tripRouter.delete('/:tripId/families/:familyId', requireTripRole(['ORGANIZER']), deleteFamily);
