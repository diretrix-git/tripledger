import mongoose from 'mongoose';
import {
  ActivityLogModel,
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
  FamilyModel,
  ParticipantModel,
  SettlementModel,
  TripModel,
} from '../models/index.js';
import {
  calculateFamilySettlements,
  calculateIndividualSettlements,
  calculateTripBalances,
  type ExpenseRecord,
  type FamilyEntity,
  type ParticipantEntity,
  type SettlementRecord,
} from '@tripledger/shared';

export async function logTripActivity(params: {
  tripId: mongoose.Types.ObjectId | string;
  actorUserId?: mongoose.Types.ObjectId | string | null;
  actorParticipantId?: mongoose.Types.ObjectId | string | null;
  actorName: string;
  actionType: string;
  entityType: 'TRIP' | 'PARTICIPANT' | 'FAMILY' | 'EXPENSE' | 'SETTLEMENT';
  entityId: mongoose.Types.ObjectId | string;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ActivityLogModel.create({
    tripId: params.tripId,
    actorUserId: params.actorUserId ?? null,
    actorParticipantId: params.actorParticipantId ?? null,
    actorName: params.actorName,
    actionType: params.actionType,
    entityType: params.entityType,
    entityId: params.entityId,
    summary: params.summary,
    metadata: params.metadata ?? {},
  });
}

/**
 * Loads normalized trip entities (`Participants`, `Families`, `Expenses`, `ExpensePayments`,
 * `ExpenseShares`, `Settlements`) from MongoDB and maps them into the pure `@tripledger/shared`
 * financial engine domain types.
 */
export async function loadTripLedgerData(tripId: string | mongoose.Types.ObjectId) {
  const [
    tripDoc,
    participantDocs,
    familyDocs,
    expenseDocs,
    paymentDocs,
    shareDocs,
    settlementDocs,
  ] = await Promise.all([
    TripModel.findById(tripId),
    ParticipantModel.find({ tripId }).sort({ createdAt: 1 }),
    FamilyModel.find({ tripId }).sort({ createdAt: 1 }),
    ExpenseModel.find({ tripId }).sort({ incurredAt: -1, createdAt: -1 }),
    ExpensePaymentModel.find({ tripId }),
    ExpenseShareModel.find({ tripId }),
    SettlementModel.find({ tripId }).sort({ settledAt: -1, createdAt: -1 }),
  ]);

  const participants: ParticipantEntity[] = participantDocs.map((p) => ({
    id: p._id.toString(),
    tripId: p.tripId.toString(),
    userId: p.userId ? p.userId.toString() : null,
    familyId: p.familyId ? p.familyId.toString() : null,
    name: p.name,
    email: p.email,
    phone: p.phone,
    role: p.role,
    memberType: p.memberType,
    defaultWeight: p.defaultWeight,
    isActive: p.isActive,
  }));

  const families: FamilyEntity[] = familyDocs.map((f) => ({
    id: f._id.toString(),
    tripId: f.tripId.toString(),
    name: f.name,
    representativeId: f.representativeId ? f.representativeId.toString() : null,
    defaultWeight: f.defaultWeight,
    notes: f.notes,
  }));

  const paymentsByExpense = new Map<string, typeof paymentDocs>();
  for (const pay of paymentDocs) {
    const key = pay.expenseId.toString();
    const list = paymentsByExpense.get(key) ?? [];
    list.push(pay);
    paymentsByExpense.set(key, list);
  }

  const sharesByExpense = new Map<string, typeof shareDocs>();
  for (const sh of shareDocs) {
    const key = sh.expenseId.toString();
    const list = sharesByExpense.get(key) ?? [];
    list.push(sh);
    sharesByExpense.set(key, list);
  }

  const expenses: ExpenseRecord[] = expenseDocs.map((e) => {
    const expId = e._id.toString();
    const expPayments = paymentsByExpense.get(expId) ?? [];
    const expShares = sharesByExpense.get(expId) ?? [];

    return {
      id: expId,
      tripId: e.tripId.toString(),
      title: e.title,
      description: e.description,
      category: e.category,
      amountPaisa: e.amountPaisa,
      isEstimated: e.isEstimated,
      isPackage: e.isPackage,
      packageConfig: e.packageConfig?.ratePerUnitPaisa
        ? {
            ratePerUnitPaisa: e.packageConfig.ratePerUnitPaisa,
            unitCount: e.packageConfig.unitCount,
          }
        : undefined,
      splitConfig: e.splitConfig
        ? {
            includedFamilyIds: e.splitConfig.includedFamilyIds
              ? [...e.splitConfig.includedFamilyIds]
              : undefined,
            familyWeights: e.splitConfig.familyWeights
              ? e.splitConfig.familyWeights.map((fw) => ({
                  familyId: fw.familyId,
                  weight: fw.weight,
                }))
              : undefined,
          }
        : undefined,
      splitMethod: e.splitMethod,
      paymentMethod: e.paymentMethod,
      approvalStatus: e.approvalStatus,
      incurredAt: e.incurredAt.toISOString(),
      createdByParticipantId: e.createdByParticipantId.toString(),
      approvedByParticipantId: e.approvedByParticipantId
        ? e.approvedByParticipantId.toString()
        : null,
      clientMutationId: e.clientMutationId,
      isDeleted: e.isDeleted,
      payments: expPayments.map((pay) => ({
        participantId: pay.participantId.toString(),
        amountPaisa: pay.amountPaisa,
        paymentMethod: pay.paymentMethod,
        notes: pay.notes,
      })),
      shares: expShares.map((sh) => ({
        participantId: sh.participantId.toString(),
        familyId: sh.familyId ? sh.familyId.toString() : null,
        sharePaisa: sh.sharePaisa,
        weightUsed: sh.weightUsed,
      })),
    };
  });

  const settlements: SettlementRecord[] = settlementDocs.map((s) => ({
    id: s._id.toString(),
    tripId: s.tripId.toString(),
    settlementMode: s.settlementMode,
    fromParticipantId: s.fromParticipantId.toString(),
    toParticipantId: s.toParticipantId.toString(),
    fromFamilyId: s.fromFamilyId ? s.fromFamilyId.toString() : null,
    toFamilyId: s.toFamilyId ? s.toFamilyId.toString() : null,
    amountPaisa: s.amountPaisa,
    paymentMethod: s.paymentMethod,
    status: s.status,
    referenceNote: s.referenceNote,
    settledAt: s.settledAt.toISOString(),
    reportedByParticipantId: s.reportedByParticipantId.toString(),
    confirmedByParticipantId: s.confirmedByParticipantId
      ? s.confirmedByParticipantId.toString()
      : null,
    isDeleted: s.isDeleted,
  }));

  const ledger = calculateTripBalances(participants, families, expenses, settlements);
  const individualSettlementSuggestions = calculateIndividualSettlements(
    ledger.individualBalances
  );
  const familySettlementSuggestions = calculateFamilySettlements(
    ledger.familyBalances,
    ledger.ungroupedParticipantBalances
  );

  return {
    tripDoc,
    participants,
    families,
    expenses,
    settlements,
    ledger,
    individualSettlementSuggestions,
    familySettlementSuggestions,
  };
}
