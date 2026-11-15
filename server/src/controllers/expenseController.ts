import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  approveExpenseSchema,
  calculateExpenseShares,
  createExpenseSchema,
  formatPaisaToNPR,
  updateExpenseSchema,
  validateExpensePayments,
  type ExpenseApprovalStatus,
} from '@tripledger/shared';
import {
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
} from '../models/index.js';
import { loadTripLedgerData, logTripActivity } from '../services/ledgerService.js';
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

  const expense = await ExpenseModel.create({
    tripId: trip._id,
    title: parsed.title,
    description: parsed.description,
    category: parsed.category,
    amountPaisa: parsed.amountPaisa,
    isEstimated: parsed.isEstimated,
    isPackage,
    packageConfig:
      isPackage && parsed.packageRatePerPersonPaisa
        ? {
            ratePerUnitPaisa: parsed.packageRatePerPersonPaisa,
            unitCount: computedShares.length,
          }
        : undefined,
    splitMethod: parsed.splitMethod,
    paymentMethod: parsed.paymentMethod,
    approvalStatus,
    incurredAt: parsed.incurredAt ? new Date(parsed.incurredAt) : new Date(),
    createdByParticipantId: actor._id,
    approvedByParticipantId: approvalStatus === 'APPROVED' ? actor._id : null,
    clientMutationId: parsed.clientMutationId || undefined,
    isDeleted: false,
  });

  await ExpensePaymentModel.insertMany(
    parsed.payments.map((pay) => ({
      tripId: trip._id,
      expenseId: expense._id,
      participantId: new mongoose.Types.ObjectId(pay.participantId),
      amountPaisa: pay.amountPaisa,
      paymentMethod: pay.paymentMethod ?? parsed.paymentMethod,
      paidAt: expense.incurredAt,
      notes: pay.notes,
    }))
  );

  await ExpenseShareModel.insertMany(
    computedShares.map((sh) => ({
      tripId: trip._id,
      expenseId: expense._id,
      participantId: new mongoose.Types.ObjectId(sh.participantId),
      familyId: sh.familyId ? new mongoose.Types.ObjectId(sh.familyId) : null,
      sharePaisa: sh.sharePaisa,
      weightUsed: sh.weightUsed ?? 1,
    }))
  );

  // Auto-check the corresponding Forgotten Expense Checklist category if not already checked
  const checklistItem = trip.checklist.find((c) => c.category === parsed.category);
  if (checklistItem && !checklistItem.checked && !parsed.isEstimated) {
    checklistItem.checked = true;
    checklistItem.verifiedAt = new Date();
    await trip.save();
  }

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'EXPENSE_ADDED',
    entityType: 'EXPENSE',
    entityId: expense._id,
    summary: `${actor.name} recorded ${isPackage ? 'package ' : ''}expense "${expense.title}" (${formatPaisaToNPR(expense.amountPaisa)}).`,
    metadata: {
      amountPaisa: expense.amountPaisa,
      splitMethod: expense.splitMethod,
      approvalStatus: expense.approvalStatus,
    },
  });

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  const createdRecord = updatedLedgerData.expenses.find(
    (e) => e.id === expense._id.toString()
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
  const existingRecord = currentData.expenses.find((e) => e.id === expense._id.toString())!;

  const newAmountPaisa = parsed.amountPaisa ?? expense.amountPaisa;
  const newSplitMethod = parsed.splitMethod ?? expense.splitMethod;
  const newPayments = parsed.payments ?? existingRecord.payments;

  const validParticipantIds = new Set(
    currentData.participants.filter((p) => p.isActive).map((p) => p.id)
  );
  validateExpensePayments(newAmountPaisa, newPayments, validParticipantIds);

  const computedShares = calculateExpenseShares({
    amountPaisa: newAmountPaisa,
    splitMethod: newSplitMethod,
    participants: currentData.participants,
    families: currentData.families,
    includedParticipantIds:
      parsed.includedParticipantIds ??
      existingRecord.shares.map((s) => s.participantId),
    includedFamilyIds: parsed.includedFamilyIds,
    customShares: parsed.customShares,
    weights: parsed.weights,
    familyWeights: parsed.familyWeights,
    packageRatePerPersonPaisa:
      parsed.packageRatePerPersonPaisa ??
      expense.packageConfig?.ratePerUnitPaisa,
  });

  if (parsed.title !== undefined) expense.title = parsed.title;
  if (parsed.description !== undefined) expense.description = parsed.description;
  if (parsed.category !== undefined) expense.category = parsed.category;
  expense.amountPaisa = newAmountPaisa;
  expense.splitMethod = newSplitMethod;
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

  await expense.save();

  // Atomically replace payments and shares for this expense
  await ExpensePaymentModel.deleteMany({ expenseId: expense._id });
  await ExpenseShareModel.deleteMany({ expenseId: expense._id });

  await ExpensePaymentModel.insertMany(
    newPayments.map((pay) => ({
      tripId: trip._id,
      expenseId: expense._id,
      participantId: new mongoose.Types.ObjectId(pay.participantId),
      amountPaisa: pay.amountPaisa,
      paymentMethod: pay.paymentMethod ?? expense.paymentMethod,
      paidAt: expense.incurredAt,
      notes: pay.notes,
    }))
  );

  await ExpenseShareModel.insertMany(
    computedShares.map((sh) => ({
      tripId: trip._id,
      expenseId: expense._id,
      participantId: new mongoose.Types.ObjectId(sh.participantId),
      familyId: sh.familyId ? new mongoose.Types.ObjectId(sh.familyId) : null,
      sharePaisa: sh.sharePaisa,
      weightUsed: sh.weightUsed ?? 1,
    }))
  );

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'EXPENSE_EDITED',
    entityType: 'EXPENSE',
    entityId: expense._id,
    summary: `${actor.name} updated expense "${expense.title}" to ${formatPaisaToNPR(expense.amountPaisa)}.`,
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

export const approveOrConfirmExpense = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { expenseId } = req.params;

  const parsed = approveExpenseSchema.parse(req.body);

  const expense = await ExpenseModel.findOne({
    _id: expenseId,
    tripId: trip._id,
    isDeleted: false,
  });

  if (!expense) {
    throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
  }

  expense.approvalStatus = parsed.approvalStatus;
  expense.isEstimated = false;
  expense.approvedByParticipantId = actor._id;

  // If organizer supplied an updated actualAmountPaisa when confirming an estimated expense
  if (parsed.actualAmountPaisa && parsed.actualAmountPaisa !== expense.amountPaisa) {
    const currentData = await loadTripLedgerData(trip._id);
    const existingRecord = currentData.expenses.find(
      (e) => e.id === expense._id.toString()
    )!;

    // Scale single payer or primary payer to match actual amount
    const existingPayments = existingRecord.payments;
    if (existingPayments.length === 1) {
      await ExpensePaymentModel.updateOne(
        { expenseId: expense._id },
        { $set: { amountPaisa: parsed.actualAmountPaisa } }
      );
    }

    const recomputedShares = calculateExpenseShares({
      amountPaisa: parsed.actualAmountPaisa,
      splitMethod: expense.splitMethod,
      participants: currentData.participants,
      families: currentData.families,
      includedParticipantIds: existingRecord.shares.map((s) => s.participantId),
    });

    await ExpenseShareModel.deleteMany({ expenseId: expense._id });
    await ExpenseShareModel.insertMany(
      recomputedShares.map((sh) => ({
        tripId: trip._id,
        expenseId: expense._id,
        participantId: new mongoose.Types.ObjectId(sh.participantId),
        familyId: sh.familyId ? new mongoose.Types.ObjectId(sh.familyId) : null,
        sharePaisa: sh.sharePaisa,
        weightUsed: sh.weightUsed ?? 1,
      }))
    );

    expense.amountPaisa = parsed.actualAmountPaisa;
  }

  await expense.save();

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: parsed.approvalStatus === 'APPROVED' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
    entityType: 'EXPENSE',
    entityId: expense._id,
    summary: `${actor.name} ${parsed.approvalStatus === 'APPROVED' ? 'approved' : 'rejected'} expense "${expense.title}" (${formatPaisaToNPR(expense.amountPaisa)}).`,
  });

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

  const expense = await ExpenseModel.findOne({
    _id: expenseId,
    tripId: trip._id,
    isDeleted: false,
  });

  if (!expense) {
    throw new AppError('Expense not found.', 404, 'EXPENSE_NOT_FOUND');
  }

  expense.isDeleted = true;
  expense.deletedAt = new Date();
  await expense.save();

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'EXPENSE_DELETED',
    entityType: 'EXPENSE',
    entityId: expense._id,
    summary: `${actor.name} reversed/removed expense "${expense.title}" (${formatPaisaToNPR(expense.amountPaisa)}).`,
  });

  const updatedLedgerData = await loadTripLedgerData(trip._id);
  sendSuccess(res, {
    deletedId: expenseId,
    ledger: updatedLedgerData.ledger,
  });
});
