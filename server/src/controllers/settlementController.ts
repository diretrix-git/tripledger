import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  createSettlementSchema,
  formatPaisaToNPR,
  updateSettlementStatusSchema,
  type SettlementStatus,
} from '@tripledger/shared';
import { FamilyModel, ParticipantModel, SettlementModel, type IParticipant } from '../models/index.js';
import { loadTripLedgerData, logTripActivity } from '../services/ledgerService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';

async function resolveValidatedSettlementFamilyId(params: {
  tripId: mongoose.Types.ObjectId;
  explicitFamilyId: string | null | undefined;
  participant: IParticipant;
}): Promise<mongoose.Types.ObjectId | null> {
  const trimmed = params.explicitFamilyId?.trim();
  if (!trimmed) {
    return params.participant.familyId ?? null;
  }
  if (!mongoose.Types.ObjectId.isValid(trimmed)) {
    throw new AppError('Invalid family identifier format.', 400, 'INVALID_ID');
  }
  const family = await FamilyModel.findOne({ _id: trimmed, tripId: params.tripId });
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

  if (parsed.fromParticipantId === parsed.toParticipantId) {
    throw new AppError(
      'Sender and receiver cannot be the same participant.',
      400,
      'SELF_SETTLEMENT'
    );
  }

  const [sender, receiver] = await Promise.all([
    ParticipantModel.findOne({ _id: parsed.fromParticipantId, tripId: trip._id }),
    ParticipantModel.findOne({ _id: parsed.toParticipantId, tripId: trip._id }),
  ]);

  if (!sender || !receiver) {
    throw new AppError(
      'Both sender and receiver must belong to this trip.',
      404,
      'PARTICIPANT_NOT_FOUND'
    );
  }

  // Determine initial status:
  // If recorded by Organizer or by the Receiver themselves, they can optionally mark it CONFIRMED directly.
  // If reported by the Sender (debtor), it defaults to REPORTED until confirmed by Organizer or Receiver.
  let status: SettlementStatus = parsed.status ?? 'REPORTED';
  const canConfirmDirectly =
    actor.role === 'ORGANIZER' || actor._id.equals(receiver._id);

  if (status === 'CONFIRMED' && !canConfirmDirectly) {
    status = 'REPORTED';
  }

  const [fromFamilyId, toFamilyId] = await Promise.all([
    resolveValidatedSettlementFamilyId({
      tripId: trip._id,
      explicitFamilyId: parsed.fromFamilyId,
      participant: sender,
    }),
    resolveValidatedSettlementFamilyId({
      tripId: trip._id,
      explicitFamilyId: parsed.toFamilyId,
      participant: receiver,
    }),
  ]);

  const settlement = await SettlementModel.create({
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
    settledAt: parsed.settledAt ? new Date(parsed.settledAt) : new Date(),
    reportedByParticipantId: actor._id,
    confirmedByParticipantId: status === 'CONFIRMED' ? actor._id : null,
    confirmedAt: status === 'CONFIRMED' ? new Date() : null,
    isDeleted: false,
  });

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: status === 'CONFIRMED' ? 'SETTLEMENT_CONFIRMED' : 'SETTLEMENT_REPORTED',
    entityType: 'SETTLEMENT',
    entityId: settlement._id,
    summary: `${actor.name} ${status === 'CONFIRMED' ? 'recorded & confirmed' : 'reported'} settlement of ${formatPaisaToNPR(settlement.amountPaisa)} from ${sender.name} to ${receiver.name}.`,
  });

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  const createdRecord = updatedLedgerData.settlements.find(
    (s) => s.id === settlement._id.toString()
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

    const settlement = await SettlementModel.findOne({
      _id: settlementId,
      tripId: trip._id,
      isDeleted: false,
    });

    if (!settlement) {
      throw new AppError('Settlement record not found.', 404, 'SETTLEMENT_NOT_FOUND');
    }

    // Only Organizer, Receiver, or verified Receiver's Family Rep can confirm/reject a settlement
    const isOrganizer = actor.role === 'ORGANIZER';
    const isReceiver = settlement.toParticipantId.equals(actor._id);
    let isReceiverFamilyRep = false;
    if (
      !isOrganizer &&
      !isReceiver &&
      actor.role === 'FAMILY_REP' &&
      actor.familyId &&
      settlement.toFamilyId &&
      actor.familyId.equals(settlement.toFamilyId)
    ) {
      const [toFamily, receiverParticipant] = await Promise.all([
        FamilyModel.findOne({ _id: settlement.toFamilyId, tripId: trip._id }),
        ParticipantModel.findOne({ _id: settlement.toParticipantId, tripId: trip._id }),
      ]);
      if (toFamily && receiverParticipant) {
        isReceiverFamilyRep =
          Boolean(receiverParticipant.familyId?.equals(toFamily._id)) ||
          Boolean(toFamily.representativeId?.equals(receiverParticipant._id));
      }
    }

    if (!isOrganizer && !isReceiver && !isReceiverFamilyRep) {
      throw new AppError(
        'Only the trip organizer or the receiving party can confirm or reject this settlement.',
        403,
        'FORBIDDEN_SETTLEMENT_CONFIRMATION'
      );
    }

    settlement.status = parsed.status;
    if (parsed.referenceNote !== undefined) {
      settlement.referenceNote = parsed.referenceNote;
    }
    settlement.confirmedByParticipantId = actor._id;
    settlement.confirmedAt = new Date();
    await settlement.save();

    await logTripActivity({
      tripId: trip._id,
      actorUserId: req.user?.userId,
      actorParticipantId: actor._id,
      actorName: actor.name,
      actionType:
        parsed.status === 'CONFIRMED' ? 'SETTLEMENT_CONFIRMED' : 'SETTLEMENT_REJECTED',
      entityType: 'SETTLEMENT',
      entityId: settlement._id,
      summary: `${actor.name} ${parsed.status === 'CONFIRMED' ? 'confirmed' : 'rejected'} settlement of ${formatPaisaToNPR(settlement.amountPaisa)}.`,
    });

    const updatedLedgerData = await loadTripLedgerData(trip._id);
    sendSuccess(res, {
      settlement: updatedLedgerData.settlements.find(
        (s) => s.id === settlement._id.toString()
      ),
      ledger: updatedLedgerData.ledger,
      individualSettlementSuggestions: updatedLedgerData.individualSettlementSuggestions,
      familySettlementSuggestions: updatedLedgerData.familySettlementSuggestions,
    });
  }
);
