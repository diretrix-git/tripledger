import type { ExpenseRecord, ExpensePaymentInput, FamilyEntity, ParticipantEntity } from '../types/index.js';
import type { ExpenseShareRecord } from '../types/index.js';
import {
  calculateExpenseShares,
  distributeByWeights,
  validateExpensePayments,
  type CustomShareInput,
} from './splitting.js';

/**
 * Re-scaling strategy for confirming an estimated expense with a different actual amount.
 *
 * PAYMENTS
 *   - If the caller supplies an explicit payer breakdown it is validated (sum must equal the new
 *     amount, every payer active, every contribution > 0) and used verbatim.
 *   - Otherwise every original contribution is scaled proportionally to its original size using the
 *     Largest-Remainder method (deterministic, exact to the paisa). A payer whose scaled share
 *     rounds to 0 paisa is dropped (they effectively contributed nothing at the new amount).
 *
 * SHARES (recomputed from the persisted configuration, never from defaults)
 *   - EQUAL / SELECTIVE : same participant set, equal split.
 *   - WEIGHTED          : same participant set, original per-expense `weightUsed` values.
 *   - CUSTOM            : explicit new custom shares if supplied, else original shares scaled
 *                         proportionally (Largest-Remainder).
 *   - PER_FAMILY        : same participant set; original included families / family weights.
 *   - PACKAGE           : same participant set; rate = explicit rate, else newAmount / headcount,
 *                         which MUST be an exact integer number of paisa (otherwise rejected).
 */
export interface RescaleExpenseParams {
  expense: Pick<
    ExpenseRecord,
    'amountPaisa' | 'splitMethod' | 'payments' | 'shares' | 'packageConfig' | 'splitConfig'
  >;
  newAmountPaisa: number;
  participants: ParticipantEntity[];
  families: FamilyEntity[];
  overridePayments?: ExpensePaymentInput[];
  overrideCustomShares?: CustomShareInput[];
  overridePackageRatePerPersonPaisa?: number;
}

export interface RescaleExpenseResult {
  payments: ExpensePaymentInput[];
  shares: ExpenseShareRecord[];
  packageConfig?: { ratePerUnitPaisa: number; unitCount: number };
}

