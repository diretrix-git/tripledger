import type { Request, Response } from 'express';
import {
  ActivityLogModel,
  ParticipantModel,
  TripModel,
} from '../models/index.js';
import { formatTripDoc } from './tripController.js';
import { loadTripLedgerData } from '../services/ledgerService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';

export const getDashboardSummary = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const memberships = await ParticipantModel.find({
    userId: req.user.userId,
    isActive: true,
  });

  const tripIds = memberships.map((m) => m.tripId);
  const trips = await TripModel.find({ _id: { $in: tripIds } }).sort({ updatedAt: -1 });
  const membershipByTrip = new Map(
    memberships.map((m) => [m.tripId.toString(), m])
  );

  let totalActiveTripExpensePaisa = 0;
  let totalOwedToMePaisa = 0;
  let totalIOwePaisa = 0;

  const tripSummaries = await Promise.all(
    trips.map(async (trip) => {
      const ledgerData = await loadTripLedgerData(trip._id);
      const myMember = membershipByTrip.get(trip._id.toString());
      const myBalance = ledgerData.ledger.individualBalances.find(
        (b) => b.participantId === myMember?._id.toString()
      );

      const outstanding = myBalance?.outstandingBalancePaisa ?? 0;
      if (trip.status !== 'CLOSED') {
        totalActiveTripExpensePaisa += ledgerData.ledger.totalApprovedExpensePaisa;
      }
      if (outstanding > 0) {
        totalOwedToMePaisa += outstanding;
      } else if (outstanding < 0) {
        totalIOwePaisa += Math.abs(outstanding);
      }

      return {
        ...formatTripDoc(trip),
        participantCount: ledgerData.participants.filter((p) => p.isActive).length,
        familyCount: ledgerData.families.length,
        totalApprovedExpensePaisa: ledgerData.ledger.totalApprovedExpensePaisa,
        totalPendingExpensePaisa: ledgerData.ledger.totalPendingExpensePaisa,
        myRole: myMember?.role ?? 'PARTICIPANT',
        myParticipantId: myMember?._id.toString() ?? null,
        myOutstandingBalancePaisa: outstanding,
        myTotalPaidPaisa: myBalance?.totalPaidPaisa ?? 0,
        myTotalSharePaisa: myBalance?.totalSharePaisa ?? 0,
      };
    })
  );

  const recentActivities = await ActivityLogModel.find({
    tripId: { $in: tripIds },
  })
    .sort({ createdAt: -1 })
    .limit(20);

  const tripNameMap = new Map(trips.map((t) => [t._id.toString(), t.name]));

  sendSuccess(res, {
    metrics: {
      activeTripsCount: trips.filter((t) => t.status !== 'CLOSED').length,
      closedTripsCount: trips.filter((t) => t.status === 'CLOSED').length,
      totalActiveTripExpensePaisa,
      totalOwedToMePaisa,
      totalIOwePaisa,
      netOverallBalancePaisa: totalOwedToMePaisa - totalIOwePaisa,
    },
    trips: tripSummaries,
    recentActivities: recentActivities.map((a) => ({
      id: a._id.toString(),
      tripId: a.tripId.toString(),
      tripName: tripNameMap.get(a.tripId.toString()) ?? 'Trip',
      actorName: a.actorName,
      actionType: a.actionType,
      entityType: a.entityType,
      summary: a.summary,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});
