import type {
  ExpenseRecord,
  FamilyEntity,
  ParticipantEntity,
  SettlementRecord,
} from '../types/index.js';
import { calculateTripBalances } from './balances.js';
import {
  calculateFamilySettlements,
  calculateIndividualSettlements,
} from './settlements.js';

export interface InvariantCheckResult {
  valid: boolean;
  violations: string[];
}

/**
 * Verifies all mandatory TripLedger financial invariants on a trip ledger:
 * 1. Total contributions equal the expense amount for each approved expense.
 * 2. Total expense shares equal the expense amount for each approved expense.
 * 3. Sum of participant balances equals zero before settlements.
 * 4. Sum of outstanding balances equals zero after settlements.
 * 5. Individual and family aggregates reconcile to the exact paisa.
 * 6. Individual and family settlement suggestions accurately clear all outstanding balances.
 */
export function verifyLedgerInvariants(
  participants: ParticipantEntity[],
  families: FamilyEntity[],
  expenses: ExpenseRecord[],
  settlements: SettlementRecord[]
): InvariantCheckResult {
  const violations: string[] = [];

  // Invariants 1 & 2: Payment & Share completeness per active approved expense
  for (const expense of expenses) {
    if (expense.isDeleted || expense.approvalStatus !== 'APPROVED') continue;

    const sumPayments = expense.payments.reduce((acc, p) => acc + p.amountPaisa, 0);
    if (sumPayments !== expense.amountPaisa) {
      violations.push(
        `Expense "${expense.title}" (${expense.id}): sum of payments (${sumPayments}) !== expense amount (${expense.amountPaisa}).`
      );
    }

    const sumShares = expense.shares.reduce((acc, s) => acc + s.sharePaisa, 0);
    if (sumShares !== expense.amountPaisa) {
      violations.push(
        `Expense "${expense.title}" (${expense.id}): sum of shares (${sumShares}) !== expense amount (${expense.amountPaisa}).`
      );
    }
  }

  const ledger = calculateTripBalances(participants, families, expenses, settlements);

  // Invariant 3: Sum of participant net expense balances equals zero before settlements
  const sumPreSettlementBalances = ledger.individualBalances.reduce(
    (acc, b) => acc + b.netExpenseBalancePaisa,
    0
  );
  if (sumPreSettlementBalances !== 0) {
    violations.push(
      `Zero-sum pre-settlement invariant failed: sum of netExpenseBalancePaisa is ${sumPreSettlementBalances} (expected 0).`
    );
  }

  // Invariant 4: Sum of outstanding balances equals zero after settlements
  const sumPostSettlementBalances = ledger.individualBalances.reduce(
    (acc, b) => acc + b.outstandingBalancePaisa,
    0
  );
  if (sumPostSettlementBalances !== 0) {
    violations.push(
      `Zero-sum post-settlement invariant failed: sum of outstandingBalancePaisa is ${sumPostSettlementBalances} (expected 0).`
    );
  }

  // Invariant 5: Individual and family aggregates reconcile
  for (const fam of ledger.familyBalances) {
    const memberSum = fam.memberBalances.reduce((acc, m) => acc + m.outstandingBalancePaisa, 0);
    if (fam.outstandingBalancePaisa !== memberSum) {
      violations.push(
        `Family "${fam.familyName}" (${fam.familyId}) balance (${fam.outstandingBalancePaisa}) does not equal sum of its members (${memberSum}).`
      );
    }
  }

  const totalFamilyPlusSolo =
    ledger.familyBalances.reduce((acc, f) => acc + f.outstandingBalancePaisa, 0) +
    ledger.ungroupedParticipantBalances.reduce((acc, u) => acc + u.outstandingBalancePaisa, 0);

  if (totalFamilyPlusSolo !== sumPostSettlementBalances) {
    violations.push(
      `Family + Ungrouped aggregate (${totalFamilyPlusSolo}) does not reconcile with total individual balances (${sumPostSettlementBalances}).`
    );
  }

  // Invariant 6: Individual settlement suggestions exactly zero out all debts & credits
  const individualSuggestions = calculateIndividualSettlements(ledger.individualBalances);
  const totalPositiveOutstanding = ledger.individualBalances
    .filter((b) => b.outstandingBalancePaisa > 0)
    .reduce((acc, b) => acc + b.outstandingBalancePaisa, 0);

  const totalSuggestedTransfer = individualSuggestions.reduce((acc, s) => acc + s.amountPaisa, 0);
  if (totalSuggestedTransfer !== totalPositiveOutstanding) {
    violations.push(
      `Settlement suggestion sum (${totalSuggestedTransfer}) does not match total positive receivables (${totalPositiveOutstanding}).`
    );
  }

  // Verify family settlement suggestions also reconcile with family positive receivables
  const familySuggestions = calculateFamilySettlements(
    ledger.familyBalances,
    ledger.ungroupedParticipantBalances
  );
  const totalFamilyPositive =
    ledger.familyBalances
      .filter((f) => f.outstandingBalancePaisa > 0)
      .reduce((acc, f) => acc + f.outstandingBalancePaisa, 0) +
    ledger.ungroupedParticipantBalances
      .filter((u) => u.outstandingBalancePaisa > 0)
      .reduce((acc, u) => acc + u.outstandingBalancePaisa, 0);

  const totalFamilySuggested = familySuggestions.reduce((acc, s) => acc + s.amountPaisa, 0);
  if (totalFamilySuggested !== totalFamilyPositive) {
    violations.push(
      `Family settlement suggestion sum (${totalFamilySuggested}) does not match family positive receivables (${totalFamilyPositive}).`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
