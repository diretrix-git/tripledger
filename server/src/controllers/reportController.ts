import type { Request, Response } from 'express';
import { EXPENSE_CATEGORY_LABELS } from '@tripledger/shared';
import { ActivityLogModel, TripModel } from '../models/index.js';
import { loadTripLedgerData } from '../services/ledgerService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';
import { formatTripDoc } from './tripController.js';

export const getTripReportSummary = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const ledgerData = await loadTripLedgerData(trip._id);

  const activeApprovedExpenses = ledgerData.expenses.filter(
    (e) => !e.isDeleted && e.approvalStatus === 'APPROVED'
  );

  // Category Breakdown
  const categoryTotals = new Map<string, { count: number; amountPaisa: number }>();
  for (const exp of activeApprovedExpenses) {
    const entry = categoryTotals.get(exp.category) ?? { count: 0, amountPaisa: 0 };
    entry.count += 1;
    entry.amountPaisa += exp.amountPaisa;
    categoryTotals.set(exp.category, entry);
  }

  const categoryBreakdown = Array.from(categoryTotals.entries())
    .map(([category, stats]) => ({
      category,
      label:
        EXPENSE_CATEGORY_LABELS[category as keyof typeof EXPENSE_CATEGORY_LABELS] ??
        category,
      expenseCount: stats.count,
      amountPaisa: stats.amountPaisa,
      percentage:
        ledgerData.ledger.totalApprovedExpensePaisa > 0
          ? Math.round(
              (stats.amountPaisa * 10000) / ledgerData.ledger.totalApprovedExpensePaisa
            ) / 100
          : 0,
    }))
    .sort((a, b) => b.amountPaisa - a.amountPaisa);

  const activities = await ActivityLogModel.find({ tripId: trip._id })
    .sort({ createdAt: -1 })
    .limit(50);

  sendSuccess(res, {
    trip: formatTripDoc(trip),
    ledger: ledgerData.ledger,
    categoryBreakdown,
    individualSettlementSuggestions: ledgerData.individualSettlementSuggestions,
    familySettlementSuggestions: ledgerData.familySettlementSuggestions,
    expenses: ledgerData.expenses.filter((e) => !e.isDeleted),
    settlements: ledgerData.settlements.filter((s) => !s.isDeleted),
    activityLogs: activities.map((a) => ({
      id: a._id.toString(),
      actorName: a.actorName,
      actionType: a.actionType,
      entityType: a.entityType,
      summary: a.summary,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

export const getTripActivityLogs = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const activities = await ActivityLogModel.find({ tripId: trip._id })
    .sort({ createdAt: -1 })
    .limit(100);

  sendSuccess(res, {
    activities: activities.map((a) => ({
      id: a._id.toString(),
      actorName: a.actorName,
      actionType: a.actionType,
      entityType: a.entityType,
      summary: a.summary,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

/**
 * Public read-only shared trip report endpoint (`GET /api/v1/shared/:shareToken`).
 * Strictly sanitizes private user fields (`email`, `phone`, `userId`, `inviteCode`).
 */
export const getPublicSharedReport = asyncHandler(async (req: Request, res: Response) => {
  const rawToken = req.params.shareToken;
  const shareToken = typeof rawToken === 'string' ? rawToken.trim() : '';

  if (!shareToken) {
    throw new AppError('Share token is required.', 400, 'BAD_REQUEST');
  }

  const trip = await TripModel.findOne({ shareToken, shareEnabled: true });
  if (!trip) {
    throw new AppError(
      'Shared trip report not found or sharing has been disabled by the organizer.',
      404,
      'SHARED_REPORT_NOT_FOUND'
    );
  }

  const ledgerData = await loadTripLedgerData(trip._id);
  const activeApprovedExpenses = ledgerData.expenses.filter(
    (e) => !e.isDeleted && e.approvalStatus === 'APPROVED'
  );

  // Sanitize participants to strip email, phone, and internal userId
  const sanitizedParticipants = ledgerData.participants
    .filter((p) => p.isActive)
    .map((p) => ({
      id: p.id,
      name: p.name,
      familyId: p.familyId ?? null,
      role: p.role,
      memberType: p.memberType,
    }));

  const categoryTotals = new Map<string, { count: number; amountPaisa: number }>();
  for (const exp of activeApprovedExpenses) {
    const entry = categoryTotals.get(exp.category) ?? { count: 0, amountPaisa: 0 };
    entry.count += 1;
    entry.amountPaisa += exp.amountPaisa;
    categoryTotals.set(exp.category, entry);
  }

  const categoryBreakdown = Array.from(categoryTotals.entries())
    .map(([category, stats]) => ({
      category,
      label:
        EXPENSE_CATEGORY_LABELS[category as keyof typeof EXPENSE_CATEGORY_LABELS] ??
        category,
      expenseCount: stats.count,
      amountPaisa: stats.amountPaisa,
    }))
    .sort((a, b) => b.amountPaisa - a.amountPaisa);

  sendSuccess(res, {
    trip: {
      id: trip._id.toString(),
      name: trip.name,
      description: trip.description,
      mode: trip.mode,
      status: trip.status,
      currency: trip.currency,
      budgetPaisa: trip.budgetPaisa,
      startDate: trip.startDate ? trip.startDate.toISOString() : undefined,
      endDate: trip.endDate ? trip.endDate.toISOString() : undefined,
    },
    participants: sanitizedParticipants,
    families: ledgerData.families.map((f) => ({
      id: f.id,
      name: f.name,
      representativeId: f.representativeId,
    })),
    expenses: activeApprovedExpenses.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      amountPaisa: e.amountPaisa,
      isPackage: e.isPackage,
      splitMethod: e.splitMethod,
      paymentMethod: e.paymentMethod,
      incurredAt: e.incurredAt,
      payments: e.payments,
      shares: e.shares,
    })),
    settlements: ledgerData.settlements
      .filter((s) => !s.isDeleted && s.status === 'CONFIRMED')
      .map((s) => ({
        id: s.id,
        settlementMode: s.settlementMode,
        fromParticipantId: s.fromParticipantId,
        toParticipantId: s.toParticipantId,
        amountPaisa: s.amountPaisa,
        paymentMethod: s.paymentMethod,
        status: s.status,
        settledAt: s.settledAt,
      })),
    ledger: ledgerData.ledger,
    categoryBreakdown,
    individualSettlementSuggestions: ledgerData.individualSettlementSuggestions,
    familySettlementSuggestions: ledgerData.familySettlementSuggestions,
  });
});
