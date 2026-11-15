import type { NextFunction, Request, Response } from 'express';
import type { TripRole } from '@tripledger/shared';
import { ParticipantModel, TripModel, type IParticipant, type ITrip } from '../models/index.js';
import { AppError } from '../utils/http.js';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/tokens.js';

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      trip?: ITrip;
      participant?: IParticipant;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new AppError('Authentication required. Please log in.', 401, 'UNAUTHORIZED'));
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch {
    next(new AppError('Invalid or expired access token.', 401, 'TOKEN_EXPIRED'));
  }
}

/**
 * Verifies that the authenticated user is an active participant in `:tripId`
 * and holds one of `allowedRoles` (or any role if `allowedRoles` is omitted).
 */
export function requireTripRole(allowedRoles?: TripRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
      }

      const { tripId } = req.params;
      if (!tripId) {
        throw new AppError('Trip ID parameter is required.', 400, 'BAD_REQUEST');
      }

      const trip = await TripModel.findById(tripId);
      if (!trip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }

      let participant = await ParticipantModel.findOne({
        tripId: trip._id,
        userId: req.user.userId,
        isActive: true,
      });

      // Auto-link guest participant by matching email if not linked yet
      if (!participant && req.user.email) {
        const matchingGuest = await ParticipantModel.findOne({
          tripId: trip._id,
          email: req.user.email.toLowerCase(),
          userId: null,
          isActive: true,
        });
        if (matchingGuest) {
          matchingGuest.userId = trip.createdBy.equals(req.user.userId)
            ? matchingGuest.userId
            : (req.user.userId as unknown as typeof matchingGuest.userId);
          await matchingGuest.save();
          participant = matchingGuest;
        }
      }

      if (!participant) {
        throw new AppError(
          'You do not have access to this trip.',
          403,
          'FORBIDDEN_TRIP_ACCESS'
        );
      }

      if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(participant.role)) {
        throw new AppError(
          `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}. Your role: ${participant.role}.`,
          403,
          'INSUFFICIENT_ROLE'
        );
      }

      req.trip = trip;
      req.participant = participant;
      next();
    } catch (err) {
      next(err);
    }
  };
}
