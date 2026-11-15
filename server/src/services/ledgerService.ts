import mongoose, { type ClientSession } from 'mongoose';
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
  type ExpenseApprovalStatus,
  type ExpenseCategory,
  type ExpensePaymentInput,
  type ExpenseRecord,
  type ExpenseShareRecord,
  type FamilyEntity,
  type ParticipantEntity,
  type PaymentMethod,
  type SettlementRecord,
  type SplitMethod,
} from '@tripledger/shared';
import { runAtomically } from './atomicWrite.js';

export async function logTripActivity(params: {
  _id?: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId | string;
  actorUserId?: mongoose.Types.ObjectId | string | null;
  actorParticipantId?: mongoose.Types.ObjectId | string | null;
  actorName: string;
  actionType: string;
  entityType: 'TRIP' | 'PARTICIPANT' | 'FAMILY' | 'EXPENSE' | 'SETTLEMENT';
  entityId: mongoose.Types.ObjectId | string;
  summary: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession | null;
}): Promise<void> {
  const doc = {
    ...(params._id ? { _id: params._id } : {}),
    tripId: params.tripId,
    actorUserId: params.actorUserId ?? null,
    actorParticipantId: params.actorParticipantId ?? null,
    actorName: params.actorName,
    actionType: params.actionType,
    entityType: params.entityType,
    entityId: params.entityId,
    summary: params.summary,
    metadata: params.metadata ?? {},
  };
  await ActivityLogModel.create([doc], params.session ? { session: params.session } : {});
}

export interface CreateInitialExpenseLedgerParams {
  tripId: mongoose.Types.ObjectId;
  actorUserId?: mongoose.Types.ObjectId | string | null;
  actorParticipantId: mongoose.Types.ObjectId;
  actorName: string;
  title: string;
  description?: string;
  category: ExpenseCategory;
  amountPaisa: number;
  isEstimated: boolean;
  isPackage: boolean;
  packageConfig?: { ratePerUnitPaisa: number; unitCount: number };
  splitConfig?: {
    includedFamilyIds?: string[];
    familyWeights?: Array<{ familyId: string; weight?: number }>;
  };
  splitMethod: SplitMethod;
  paymentMethod: PaymentMethod;
  approvalStatus: ExpenseApprovalStatus;
  incurredAt: Date;
  clientMutationId?: string;
  payments: ExpensePaymentInput[];
  shares: ExpenseShareRecord[];
  activitySummary: string;
}

export function buildExpensePaymentDocs(params: {
  tripId: mongoose.Types.ObjectId;
  expenseId: mongoose.Types.ObjectId;
  payments: ExpensePaymentInput[];
  defaultPaymentMethod: PaymentMethod;
  paidAt: Date;
}) {
  return params.payments.map((pay) => ({
    _id: new mongoose.Types.ObjectId(),
    tripId: params.tripId,
    expenseId: params.expenseId,
    participantId: new mongoose.Types.ObjectId(pay.participantId),
    amountPaisa: pay.amountPaisa,
    paymentMethod: pay.paymentMethod ?? params.defaultPaymentMethod,
    paidAt: params.paidAt,
    notes: pay.notes,
  }));
}

export function buildExpenseShareDocs(params: {
  tripId: mongoose.Types.ObjectId;
  expenseId: mongoose.Types.ObjectId;
  shares: ExpenseShareRecord[];
}) {
  return params.shares.map((sh) => ({
    _id: new mongoose.Types.ObjectId(),
    tripId: params.tripId,
    expenseId: params.expenseId,
    participantId: new mongoose.Types.ObjectId(sh.participantId),
    familyId: sh.familyId ? new mongoose.Types.ObjectId(sh.familyId) : null,
    sharePaisa: sh.sharePaisa,
    weightUsed: sh.weightUsed ?? 1,
  }));
}

export interface PreviousPaymentSnapshot {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  expenseId: mongoose.Types.ObjectId;
  participantId: mongoose.Types.ObjectId;
  amountPaisa: number;
  paymentMethod: PaymentMethod;
  paidAt: Date;
  notes?: string;
}

export interface PreviousShareSnapshot {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  expenseId: mongoose.Types.ObjectId;
  participantId: mongoose.Types.ObjectId;
  familyId?: mongoose.Types.ObjectId | null;
  sharePaisa: number;
  weightUsed?: number;
}

/**
 * Standalone compensation helper for replaced payments. Always removes rows inserted by this
 * attempt, and only re-upserts previous rows if this attempt actually reached the delete phase
 * after winning optimistic concurrency on the parent Expense.
 */
export async function rollbackReplacedExpensePayments(
  insertedIds: mongoose.Types.ObjectId[],
  previousDocs: PreviousPaymentSnapshot[],
  shouldRestorePrevious: boolean
): Promise<void> {
  if (insertedIds.length > 0) {
    await ExpensePaymentModel.deleteMany({ _id: { $in: insertedIds } });
  }
  if (shouldRestorePrevious && previousDocs.length > 0) {
    await ExpensePaymentModel.bulkWrite(
      previousDocs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: {
              tripId: d.tripId,
              expenseId: d.expenseId,
              participantId: d.participantId,
              amountPaisa: d.amountPaisa,
              paymentMethod: d.paymentMethod,
              paidAt: d.paidAt,
              notes: d.notes,
            },
          },
          upsert: true,
        },
      }))
    );
  }
}

