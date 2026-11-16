import type { Request, Response } from 'express';
import mongoose, { type ClientSession } from 'mongoose';
import {
  createSettlementSchema,
  formatPaisaToNPR,
  updateSettlementStatusSchema,
  type SettlementStatus,
} from '@tripledger/shared';
import {
  ActivityLogModel,
  FamilyModel,
  ParticipantModel,
  SettlementModel,
  TripModel,
  UserModel,
  type IParticipant,
  type ISettlement,
  type ITrip,
} from '../models/index.js';
import { runAtomically } from '../services/atomicWrite.js';
import { loadTripLedgerData, logTripActivity } from '../services/ledgerService.js';
import { runSerializedTripOrganizerMutation } from '../services/organizerInvariant.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';

async function resolveValidatedSettlementFamilyId(params: {
  tripId: mongoose.Types.ObjectId;
  settlementMode: 'INDIVIDUAL' | 'FAMILY';
  explicitFamilyId: string | null | undefined;
  participant: IParticipant;
  session?: ClientSession | null;
}): Promise<mongoose.Types.ObjectId | null> {
  const trimmed = params.explicitFamilyId?.trim();
  if (params.settlementMode === 'INDIVIDUAL') {
    if (trimmed) {
      throw new AppError(
        'Family references cannot be specified for INDIVIDUAL settlements.',
        400,
        'INVALID_SETTLEMENT_FAMILY'
      );
    }
    return null;
  }

  if (!trimmed) {
    return params.participant.familyId ?? null;
  }
  if (!mongoose.Types.ObjectId.isValid(trimmed)) {
    throw new AppError('Invalid family identifier format.', 400, 'INVALID_ID');
  }
  const family = await FamilyModel.findOne({ _id: trimmed, tripId: params.tripId }).session(
    params.session ?? null
  );
  if (!family) {
    throw new AppError(
      'Specified family group does not exist in this trip.',
      404,
      'FAMILY_NOT_FOUND'
    );
  }
  const belongsToParticipant =
    Boolean(params.participant.familyId && params.participant.familyId.equals(family._id)) ||
    Boolean(family.representativeId && family.representativeId.equals(params.participant._id));
  if (!belongsToParticipant) {
    throw new AppError(
      'Specified family group does not match the settlement participant.',
      400,
      'SETTLEMENT_FAMILY_MISMATCH'
    );
  }
  return family._id;
}

/**
 * Authorizes an active designated `FAMILY_REP` for `FAMILY`-mode settlement transitions:
 * requires active verified account linkage, matching family membership, active receiver
 * membership in `settlement.toFamilyId`, and `toFamily.representativeId === actor._id`.
 */
async function isAuthorizedReceivingFamilyRep(params: {
  trip: ITrip;
  actor: IParticipant;
  settlement: ISettlement;
  session: ClientSession | null;
}): Promise<boolean> {
  const { trip, actor, settlement, session } = params;
  if (
    trip.mode !== 'FAMILY' ||
    settlement.settlementMode !== 'FAMILY' ||
    actor.role !== 'FAMILY_REP' ||
    actor.isActive !== true ||
    !(actor.userId instanceof mongoose.Types.ObjectId) ||
    !actor.familyId ||
    !settlement.toFamilyId ||
    !actor.familyId.equals(settlement.toFamilyId)
  ) {
    return false;
  }

  const [actorUser, toFamily, receiverParticipant] = await Promise.all([
    UserModel.findById(actor.userId).select('emailVerified').session(session),
    FamilyModel.findOne({ _id: settlement.toFamilyId, tripId: trip._id }).session(session),
    ParticipantModel.findOne({ _id: settlement.toParticipantId, tripId: trip._id }).session(
      session
    ),
  ]);

  if (!actorUser || actorUser.emailVerified !== true || !toFamily || !receiverParticipant) {
    return false;
  }
  if (!toFamily.representativeId || !toFamily.representativeId.equals(actor._id)) {
    return false;
  }
  if (receiverParticipant.isActive !== true) {
    return false;
  }

  return Boolean(
    receiverParticipant.familyId && receiverParticipant.familyId.equals(toFamily._id)
  );
}

