import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  approveExpenseSchema,
  calculateExpenseShares,
  createExpenseSchema,
  formatPaisaToNPR,
  planExpenseEdit,
  rescaleExpense,
  updateExpenseSchema,
  validateExpensePayments,
  type ExpenseApprovalStatus,
  type ExpenseEditPlan,
  type RescaleExpenseResult,
} from '@tripledger/shared';
import {
  ActivityLogModel,
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
} from '../models/index.js';
import { runAtomically } from '../services/atomicWrite.js';
import {
  buildExpensePaymentDocs,
  buildExpenseShareDocs,
  createInitialExpenseLedger,
  loadTripLedgerData,
  logTripActivity,
  rollbackReplacedExpensePayments,
  rollbackReplacedExpenseShares,
} from '../services/ledgerService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';

export const listExpenses = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const ledgerData = await loadTripLedgerData(trip._id);

  const activeExpenses = ledgerData.expenses.filter((e) => !e.isDeleted);

  sendSuccess(res, {
    expenses: activeExpenses,
    ledger: ledgerData.ledger,
  });
});

export const createExpense = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;

  if (trip.status === 'CLOSED') {
    throw new AppError('Cannot add new expenses to a closed trip.', 400, 'TRIP_CLOSED');
  }

  const parsed = createExpenseSchema.parse(req.body);

  // Server-side idempotency check for offline PWA expense queue
  if (parsed.clientMutationId) {
    const existing = await ExpenseModel.findOne({
      tripId: trip._id,
      clientMutationId: parsed.clientMutationId,
    });
    if (existing) {
      const ledgerData = await loadTripLedgerData(trip._id);
      const existingRecord = ledgerData.expenses.find(
        (e) => e.id === existing._id.toString()
      );
      sendSuccess(res, {
        expense: existingRecord,
        deduplicated: true,
        ledger: ledgerData.ledger,
      });
      return;
    }
  }

  const currentData = await loadTripLedgerData(trip._id);
  // Validate every referenced participant and family ID belongs to this trip BEFORE any computation or DB write.
  assertReferencedIdsBelongToTrip(parsed, currentData.participants, currentData.families);

  const validParticipantIds = new Set(
    currentData.participants.filter((p) => p.isActive).map((p) => p.id)
  );

  validateExpensePayments(parsed.amountPaisa, parsed.payments, validParticipantIds);

  const computedShares = calculateExpenseShares({
    amountPaisa: parsed.amountPaisa,
    splitMethod: parsed.splitMethod,
    participants: currentData.participants,
    families: currentData.families,
    includedParticipantIds: parsed.includedParticipantIds,
    includedFamilyIds: parsed.includedFamilyIds,
    customShares: parsed.customShares,
    weights: parsed.weights,
    familyWeights: parsed.familyWeights,
    packageRatePerPersonPaisa: parsed.packageRatePerPersonPaisa,
  });

  // Determine approvalStatus:
  // - If isEstimated === true -> 'PENDING_CONFIRMATION'
  // - Else if created by ORGANIZER -> 'APPROVED'
  // - Else (created by CONTRIBUTOR or FAMILY_REP in Family Mode) -> 'PENDING_APPROVAL' (or APPROVED in Friends Mode)
  let approvalStatus: ExpenseApprovalStatus = 'APPROVED';
  if (parsed.isEstimated) {
    approvalStatus = 'PENDING_CONFIRMATION';
  } else if (actor.role !== 'ORGANIZER' && trip.mode === 'FAMILY') {
    approvalStatus = 'PENDING_APPROVAL';
  }

  const isPackage =
    parsed.isPackage || parsed.splitMethod === 'PACKAGE' || parsed.category === 'PACKAGE';
  const incurredAt = parsed.incurredAt ? new Date(parsed.incurredAt) : new Date();
  const packageConfig =
    isPackage && parsed.packageRatePerPersonPaisa
      ? {
          ratePerUnitPaisa: parsed.packageRatePerPersonPaisa,
          unitCount: computedShares.length,
        }
      : undefined;
  const splitConfig =
    parsed.splitMethod === 'PER_FAMILY'
      ? {
          includedFamilyIds: parsed.includedFamilyIds,
          familyWeights: parsed.familyWeights,
        }
      : undefined;

  const { expenseId: createdExpenseId } = await createInitialExpenseLedger({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    title: parsed.title,
    description: parsed.description,
    category: parsed.category,
    amountPaisa: parsed.amountPaisa,
    isEstimated: parsed.isEstimated,
    isPackage,
    packageConfig,
    splitConfig,
    splitMethod: parsed.splitMethod,
    paymentMethod: parsed.paymentMethod,
    approvalStatus,
    incurredAt,
    clientMutationId: parsed.clientMutationId || undefined,
    payments: parsed.payments,
    shares: computedShares,
    activitySummary: `${actor.name} recorded ${isPackage ? 'package ' : ''}expense "${parsed.title}" (${formatPaisaToNPR(parsed.amountPaisa)}).`,
  });

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  const createdRecord = updatedLedgerData.expenses.find(
    (e) => e.id === createdExpenseId.toString()
  );

  sendSuccess(
    res,
    {
      expense: createdRecord,
      deduplicated: false,
      ledger: updatedLedgerData.ledger,
      individualSettlementSuggestions: updatedLedgerData.individualSettlementSuggestions,
      familySettlementSuggestions: updatedLedgerData.familySettlementSuggestions,
    },
    201
  );
});