/**
 * Standalone compensation helper for replaced shares. Always removes rows inserted by this
 * attempt, and only re-upserts previous rows if this attempt actually reached the delete phase
 * after winning optimistic concurrency on the parent Expense.
 */
export async function rollbackReplacedExpenseShares(
  insertedIds: mongoose.Types.ObjectId[],
  previousDocs: PreviousShareSnapshot[],
  shouldRestorePrevious: boolean
): Promise<void> {
  if (insertedIds.length > 0) {
    await ExpenseShareModel.deleteMany({ _id: { $in: insertedIds } });
  }
  if (shouldRestorePrevious && previousDocs.length > 0) {
    await ExpenseShareModel.bulkWrite(
      previousDocs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: {
            $set: {
              tripId: d.tripId,
              expenseId: d.expenseId,
              participantId: d.participantId,
              familyId: d.familyId ?? null,
              sharePaisa: d.sharePaisa,
              weightUsed: d.weightUsed ?? 1,
            },
          },
          upsert: true,
        },
      }))
    );
  }
}

/**
 * Atomically persists a newly created expense together with its payment rows, share rows,
 * optional Forgotten Expense Checklist auto-check, and activity log entry.
 */
export async function createInitialExpenseLedger(
  params: CreateInitialExpenseLedgerParams
): Promise<{ expenseId: mongoose.Types.ObjectId }> {
  const expenseId = new mongoose.Types.ObjectId();
  const activityLogId = new mongoose.Types.ObjectId();
  const checklistVerifiedAt = new Date();

  const paymentDocs = buildExpensePaymentDocs({
    tripId: params.tripId,
    expenseId,
    payments: params.payments,
    defaultPaymentMethod: params.paymentMethod,
    paidAt: params.incurredAt,
  });

  const shareDocs = buildExpenseShareDocs({
    tripId: params.tripId,
    expenseId,
    shares: params.shares,
  });

  const paymentIds = paymentDocs.map((d) => d._id);
  const shareIds = shareDocs.map((d) => d._id);

  let expenseCreatedByThisAttempt = false;
  let checklistModifiedByThisAttempt = false;
  let activityLoggedByThisAttempt = false;

  await runAtomically(
    async (session) => {
      const opts = session ? { session } : {};
      expenseCreatedByThisAttempt = false;
      checklistModifiedByThisAttempt = false;
      activityLoggedByThisAttempt = false;

      await ExpenseModel.create(
        [
          {
            _id: expenseId,
            tripId: params.tripId,
            title: params.title,
            description: params.description,
            category: params.category,
            amountPaisa: params.amountPaisa,
            isEstimated: params.isEstimated,
            isPackage: params.isPackage,
            packageConfig: params.packageConfig,
            splitConfig: params.splitConfig,
            splitMethod: params.splitMethod,
            paymentMethod: params.paymentMethod,
            approvalStatus: params.approvalStatus,
            incurredAt: params.incurredAt,
            createdByParticipantId: params.actorParticipantId,
            approvedByParticipantId:
              params.approvalStatus === 'APPROVED' ? params.actorParticipantId : null,
            clientMutationId: params.clientMutationId || undefined,
            isDeleted: false,
          },
        ],
        opts
      );
      expenseCreatedByThisAttempt = true;

      await ExpensePaymentModel.insertMany(paymentDocs, opts);
      await ExpenseShareModel.insertMany(shareDocs, opts);

      if (!params.isEstimated) {
        const updatedTrip = await TripModel.findOneAndUpdate(
          {
            _id: params.tripId,
            checklist: { $elemMatch: { category: params.category, checked: false } },
          },
          {
            $set: {
              'checklist.$.checked': true,
              'checklist.$.verifiedAt': checklistVerifiedAt,
            },
          },
          { new: true, ...opts }
        );
        checklistModifiedByThisAttempt = Boolean(updatedTrip);
      }

      await logTripActivity({
        _id: activityLogId,
        tripId: params.tripId,
        actorUserId: params.actorUserId ?? null,
        actorParticipantId: params.actorParticipantId,
        actorName: params.actorName,
        actionType: 'EXPENSE_ADDED',
        entityType: 'EXPENSE',
        entityId: expenseId,
        summary: params.activitySummary,
        metadata: {
          amountPaisa: params.amountPaisa,
          splitMethod: params.splitMethod,
          approvalStatus: params.approvalStatus,
        },
        session,
      });
      activityLoggedByThisAttempt = true;
    },
    async () => {
      // Best-effort compensation (standalone non-production fallback only).
      // Every predicate targets only this attempt's unique _ids / verifiedAt timestamp
      // so concurrent requests are never affected.
      await ExpenseShareModel.deleteMany({ _id: { $in: shareIds } });
      await ExpensePaymentModel.deleteMany({ _id: { $in: paymentIds } });
      if (expenseCreatedByThisAttempt) {
        await ExpenseModel.deleteOne({ _id: expenseId });
      }
      if (checklistModifiedByThisAttempt) {
        await TripModel.updateOne(
          {
            _id: params.tripId,
            checklist: {
              $elemMatch: {
                category: params.category,
                checked: true,
                verifiedAt: checklistVerifiedAt,
              },
            },
          },
          {
            $set: {
              'checklist.$.checked': false,
              'checklist.$.verifiedAt': null,
            },
          }
        );
      }
      if (activityLoggedByThisAttempt) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
    }
  );

  return { expenseId };
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