export const getBalancesAndSuggestions = asyncHandler(
  async (req: Request, res: Response) => {
    const trip = req.trip!;
    const ledgerData = await loadTripLedgerData(trip._id);

    sendSuccess(res, {
      ledger: ledgerData.ledger,
      individualSettlementSuggestions: ledgerData.individualSettlementSuggestions,
      familySettlementSuggestions: ledgerData.familySettlementSuggestions,
      settlements: ledgerData.settlements.filter((s) => !s.isDeleted),
    });
  }
);

export const listSettlements = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const ledgerData = await loadTripLedgerData(trip._id);

  sendSuccess(res, {
    settlements: ledgerData.settlements.filter((s) => !s.isDeleted),
    individualSettlementSuggestions: ledgerData.individualSettlementSuggestions,
    familySettlementSuggestions: ledgerData.familySettlementSuggestions,
  });
});

export const createSettlement = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const parsed = createSettlementSchema.parse(req.body);

  if (trip.status === 'CLOSED') {
    throw new AppError(
      'Cannot record settlements on a closed trip.',
      403,
      'TRIP_CLOSED'
    );
  }

  if (parsed.settlementMode === 'FAMILY' && trip.mode !== 'FAMILY') {
    throw new AppError(
      'Family settlements are only supported on Family Mode trips.',
      400,
      'INVALID_SETTLEMENT_MODE'
    );
  }

  if (
    !mongoose.Types.ObjectId.isValid(parsed.fromParticipantId) ||
    !mongoose.Types.ObjectId.isValid(parsed.toParticipantId)
  ) {
    throw new AppError('Invalid participant identifier format.', 400, 'INVALID_ID');
  }

  if (parsed.fromParticipantId === parsed.toParticipantId) {
    throw new AppError(
      'Sender and receiver cannot be the same participant.',
      400,
      'SELF_SETTLEMENT'
    );
  }

  if (parsed.status === 'REJECTED' || parsed.status === 'PENDING') {
    throw new AppError(
      'New settlements can only be created with REPORTED or CONFIRMED status.',
      400,
      'INVALID_SETTLEMENT_STATUS'
    );
  }

  const settlementId = new mongoose.Types.ObjectId();
  const activityLogId = new mongoose.Types.ObjectId();
  let createdSettlement = false;
  let loggedActivity = false;

  await runAtomically(
    async (session) => {
      createdSettlement = false;
      loggedActivity = false;
      const opts = session ? { session } : {};

      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (liveTrip.status === 'CLOSED') {
        throw new AppError('Cannot record settlements on a closed trip.', 403, 'TRIP_CLOSED');
      }

      const [sender, receiver] = await Promise.all([
        ParticipantModel.findOne({ _id: parsed.fromParticipantId, tripId: trip._id }).session(
          session
        ),
        ParticipantModel.findOne({ _id: parsed.toParticipantId, tripId: trip._id }).session(
          session
        ),
      ]);

      if (!sender || !receiver) {
        throw new AppError(
          'Both sender and receiver must belong to this trip.',
          404,
          'PARTICIPANT_NOT_FOUND'
        );
      }
      if (!sender.isActive || !receiver.isActive) {
        throw new AppError(
          'Inactive participants cannot be used in new settlements.',
          400,
          'PARTICIPANT_INACTIVE'
        );
      }

      // Determine initial status:
      // If recorded by Organizer or by the Receiver themselves, they can mark it CONFIRMED directly.
      // Otherwise (e.g. reported by debtor), it is recorded as REPORTED until confirmed.
      let status: SettlementStatus = parsed.status ?? 'REPORTED';
      const canConfirmDirectly =
        actor.role === 'ORGANIZER' || actor._id.equals(receiver._id);

      if (status === 'CONFIRMED' && !canConfirmDirectly) {
        status = 'REPORTED';
      }

      const [fromFamilyId, toFamilyId] = await Promise.all([
        resolveValidatedSettlementFamilyId({
          tripId: trip._id,
          settlementMode: parsed.settlementMode,
          explicitFamilyId: parsed.fromFamilyId,
          participant: sender,
          session,
        }),
        resolveValidatedSettlementFamilyId({
          tripId: trip._id,
          settlementMode: parsed.settlementMode,
          explicitFamilyId: parsed.toFamilyId,
          participant: receiver,
          session,
        }),
      ]);

      const now = new Date();
      const [settlement] = await SettlementModel.create(
        [
          {
            _id: settlementId,
            tripId: trip._id,
            settlementMode: parsed.settlementMode,
            fromParticipantId: sender._id,
            toParticipantId: receiver._id,
            fromFamilyId,
            toFamilyId,
            amountPaisa: parsed.amountPaisa,
            paymentMethod: parsed.paymentMethod,
            status,
            referenceNote: parsed.referenceNote,
            settledAt: parsed.settledAt ? new Date(parsed.settledAt) : now,
            reportedByParticipantId: actor._id,
            confirmedByParticipantId: status === 'CONFIRMED' ? actor._id : null,
            confirmedAt: status === 'CONFIRMED' ? now : null,
            isDeleted: false,
          },
        ],
        opts
      );
      createdSettlement = true;

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: actor._id,
        actorName: actor.name,
        actionType: status === 'CONFIRMED' ? 'SETTLEMENT_CONFIRMED' : 'SETTLEMENT_REPORTED',
        entityType: 'SETTLEMENT',
        entityId: settlement._id,
        summary: `${actor.name} ${status === 'CONFIRMED' ? 'recorded & confirmed' : 'reported'} settlement of ${formatPaisaToNPR(settlement.amountPaisa)} from ${sender.name} to ${receiver.name}.`,
        session,
      });
      loggedActivity = true;
    },
    async () => {
      if (loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (createdSettlement) {
        await SettlementModel.deleteOne({ _id: settlementId });
      }
    }
  );

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  const createdRecord = updatedLedgerData.settlements.find(
    (s) => s.id === settlementId.toString()
  );

  sendSuccess(
    res,
    {
      settlement: createdRecord,
      ledger: updatedLedgerData.ledger,
      individualSettlementSuggestions: updatedLedgerData.individualSettlementSuggestions,
      familySettlementSuggestions: updatedLedgerData.familySettlementSuggestions,
    },
    201
  );
});