export const updateExpense = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { expenseId } = req.params;

  if (!mongoose.isValidObjectId(expenseId)) {
    throw new AppError('Invalid expense id.', 400, 'INVALID_ID');
  }

  const expense = await ExpenseModel.findOne({
    _id: expenseId,
    tripId: trip._id,
    isDeleted: false,
  });

  if (!expense) {
    throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
  }

  // Only ORGANIZER can edit finalized/approved expenses; Contributors can only edit their own unapproved submissions
  if (actor.role !== 'ORGANIZER') {
    const isOwnSubmission = expense.createdByParticipantId.equals(actor._id);
    const isEditableStatus =
      expense.approvalStatus === 'PENDING_APPROVAL' ||
      expense.approvalStatus === 'PENDING_CONFIRMATION';
    if (!isOwnSubmission || !isEditableStatus) {
      throw new AppError(
        'Only the trip organizer can edit finalized expenses.',
        403,
        'FORBIDDEN_EXPENSE_EDIT'
      );
    }
  }

  const parsed = updateExpenseSchema.parse(req.body);
  const currentData = await loadTripLedgerData(trip._id);
  const existingRecord = currentData.expenses.find((e) => e.id === expense._id.toString());

  if (!existingRecord || existingRecord.isDeleted) {
    throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
  }

  // ---- Phase 1: validate every referenced id and plan the full target state. No writes yet. ----
  assertReferencedIdsBelongToTrip(parsed, currentData.participants, currentData.families);

  let plan: ExpenseEditPlan;
  try {
    plan = planExpenseEdit({
      expense: existingRecord,
      patch: {
        amountPaisa: parsed.amountPaisa,
        splitMethod: parsed.splitMethod,
        payments: parsed.payments,
        includedParticipantIds: parsed.includedParticipantIds,
        includedFamilyIds: parsed.includedFamilyIds,
        customShares: parsed.customShares,
        weights: parsed.weights,
        familyWeights: parsed.familyWeights,
        packageRatePerPersonPaisa: parsed.packageRatePerPersonPaisa,
      },
      participants: currentData.participants,
      families: currentData.families,
    });
  } catch (err) {
    throw new AppError(
      err instanceof Error ? err.message : 'Invalid expense update.',
      400,
      'INVALID_EXPENSE_UPDATE'
    );
  }

  const financialChange = plan.payments !== null || plan.shares !== null;

  // Snapshot the persisted expense document before mutating in-memory fields
  const expenseSnapshot = expense.toObject();
  const expectedVersion = typeof expenseSnapshot.__v === 'number' ? expenseSnapshot.__v : 0;

  // Metadata (never affects the ledger)
  if (parsed.title !== undefined) expense.title = parsed.title;
  if (parsed.description !== undefined) expense.description = parsed.description;
  if (parsed.category !== undefined) expense.category = parsed.category;
  if (parsed.paymentMethod !== undefined) expense.paymentMethod = parsed.paymentMethod;
  if (parsed.isEstimated !== undefined) {
    expense.isEstimated = parsed.isEstimated;
    if (!parsed.isEstimated && expense.approvalStatus === 'PENDING_CONFIRMATION') {
      expense.approvalStatus = actor.role === 'ORGANIZER' ? 'APPROVED' : 'PENDING_APPROVAL';
    }
  }
  if (parsed.approvalStatus !== undefined && actor.role === 'ORGANIZER') {
    expense.approvalStatus = parsed.approvalStatus;
  }

  // Financial fields (only touched when the plan says so)
  const wasPackageSplit = existingRecord.splitMethod === 'PACKAGE';
  expense.amountPaisa = plan.amountPaisa;
  expense.splitMethod = plan.splitMethod;
  if (parsed.isPackage !== undefined) {
    expense.isPackage = parsed.isPackage;
  } else if (plan.splitMethod === 'PACKAGE') {
    expense.isPackage = true;
  } else if (wasPackageSplit) {
    expense.isPackage = false;
  }

  if (plan.packageConfig === null) {
    expense.set('packageConfig', undefined);
  } else if (plan.packageConfig) {
    expense.packageConfig = plan.packageConfig;
  }

  if (plan.splitConfig === null) {
    expense.set('splitConfig', undefined);
  } else if (plan.splitConfig) {
    expense.splitConfig = plan.splitConfig;
  }

  // ---- Phase 2: persist ----
  if (!financialChange) {
    // Metadata-only edit touches only the Expense document (natively atomic in MongoDB).
    await expense.save();
  } else {
    const oldPaymentDocs = plan.payments
      ? await ExpensePaymentModel.find({ expenseId: expense._id }).lean()
      : [];
    const oldShareDocs = plan.shares
      ? await ExpenseShareModel.find({ expenseId: expense._id }).lean()
      : [];

    const newPaymentDocs = plan.payments
      ? buildExpensePaymentDocs({
          tripId: trip._id,
          expenseId: expense._id,
          payments: plan.payments,
          defaultPaymentMethod: expense.paymentMethod,
          paidAt: expense.incurredAt,
        })
      : [];
    const newShareDocs = plan.shares
      ? buildExpenseShareDocs({
          tripId: trip._id,
          expenseId: expense._id,
          shares: plan.shares,
        })
      : [];

    const unsetFields: Record<string, 1> = {};
    if (plan.packageConfig === null) unsetFields.packageConfig = 1;
    if (plan.splitConfig === null) unsetFields.splitConfig = 1;

    const setFields: Record<string, unknown> = {
      title: expense.title,
      description: expense.description,
      category: expense.category,
      paymentMethod: expense.paymentMethod,
      isEstimated: expense.isEstimated,
      approvalStatus: expense.approvalStatus,
      amountPaisa: expense.amountPaisa,
      splitMethod: expense.splitMethod,
      isPackage: expense.isPackage,
    };
    if (plan.packageConfig) setFields.packageConfig = plan.packageConfig;
    else if (plan.packageConfig === undefined && expense.packageConfig?.ratePerUnitPaisa) {
      setFields.packageConfig = expense.packageConfig;
    }
    if (plan.splitConfig) setFields.splitConfig = plan.splitConfig;
    else if (plan.splitConfig === undefined && expense.splitConfig) {
      setFields.splitConfig = expense.splitConfig;
    }

    let expenseModifiedByThisAttempt = false;
    let oldPaymentsDeleteStarted = false;
    let oldSharesDeleteStarted = false;

    await runAtomically(
      async (session) => {
        const opts = session ? { session } : {};
        expenseModifiedByThisAttempt = false;
        oldPaymentsDeleteStarted = false;
        oldSharesDeleteStarted = false;

        // 1. Insert new payment and share documents first (old rows are still intact).
        if (plan.payments) {
          await ExpensePaymentModel.insertMany(newPaymentDocs, opts);
        }
        if (plan.shares) {
          await ExpenseShareModel.insertMany(newShareDocs, opts);
        }

        // 2. Atomically update Expense with optimistic concurrency (__v) check before deleting old rows.
        const updatedExpense = await ExpenseModel.findOneAndUpdate(
          { _id: expense._id, tripId: trip._id, isDeleted: false, __v: expectedVersion },
          {
            $set: setFields,
            ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
            $inc: { __v: 1 },
          },
          { new: true, runValidators: true, ...opts }
        );

        if (!updatedExpense) {
          throw new AppError(
            'Expense was modified concurrently by another request. Please refresh and try again.',
            409,
            'CONCURRENT_MODIFICATION'
          );
        }
        expenseModifiedByThisAttempt = true;

        // 3. Remove previous payment and share documents by explicit _id.
        if (plan.payments && oldPaymentDocs.length > 0) {
          oldPaymentsDeleteStarted = true;
          await ExpensePaymentModel.deleteMany(
            { _id: { $in: oldPaymentDocs.map((d) => d._id) } },
            opts
          );
        }
        if (plan.shares && oldShareDocs.length > 0) {
          oldSharesDeleteStarted = true;
          await ExpenseShareModel.deleteMany(
            { _id: { $in: oldShareDocs.map((d) => d._id) } },
            opts
          );
        }
      },
      async () => {
        // Best-effort compensation (standalone non-production fallback only):
        // Remove newly inserted rows; only re-upsert old rows if we actually won __v and started deleting them;
        // only restore Expense if this attempt modified it and __v has not moved ahead concurrently.
        if (plan.payments) {
          await rollbackReplacedExpensePayments(
            newPaymentDocs.map((d) => d._id),
            oldPaymentDocs,
            expenseModifiedByThisAttempt && oldPaymentsDeleteStarted
          );
        }
        if (plan.shares) {
          await rollbackReplacedExpenseShares(
            newShareDocs.map((d) => d._id),
            oldShareDocs,
            expenseModifiedByThisAttempt && oldSharesDeleteStarted
          );
        }
        if (expenseModifiedByThisAttempt) {
          await ExpenseModel.replaceOne(
            { _id: expense._id, __v: expectedVersion + 1 },
            expenseSnapshot
          );
        }
      }
    );
  }

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'EXPENSE_EDITED',
    entityType: 'EXPENSE',
    entityId: expense._id,
    summary: `${actor.name} updated expense "${expense.title}" (${formatPaisaToNPR(expense.amountPaisa)}).`,
    metadata: {
      financialRecalculation: financialChange,
      paymentsReplaced: plan.payments !== null,
      sharesReplaced: plan.shares !== null,
    },
  });

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  const updatedRecord = updatedLedgerData.expenses.find(
    (e) => e.id === expense._id.toString()
  );

  sendSuccess(res, {
    expense: updatedRecord,
    ledger: updatedLedgerData.ledger,
    individualSettlementSuggestions: updatedLedgerData.individualSettlementSuggestions,
    familySettlementSuggestions: updatedLedgerData.familySettlementSuggestions,
  });
});

