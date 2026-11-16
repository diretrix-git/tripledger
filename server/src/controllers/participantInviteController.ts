import type { Request, Response } from 'express';
import type { EmailDeliveryService } from '../services/emailService.js';
import {
  claimParticipantInviteForUser,
  issueParticipantInvite,
  listPendingInvitesForVerifiedUser,
  listTripParticipantInvitesForOrganizer,
  revokeParticipantInviteForTrip,
} from '../services/participantInviteService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';

export interface ParticipantInviteHandlersOptions {
  emailDeliveryService?: EmailDeliveryService;
}

export function createParticipantInviteHandlers(options: ParticipantInviteHandlersOptions = {}) {
  const createParticipantInvite = asyncHandler(async (req: Request, res: Response) => {
    const trip = req.trip!;
    const actor = req.participant!;
    const { participantId } = req.params;
    if (typeof participantId !== 'string') {
      throw new AppError('Participant identifier is required.', 400, 'INVALID_ID');
    }

    const result = await issueParticipantInvite({
      trip,
      actorUserId: req.user?.userId,
      actorParticipant: actor,
      targetParticipantId: participantId,
      body: req.body,
      emailDeliveryService: options.emailDeliveryService,
    });

    sendSuccess(res, result, 201);
  });

  const listTripParticipantInvites = asyncHandler(async (req: Request, res: Response) => {
    const trip = req.trip!;
    const invites = await listTripParticipantInvitesForOrganizer(trip._id);
    sendSuccess(res, { invites });
  });

  const revokeParticipantInvite = asyncHandler(async (req: Request, res: Response) => {
    const trip = req.trip!;
    const actor = req.participant!;
    const { inviteId } = req.params;
    if (typeof inviteId !== 'string') {
      throw new AppError('Invitation identifier is required.', 400, 'INVALID_ID');
    }

    const result = await revokeParticipantInviteForTrip({
      tripId: trip._id,
      inviteId,
      actorUserId: req.user?.userId,
      actorParticipant: actor,
    });

    sendSuccess(res, result);
  });

  const listPendingParticipantInvites = asyncHandler(async (req: Request, res: Response) => {
    if (!req.verifiedUser) {
      throw new AppError('Email verification is required.', 403, 'EMAIL_NOT_VERIFIED');
    }
    const invites = await listPendingInvitesForVerifiedUser(req.verifiedUser.userId);
    sendSuccess(res, { invites });
  });

  const claimParticipantInvite = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
      throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
    }

    const result = await claimParticipantInviteForUser({
      userId: req.user.userId,
      body: req.body,
    });

    sendSuccess(res, result);
  });

  return {
    createParticipantInvite,
    listTripParticipantInvites,
    revokeParticipantInvite,
    listPendingParticipantInvites,
    claimParticipantInvite,
  };
}