export const updateSettlementStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const trip = req.trip!;
    const actor = req.participant!;
    const { settlementId } = req.params;
    const parsed = updateSettlementStatusSchema.parse(req.body);

    if (typeof settlementId !== 'string' || !mongoose.Types.ObjectId.isValid(settlementId)) {
      throw new AppError('Invalid settlement identifier format.', 400, 'INVALID_ID');
    }

    const activityLogId = new mongoose.Types.ObjectId();
    const txState: {
      settlementId?: mongoose.Types.ObjectId;
      previousStatus?: SettlementStatus;
      previousReferenceNote?: string;
      previousConfirmedBy?: mongoose.Types.ObjectId | null;
      previousConfirmedAt?: Date | null;
      modifiedSettlement: boolean;
      loggedActivity: boolean;
    } = {
      modifiedSettlement: false,
      loggedActivity: false,
    };

    await runSerializedTripOrganizerMutation({
      tripId: trip._id,
      work: async (session) => {
        txState.modifiedSettlement = false;
        txState.loggedActivity = false;
        txState.settlementId = undefined;

        const [liveTrip, liveActor, settlement] = await Promise.all([
          TripModel.findById(trip._id).session(session),
          ParticipantModel.findOne({ _id: actor._id, tripId: trip._id }).session(session),
          SettlementModel.findOne({
            _id: settlementId,
            tripId: trip._id,
            isDeleted: false,
          }).session(session),
        ]);

        if (!liveTrip) {
          throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
        }
        if (!liveActor || !liveActor.isActive) {
          throw new AppError('You do not have access to this trip.', 403, 'FORBIDDEN_TRIP_ACCESS');
        }
        if (!settlement) {
          throw new AppError('Settlement record not found.', 404, 'SETTLEMENT_NOT_FOUND');
        }

        // Only Organizer, active Receiver, or designated active Family Rep (FAMILY mode only) can act.
        const isOrganizer = liveActor.role === 'ORGANIZER';
        const isReceiver = settlement.toParticipantId.equals(liveActor._id);
        const isReceiverFamilyRep =
          !isOrganizer && !isReceiver
            ? await isAuthorizedReceivingFamilyRep({
                trip: liveTrip,
                actor: liveActor,
                settlement,
                session,
              })
            : false;

        if (!isOrganizer && !isReceiver && !isReceiverFamilyRep) {
          throw new AppError(
            'Only the trip organizer, the receiving participant, or the designated receiving family representative can confirm or reject this settlement.',
            403,
            'FORBIDDEN_SETTLEMENT_CONFIRMATION'
          );
        }

        if (liveTrip.status === 'CLOSED') {
          throw new AppError(
            'Settlement status cannot be changed on a closed trip.',
            403,
            'TRIP_CLOSED'
          );
        }

        if (settlement.status !== 'REPORTED') {
          throw new AppError(
            `Settlement is in ${settlement.status} state and cannot be transitioned to ${parsed.status}.`,
            409,
            'INVALID_SETTLEMENT_TRANSITION'
          );
        }

        txState.settlementId = settlement._id;
        txState.previousStatus = settlement.status;
        txState.previousReferenceNote = settlement.referenceNote;
        txState.previousConfirmedBy = settlement.confirmedByParticipantId ?? null;
        txState.previousConfirmedAt = settlement.confirmedAt ?? null;

        const now = new Date();
        const updatedSettlement = await SettlementModel.findOneAndUpdate(
          {
            _id: settlement._id,
            tripId: trip._id,
            isDeleted: false,
            status: 'REPORTED',
          },
          {
            $set: {
              status: parsed.status,
              confirmedByParticipantId: liveActor._id,
              confirmedAt: now,
              ...(parsed.referenceNote !== undefined
                ? { referenceNote: parsed.referenceNote }
                : {}),
            },
          },
          {
            new: true,
            runValidators: true,
            ...(session ? { session } : {}),
          }
        );

        if (!updatedSettlement) {
          throw new AppError(
            'Settlement is no longer in REPORTED state and cannot be transitioned.',
            409,
            'INVALID_SETTLEMENT_TRANSITION'
          );
        }
        txState.modifiedSettlement = true;

        await logTripActivity({
          _id: activityLogId,
          tripId: trip._id,
          actorUserId: req.user?.userId,
          actorParticipantId: liveActor._id,
          actorName: liveActor.name,
          actionType:
            parsed.status === 'CONFIRMED' ? 'SETTLEMENT_CONFIRMED' : 'SETTLEMENT_REJECTED',
          entityType: 'SETTLEMENT',
          entityId: updatedSettlement._id,
          summary: `${liveActor.name} ${parsed.status === 'CONFIRMED' ? 'confirmed' : 'rejected'} settlement of ${formatPaisaToNPR(updatedSettlement.amountPaisa)}.`,
          session,
        });
        txState.loggedActivity = true;
      },
      rollback: async () => {
        if (txState.loggedActivity) {
          await ActivityLogModel.deleteOne({ _id: activityLogId });
        }
        if (txState.modifiedSettlement && txState.settlementId && txState.previousStatus) {
          const restoreSet: Record<string, unknown> = {
            status: txState.previousStatus,
            confirmedByParticipantId: txState.previousConfirmedBy ?? null,
            confirmedAt: txState.previousConfirmedAt ?? null,
          };
          const restoreUnset: Record<string, 1> = {};
          if (txState.previousReferenceNote !== undefined) {
            restoreSet.referenceNote = txState.previousReferenceNote;
          } else {
            restoreUnset.referenceNote = 1;
          }
          await SettlementModel.updateOne(
            { _id: txState.settlementId },
            Object.keys(restoreUnset).length > 0
              ? { $set: restoreSet, $unset: restoreUnset }
              : { $set: restoreSet }
          );
        }
      },
    });

    const updatedLedgerData = await loadTripLedgerData(trip._id);
    sendSuccess(res, {
      settlement: updatedLedgerData.settlements.find((s) => s.id === settlementId),
      ledger: updatedLedgerData.ledger,
      individualSettlementSuggestions: updatedLedgerData.individualSettlementSuggestions,
      familySettlementSuggestions: updatedLedgerData.familySettlementSuggestions,
    });
  }
);
