import type {
  ExpenseRecord,
  FamilyBalanceSummary,
  FamilyEntity,
  IndividualBalanceSummary,
  ParticipantEntity,
  SettlementRecord,
} from '../types/index.js';

export interface CalculateBalancesOptions {
  /**
   * When false (default), only APPROVED expenses and CONFIRMED settlements are included.
   * When true, PENDING_APPROVAL and PENDING_CONFIRMATION expenses are also projected.
   */
  includePendingExpenses?: boolean;
}

export interface TripLedgerComputation {
  totalApprovedExpensePaisa: number;
  totalPackageExpensePaisa: number;
  totalAdditionalExpensePaisa: number;
  totalPendingExpensePaisa: number;
  totalConfirmedSettlementPaisa: number;
  individualBalances: IndividualBalanceSummary[];
  familyBalances: FamilyBalanceSummary[];
  ungroupedParticipantBalances: IndividualBalanceSummary[];
}

/**
 * Computes individual participant balances and family-level aggregate balances from
 * normalized expense and settlement records.
 *
 * Guarantees:
 * - Family balances are strictly the algebraic sum of their members' individual balances.
 * - Settlements never mutate expense totals or shares.
 * - Sum of all individual outstanding balances === 0.
 */
export function calculateTripBalances(
  participants: ParticipantEntity[],
  families: FamilyEntity[],
  expenses: ExpenseRecord[],
  settlements: SettlementRecord[],
  options: CalculateBalancesOptions = {}
): TripLedgerComputation {
  const { includePendingExpenses = false } = options;

  const familyMap = new Map(families.map((f) => [f.id, f]));
  const participantMap = new Map(participants.map((p) => [p.id, p]));

  const paidByParticipant = new Map<string, number>();
  const shareByParticipant = new Map<string, number>();
  const sentSettlementByParticipant = new Map<string, number>();
  const receivedSettlementByParticipant = new Map<string, number>();

  for (const p of participants) {
    paidByParticipant.set(p.id, 0);
    shareByParticipant.set(p.id, 0);
    sentSettlementByParticipant.set(p.id, 0);
    receivedSettlementByParticipant.set(p.id, 0);
  }

  let totalApprovedExpensePaisa = 0;
  let totalPackageExpensePaisa = 0;
  let totalAdditionalExpensePaisa = 0;
  let totalPendingExpensePaisa = 0;

  for (const expense of expenses) {
    if (expense.isDeleted) continue;

    if (
      expense.approvalStatus === 'PENDING_APPROVAL' ||
      expense.approvalStatus === 'PENDING_CONFIRMATION'
    ) {
      totalPendingExpensePaisa += expense.amountPaisa;
      if (!includePendingExpenses) {
        continue;
      }
    } else if (expense.approvalStatus !== 'APPROVED') {
      // REJECTED expenses never affect balances
      continue;
    }

    if (expense.approvalStatus === 'APPROVED') {
      totalApprovedExpensePaisa += expense.amountPaisa;
      if (expense.isPackage || expense.category === 'PACKAGE' || expense.splitMethod === 'PACKAGE') {
        totalPackageExpensePaisa += expense.amountPaisa;
      } else {
        totalAdditionalExpensePaisa += expense.amountPaisa;
      }
    }

    for (const payment of expense.payments) {
      const currentPaid = paidByParticipant.get(payment.participantId) ?? 0;
      paidByParticipant.set(payment.participantId, currentPaid + payment.amountPaisa);
    }

    for (const share of expense.shares) {
      const currentShare = shareByParticipant.get(share.participantId) ?? 0;
      shareByParticipant.set(share.participantId, currentShare + share.sharePaisa);
    }
  }

  let totalConfirmedSettlementPaisa = 0;

  for (const settlement of settlements) {
    if (settlement.isDeleted) continue;
    // Only CONFIRMED settlements reduce confirmed outstanding balances
    if (settlement.status !== 'CONFIRMED') continue;

    totalConfirmedSettlementPaisa += settlement.amountPaisa;

    const currentSent = sentSettlementByParticipant.get(settlement.fromParticipantId) ?? 0;
    sentSettlementByParticipant.set(
      settlement.fromParticipantId,
      currentSent + settlement.amountPaisa
    );

    const currentReceived = receivedSettlementByParticipant.get(settlement.toParticipantId) ?? 0;
    receivedSettlementByParticipant.set(
      settlement.toParticipantId,
      currentReceived + settlement.amountPaisa
    );
  }

  const individualBalances: IndividualBalanceSummary[] = participants.map((p) => {
    const totalPaidPaisa = paidByParticipant.get(p.id) ?? 0;
    const totalSharePaisa = shareByParticipant.get(p.id) ?? 0;
    const netExpenseBalancePaisa = totalPaidPaisa - totalSharePaisa;
    const settlementsSentPaisa = sentSettlementByParticipant.get(p.id) ?? 0;
    const settlementsReceivedPaisa = receivedSettlementByParticipant.get(p.id) ?? 0;

    // Debtor sending money increases their negative balance toward 0 (+sent).
    // Creditor receiving money decreases their positive receivable toward 0 (-received).
    const outstandingBalancePaisa =
      netExpenseBalancePaisa + settlementsSentPaisa - settlementsReceivedPaisa;

    const family = p.familyId ? familyMap.get(p.familyId) : undefined;
    const status =
      outstandingBalancePaisa > 0
        ? 'CREDITOR'
        : outstandingBalancePaisa < 0
          ? 'DEBTOR'
          : 'SETTLED';

    return {
      participantId: p.id,
      participantName: p.name,
      familyId: family ? family.id : null,
      familyName: family ? family.name : null,
      role: p.role,
      memberType: p.memberType,
      totalPaidPaisa,
      totalSharePaisa,
      netExpenseBalancePaisa,
      settlementsSentPaisa,
      settlementsReceivedPaisa,
      outstandingBalancePaisa,
      status,
    };
  });

  // Aggregate family balances strictly from individual member balances (Never recalculate independently!)
  const familyBalances: FamilyBalanceSummary[] = families.map((family) => {
    const memberBalances = individualBalances.filter((b) => b.familyId === family.id);
    const totalPaidPaisa = memberBalances.reduce((sum, m) => sum + m.totalPaidPaisa, 0);
    const totalSharePaisa = memberBalances.reduce((sum, m) => sum + m.totalSharePaisa, 0);
    const netExpenseBalancePaisa = memberBalances.reduce(
      (sum, m) => sum + m.netExpenseBalancePaisa,
      0
    );
    const settlementsSentPaisa = memberBalances.reduce(
      (sum, m) => sum + m.settlementsSentPaisa,
      0
    );
    const settlementsReceivedPaisa = memberBalances.reduce(
      (sum, m) => sum + m.settlementsReceivedPaisa,
      0
    );
    const outstandingBalancePaisa = memberBalances.reduce(
      (sum, m) => sum + m.outstandingBalancePaisa,
      0
    );

    const repParticipant =
      (family.representativeId ? participantMap.get(family.representativeId) : undefined) ??
      participants.find((p) => p.familyId === family.id && p.memberType === 'ADULT') ??
      participants.find((p) => p.familyId === family.id);

    const status =
      outstandingBalancePaisa > 0
        ? 'CREDITOR'
        : outstandingBalancePaisa < 0
          ? 'DEBTOR'
          : 'SETTLED';

    return {
      familyId: family.id,
      familyName: family.name,
      representativeId: repParticipant?.id ?? null,
      representativeName: repParticipant?.name ?? null,
      memberIds: memberBalances.map((m) => m.participantId),
      memberCount: memberBalances.length,
      totalPaidPaisa,
      totalSharePaisa,
      netExpenseBalancePaisa,
      settlementsSentPaisa,
      settlementsReceivedPaisa,
      outstandingBalancePaisa,
      status,
      memberBalances,
    };
  });

  const ungroupedParticipantBalances = individualBalances.filter((b) => b.familyId === null);

  return {
    totalApprovedExpensePaisa,
    totalPackageExpensePaisa,
    totalAdditionalExpensePaisa,
    totalPendingExpensePaisa,
    totalConfirmedSettlementPaisa,
    individualBalances,
    familyBalances,
    ungroupedParticipantBalances,
  };
}