export function rescaleExpense(params: RescaleExpenseParams): RescaleExpenseResult {
  const {
    expense,
    newAmountPaisa,
    participants,
    families,
    overridePayments,
    overrideCustomShares,
    overridePackageRatePerPersonPaisa,
  } = params;

  if (!Number.isSafeInteger(newAmountPaisa) || newAmountPaisa <= 0) {
    throw new Error('Actual amount must be a positive integer number of paisa.');
  }
  if (expense.shares.length === 0) {
    throw new Error('Expense has no recorded shares to re-scale.');
  }
  if (expense.payments.length === 0) {
    throw new Error('Expense has no recorded payments to re-scale.');
  }
  if (overrideCustomShares && expense.splitMethod !== 'CUSTOM') {
    throw new Error('Custom share overrides are only valid for CUSTOM split expenses.');
  }
  if (overridePackageRatePerPersonPaisa !== undefined && expense.splitMethod !== 'PACKAGE') {
    throw new Error('Package rate overrides are only valid for PACKAGE split expenses.');
  }

  const activeIds = new Set(participants.filter((p) => p.isActive).map((p) => p.id));

  // ---- Payments -------------------------------------------------------------------------
  let payments: ExpensePaymentInput[];
  if (overridePayments) {
    payments = overridePayments;
  } else if (expense.payments.length === 1) {
    payments = [{ ...expense.payments[0]!, amountPaisa: newAmountPaisa }];
  } else {
    const keyed = expense.payments.map((p, i) => ({
      id: String(i).padStart(8, '0'),
      weight: p.amountPaisa,
    }));
    const scaled = distributeByWeights(newAmountPaisa, keyed);
    payments = expense.payments
      .map((p, i) => ({ ...p, amountPaisa: scaled.get(keyed[i]!.id) ?? 0 }))
      .filter((p) => p.amountPaisa > 0);
  }
  // Historic payers who are no longer active are only tolerated when scaling their own
  // contribution; explicit overrides must reference active participants.
  validateExpensePayments(newAmountPaisa, payments, overridePayments ? activeIds : undefined);

  // ---- Shares ---------------------------------------------------------------------------
  const sharedParticipantIds = expense.shares.map((s) => s.participantId);
  let shares: ExpenseShareRecord[];
  let packageConfig: RescaleExpenseResult['packageConfig'];

  switch (expense.splitMethod) {
    case 'EQUAL':
    case 'SELECTIVE':
      shares = calculateExpenseShares({
        amountPaisa: newAmountPaisa,
        splitMethod: expense.splitMethod,
        participants,
        families,
        includedParticipantIds: sharedParticipantIds,
      });
      break;

    case 'WEIGHTED':
      shares = calculateExpenseShares({
        amountPaisa: newAmountPaisa,
        splitMethod: 'WEIGHTED',
        participants,
        families,
        includedParticipantIds: sharedParticipantIds,
        weights: expense.shares.map((s) => ({
          participantId: s.participantId,
          weight: s.weightUsed && s.weightUsed > 0 ? s.weightUsed : 1,
        })),
      });
      break;

    case 'CUSTOM': {
      let customShares: CustomShareInput[];
      if (overrideCustomShares) {
        customShares = overrideCustomShares;
      } else {
        const keyed = expense.shares.map((s) => ({ id: s.participantId, weight: s.sharePaisa }));
        const scaled = distributeByWeights(
          newAmountPaisa,
          keyed.filter((k) => k.weight > 0)
        );
        customShares = Array.from(scaled.entries()).map(([participantId, amountPaisa]) => ({
          participantId,
          amountPaisa,
        }));
      }
      shares = calculateExpenseShares({
        amountPaisa: newAmountPaisa,
        splitMethod: 'CUSTOM',
        participants,
        families,
        customShares,
      });
      break;
    }

    case 'PER_FAMILY': {
      const cfg = expense.splitConfig;
      let includedFamilyIds = cfg?.includedFamilyIds;
      if (!cfg) {
        // Legacy expenses without persisted config: derive from the recorded shares.
        const hasSolo = expense.shares.some((s) => !s.familyId);
        includedFamilyIds = hasSolo
          ? undefined
          : Array.from(new Set(expense.shares.map((s) => s.familyId as string)));
      }
      shares = calculateExpenseShares({
        amountPaisa: newAmountPaisa,
        splitMethod: 'PER_FAMILY',
        participants,
        families,
        includedParticipantIds: sharedParticipantIds,
        includedFamilyIds,
        familyWeights: cfg?.familyWeights,
      });
      break;
    }

    case 'PACKAGE': {
      const headcount = sharedParticipantIds.length;
      let rate = overridePackageRatePerPersonPaisa;
      if (rate === undefined) {
        if (newAmountPaisa % headcount !== 0) {
          throw new Error(
            `Package actual amount (${newAmountPaisa} paisa) is not divisible by ${headcount} participants. ` +
              'Provide packageRatePerPersonPaisa so that rate × participants equals the actual amount.'
          );
        }
        rate = newAmountPaisa / headcount;
      }
      shares = calculateExpenseShares({
        amountPaisa: newAmountPaisa,
        splitMethod: 'PACKAGE',
        participants,
        families,
        includedParticipantIds: sharedParticipantIds,
        packageRatePerPersonPaisa: rate,
      });
      packageConfig = { ratePerUnitPaisa: rate, unitCount: headcount };
      break;
    }

    default: {
      const exhaustive: never = expense.splitMethod;
      throw new Error(`Unsupported split method: ${String(exhaustive)}`);
    }
  }

  // Final reconciliation guard.
  const paid = payments.reduce((a, p) => a + p.amountPaisa, 0);
  const owed = shares.reduce((a, s) => a + s.sharePaisa, 0);
  if (paid !== newAmountPaisa || owed !== newAmountPaisa) {
    throw new Error(
      `Re-scale invariant violation: payments=${paid}, shares=${owed}, expected=${newAmountPaisa}.`
    );
  }

  return { payments, shares, packageConfig };
}