/**
 * Rejects malformed or foreign ids BEFORE any database mutation: every participant id must be a
 * valid ObjectId of an ACTIVE participant of this trip and every family id a valid ObjectId of a
 * family of this trip.
 */
function assertReferencedIdsBelongToTrip(
  parsed: {
    payments?: Array<{ participantId: string }>;
    includedParticipantIds?: string[];
    customShares?: Array<{ participantId: string }>;
    weights?: Array<{ participantId: string }>;
    includedFamilyIds?: string[];
    familyWeights?: Array<{ familyId: string }>;
  },
  participants: Array<{ id: string; isActive: boolean }>,
  families: Array<{ id: string }>
): void {
  const activeParticipantIds = new Set(participants.filter((p) => p.isActive).map((p) => p.id));
  const familyIds = new Set(families.map((f) => f.id));

  const participantRefs: Array<[string, string]> = [
    ...(parsed.payments ?? []).map((x): [string, string] => ['payments', x.participantId]),
    ...(parsed.includedParticipantIds ?? []).map((id): [string, string] => [
      'includedParticipantIds',
      id,
    ]),
    ...(parsed.customShares ?? []).map((x): [string, string] => ['customShares', x.participantId]),
    ...(parsed.weights ?? []).map((x): [string, string] => ['weights', x.participantId]),
  ];
  for (const [field, id] of participantRefs) {
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(`${field}: "${id}" is not a valid id.`, 400, 'INVALID_ID');
    }
    if (!activeParticipantIds.has(id)) {
      throw new AppError(
        `${field}: participant "${id}" is not an active participant of this trip.`,
        400,
        'INVALID_REFERENCE'
      );
    }
  }

  const familyRefs: Array<[string, string]> = [
    ...(parsed.includedFamilyIds ?? []).map((id): [string, string] => ['includedFamilyIds', id]),
    ...(parsed.familyWeights ?? []).map((x): [string, string] => ['familyWeights', x.familyId]),
  ];
  for (const [field, id] of familyRefs) {
    if (!mongoose.isValidObjectId(id)) {
      throw new AppError(`${field}: "${id}" is not a valid id.`, 400, 'INVALID_ID');
    }
    if (!familyIds.has(id)) {
      throw new AppError(
        `${field}: family "${id}" does not belong to this trip.`,
        400,
        'INVALID_REFERENCE'
      );
    }
  }
}

export const approveOrConfirmExpense = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { expenseId } = req.params;

  if (!mongoose.isValidObjectId(expenseId)) {
    throw new AppError('Invalid expense id.', 400, 'INVALID_ID');
  }

  const parsed = approveExpenseSchema.parse(req.body);

  const expense = await ExpenseModel.findOne({
    _id: expenseId,
    tripId: trip._id,
    isDeleted: false,
  });

  if (!expense) {
    throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
  }

  const hasAdjustmentOverrides =
    parsed.payments !== undefined ||
    parsed.customShares !== undefined ||
    parsed.packageRatePerPersonPaisa !== undefined;

  // An actual amount only takes effect on approval. A rejected expense never touches the ledger.
  const amountChanged =
    parsed.approvalStatus === 'APPROVED' &&
    parsed.actualAmountPaisa !== undefined &&
    parsed.actualAmountPaisa !== expense.amountPaisa;

  if (hasAdjustmentOverrides && !amountChanged) {
    throw new AppError(
      'payments, customShares and packageRatePerPersonPaisa may only be supplied together with an actualAmountPaisa that differs from the recorded amount.',
      400,
      'INVALID_EXPENSE_ADJUSTMENT'
    );
  }

  // Phase 1 — validate referenced IDs and compute the full adjustment BEFORE any database mutation.
  let adjustment: RescaleExpenseResult | null = null;
  const previousAmountPaisa = expense.amountPaisa;
  if (amountChanged) {
    const currentData = await loadTripLedgerData(trip._id);
    const existingRecord = currentData.expenses.find((e) => e.id === expense._id.toString());
    if (!existingRecord || existingRecord.isDeleted) {
      throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
    }

    assertReferencedIdsBelongToTrip(
      { payments: parsed.payments, customShares: parsed.customShares },
      currentData.participants,
      currentData.families
    );

    try {
      adjustment = rescaleExpense({
        expense: existingRecord,
        newAmountPaisa: parsed.actualAmountPaisa!,
        participants: currentData.participants,
        families: currentData.families,
        overridePayments: parsed.payments,
        overrideCustomShares: parsed.customShares,
        overridePackageRatePerPersonPaisa: parsed.packageRatePerPersonPaisa,
      });
    } catch (err) {
      throw new AppError(
        err instanceof Error ? err.message : 'Unable to adjust expense to the actual amount.',
        400,
        'INVALID_EXPENSE_ADJUSTMENT'
      );
    }
  }

  // Phase 2 — persist atomically across Expense, ExpensePayment, ExpenseShare, and ActivityLog.
  const expenseSnapshot = expense.toObject();
  const expectedVersion = typeof expenseSnapshot.__v === 'number' ? expenseSnapshot.__v : 0;
  const activityLogId = new mongoose.Types.ObjectId();
  const targetAmountPaisa = adjustment ? parsed.actualAmountPaisa! : expense.amountPaisa;

  const oldPaymentDocs = adjustment
    ? await ExpensePaymentModel.find({ expenseId: expense._id }).lean()
    : [];
  const oldShareDocs = adjustment
    ? await ExpenseShareModel.find({ expenseId: expense._id }).lean()
    : [];

  const newPaymentDocs = adjustment
    ? buildExpensePaymentDocs({
        tripId: trip._id,
        expenseId: expense._id,
        payments: adjustment.payments,
        defaultPaymentMethod: expense.paymentMethod,
        paidAt: expense.incurredAt,
      })
    : [];
  const newShareDocs = adjustment
    ? buildExpenseShareDocs({
        tripId: trip._id,
        expenseId: expense._id,
        shares: adjustment.shares,
      })
    : [];

  const setFields: Record<string, unknown> = {
    approvalStatus: parsed.approvalStatus,
    isEstimated: false,
    approvedByParticipantId: actor._id,
  };
  if (adjustment) {
    setFields.amountPaisa = targetAmountPaisa;
    if (adjustment.packageConfig) {
      setFields.packageConfig = adjustment.packageConfig;
    }
  }

  let expenseModifiedByThisAttempt = false;
  let oldPaymentsDeleteStarted = false;
  let oldSharesDeleteStarted = false;
  let activityLoggedByThisAttempt = false;

  await runAtomically(
    async (session) => {
      const opts = session ? { session } : {};
      expenseModifiedByThisAttempt = false;
      oldPaymentsDeleteStarted = false;
      oldSharesDeleteStarted = false;
      activityLoggedByThisAttempt = false;

      if (adjustment) {
        await ExpensePaymentModel.insertMany(newPaymentDocs, opts);
        await ExpenseShareModel.insertMany(newShareDocs, opts);
      }

      const updatedExpense = await ExpenseModel.findOneAndUpdate(
        { _id: expense._id, tripId: trip._id, isDeleted: false, __v: expectedVersion },
        { $set: setFields, $inc: { __v: 1 } },
        { new: true, runValidators: true, ...opts }
      );
      if (!updatedExpense) {
        throw new AppError(
          'Expense was modified concurrently by another request. Please refresh and try again.',
          409,
          'CONCURRENT_MODIFICATION'
        );
      }
      expenseModifiedByThisAttempt = true;

      if (adjustment) {
        if (oldPaymentDocs.length > 0) {
          oldPaymentsDeleteStarted = true;
          await ExpensePaymentModel.deleteMany(
            { _id: { $in: oldPaymentDocs.map((d) => d._id) } },
            opts
          );
        }
        if (oldShareDocs.length > 0) {
          oldSharesDeleteStarted = true;
          await ExpenseShareModel.deleteMany(
            { _id: { $in: oldShareDocs.map((d) => d._id) } },
            opts
          );
        }
      }

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: actor._id,
        actorName: actor.name,
        actionType: parsed.approvalStatus === 'APPROVED' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
        entityType: 'EXPENSE',
        entityId: expense._id,
        summary: `${actor.name} ${parsed.approvalStatus === 'APPROVED' ? 'approved' : 'rejected'} expense "${expense.title}" (${formatPaisaToNPR(targetAmountPaisa)}).`,
        metadata: adjustment
          ? { previousAmountPaisa, actualAmountPaisa: targetAmountPaisa }
          : undefined,
        session,
      });
      activityLoggedByThisAttempt = true;
    },
    async () => {
      if (activityLoggedByThisAttempt) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (adjustment) {
        await rollbackReplacedExpensePayments(
          newPaymentDocs.map((d) => d._id),
          oldPaymentDocs,
          expenseModifiedByThisAttempt && oldPaymentsDeleteStarted
        );
        await rollbackReplacedExpenseShares(
          newShareDocs.map((d) => d._id),
          oldShareDocs,
          expenseModifiedByThisAttempt && oldSharesDeleteStarted
        );
      }
      if (expenseModifiedByThisAttempt) {
        await ExpenseModel.replaceOne(
          { _id: expense._id, __v: expectedVersion + 1 },
          expenseSnapshot
        );
      }
    }
  );

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  sendSuccess(res, {
    expense: updatedLedgerData.expenses.find((e) => e.id === expense._id.toString()),
    ledger: updatedLedgerData.ledger,
  });
});

export const softDeleteExpense = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { expenseId } = req.params;

  if (!mongoose.isValidObjectId(expenseId)) {
    throw new AppError('Invalid expense id.', 400, 'INVALID_ID');
  }

  const expense = await ExpenseModel.findOne({
    _id: expenseId,
    tripId: trip._id,
    isDeleted: false,
  });

  if (!expense) {
    throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
  }

  const expectedVersion = typeof expense.__v === 'number' ? expense.__v : 0;
  const deletedAt = new Date();
  const activityLogId = new mongoose.Types.ObjectId();

  let expenseModifiedByThisAttempt = false;
  let activityLoggedByThisAttempt = false;

  await runAtomically(
    async (session) => {
      const opts = session ? { session } : {};
      expenseModifiedByThisAttempt = false;
      activityLoggedByThisAttempt = false;

      const updatedExpense = await ExpenseModel.findOneAndUpdate(
        { _id: expense._id, tripId: trip._id, isDeleted: false, __v: expectedVersion },
        { $set: { isDeleted: true, deletedAt }, $inc: { __v: 1 } },
        { new: true, runValidators: true, ...opts }
      );
      if (!updatedExpense) {
        throw new AppError(
          'Expense was modified or deleted concurrently by another request. Please refresh and try again.',
          409,
          'CONCURRENT_MODIFICATION'
        );
      }
      expenseModifiedByThisAttempt = true;

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: actor._id,
        actorName: actor.name,
        actionType: 'EXPENSE_DELETED',
        entityType: 'EXPENSE',
        entityId: expense._id,
        summary: `${actor.name} reversed/removed expense "${expense.title}" (${formatPaisaToNPR(expense.amountPaisa)}).`,
        session,
      });
      activityLoggedByThisAttempt = true;
    },
    async () => {
      if (activityLoggedByThisAttempt) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (expenseModifiedByThisAttempt) {
        await ExpenseModel.updateOne(
          { _id: expense._id, isDeleted: true, deletedAt, __v: expectedVersion + 1 },
          { $set: { isDeleted: false, deletedAt: null }, $inc: { __v: -1 } }
        );
      }
    }
  );

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  sendSuccess(res, {
    deletedId: expenseId,
    ledger: updatedLedgerData.ledger,
  });
});
