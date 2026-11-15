import type { ExpenseRecord, ExpensePaymentInput, FamilyEntity, ParticipantEntity } from '../types/index.js';
import type { ExpenseShareRecord } from '../types/index.js';
import type { SplitMethod } from '../constants/index.js';
import {
  calculateExpenseShares,
  distributeByWeights,
  validateExpensePayments,
  type CustomShareInput,
  type FamilyWeightInput,
  type WeightedParticipantInput,
} from './splitting.js';

/**
 * Proportionally re-scales payer contributions to a new total (largest-remainder, exact to the
 * paisa). Payers whose scaled amount rounds to 0 are dropped.
 */
export function rescalePayments(
  payments: ExpensePaymentInput[],
  newAmountPaisa: number
): ExpensePaymentInput[] {
  if (payments.length === 1) {
    return [{ ...payments[0]!, amountPaisa: newAmountPaisa }];
  }
  const keyed = payments.map((p, i) => ({
    id: String(i).padStart(8, '0'),
    weight: p.amountPaisa,
  }));
  const scaled = distributeByWeights(newAmountPaisa, keyed);
  return payments
    .map((p, i) => ({ ...p, amountPaisa: scaled.get(keyed[i]!.id) ?? 0 }))
    .filter((p) => p.amountPaisa > 0);
}

/**
 * Resolves the PER_FAMILY configuration of an existing expense: the persisted `splitConfig`, or,
 * for legacy expenses without one, a configuration derived from the recorded shares.
 */
export function resolvePerFamilyConfig(
  expense: Pick<ExpenseRecord, 'shares' | 'splitConfig'>
): { includedFamilyIds?: string[]; familyWeights?: FamilyWeightInput[] } {
  const cfg = expense.splitConfig;
  if (cfg) {
    return { includedFamilyIds: cfg.includedFamilyIds, familyWeights: cfg.familyWeights };
  }
  const hasSolo = expense.shares.some((s) => !s.familyId);
  return {
    includedFamilyIds: hasSolo
      ? undefined
      : Array.from(new Set(expense.shares.map((s) => s.familyId as string))),
    familyWeights: undefined,
  };
}

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
    payments = rescalePayments(expense.payments, newAmountPaisa);
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
      const cfg = resolvePerFamilyConfig(expense);
      shares = calculateExpenseShares({
        amountPaisa: newAmountPaisa,
        splitMethod: 'PER_FAMILY',
        participants,
        families,
        includedParticipantIds: sharedParticipantIds,
        includedFamilyIds: cfg.includedFamilyIds,
        familyWeights: cfg.familyWeights,
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

/**
 * Financial inputs of an expense edit (PATCH). Metadata fields (title, category, description,
 * payment method, ...) are intentionally absent: they never influence payments or shares.
 */
export interface ExpenseEditPatch {
  amountPaisa?: number;
  splitMethod?: SplitMethod;
  payments?: ExpensePaymentInput[];
  includedParticipantIds?: string[];
  includedFamilyIds?: string[];
  customShares?: CustomShareInput[];
  weights?: WeightedParticipantInput[];
  familyWeights?: FamilyWeightInput[];
  packageRatePerPersonPaisa?: number;
}

export interface ExpenseEditPlan {
  amountPaisa: number;
  splitMethod: SplitMethod;
  /** null = payments must be left untouched. */
  payments: ExpensePaymentInput[] | null;
  /** null = shares must be left untouched. */
  shares: ExpenseShareRecord[] | null;
  /** undefined = leave as is, null = clear, object = replace. */
  packageConfig?: { ratePerUnitPaisa: number; unitCount: number } | null;
  /** undefined = leave as is, null = clear, object = replace. */
  splitConfig?: NonNullable<ExpenseRecord['splitConfig']> | null;
}

/**
 * Plans an expense edit.
 *
 *  1. No financial input (or amount/method unchanged and nothing else) -> shares untouched.
 *     Payments are replaced only if explicitly supplied.
 *  2. Amount changed, no split input -> the Task 1 re-scale strategy (`rescaleExpense`).
 *  3. Any split input supplied -> shares recomputed from the patch; every omitted split
 *     parameter falls back to the expense's persisted configuration (weights from `weightUsed`,
 *     PER_FAMILY families/weights from `splitConfig`, CUSTOM amounts scaled proportionally).
 *
 * Pure: performs no I/O and returns the complete target state; throws before anything is written
 * if the result would not reconcile to the paisa.
 */
export function planExpenseEdit(params: {
  expense: Pick<
    ExpenseRecord,
    'amountPaisa' | 'splitMethod' | 'payments' | 'shares' | 'packageConfig' | 'splitConfig'
  >;
  patch: ExpenseEditPatch;
  participants: ParticipantEntity[];
  families: FamilyEntity[];
}): ExpenseEditPlan {
  const { expense, patch, participants, families } = params;
  const activeIds = new Set(participants.filter((p) => p.isActive).map((p) => p.id));

  const newAmount = patch.amountPaisa ?? expense.amountPaisa;
  const newMethod = patch.splitMethod ?? expense.splitMethod;
  const amountChanged = newAmount !== expense.amountPaisa;
  const methodChanged = newMethod !== expense.splitMethod;
  const splitInputs =
    methodChanged ||
    patch.includedParticipantIds !== undefined ||
    patch.includedFamilyIds !== undefined ||
    patch.customShares !== undefined ||
    patch.weights !== undefined ||
    patch.familyWeights !== undefined ||
    patch.packageRatePerPersonPaisa !== undefined;

  // ---- 1. Nothing that affects shares ------------------------------------------------------
  if (!amountChanged && !splitInputs) {
    if (patch.payments) {
      validateExpensePayments(newAmount, patch.payments, activeIds);
      return { amountPaisa: newAmount, splitMethod: newMethod, payments: patch.payments, shares: null };
    }
    return { amountPaisa: newAmount, splitMethod: newMethod, payments: null, shares: null };
  }

  // ---- 2. Amount changed only: re-scale existing configuration -----------------------------
  if (!splitInputs) {
    const r = rescaleExpense({
      expense,
      newAmountPaisa: newAmount,
      participants,
      families,
      overridePayments: patch.payments,
    });
    const backfilledSplitConfig =
      newMethod === 'PER_FAMILY' && !expense.splitConfig
        ? resolvePerFamilyConfig(expense)
        : undefined;
    return {
      amountPaisa: newAmount,
      splitMethod: newMethod,
      payments: r.payments,
      shares: r.shares,
      packageConfig: r.packageConfig,
      splitConfig: backfilledSplitConfig,
    };
  }

  // ---- 3. Split inputs supplied: recompute with persisted-config fallbacks -----------------
  const wasMethod = expense.splitMethod;
  const existingIds = expense.shares.map((s) => s.participantId);
  const familyScopeChanged =
    newMethod === 'PER_FAMILY' &&
    (methodChanged || patch.includedFamilyIds !== undefined);
  const includedParticipantIds =
    patch.includedParticipantIds ?? (familyScopeChanged ? undefined : existingIds);

  let customShares = patch.customShares;
  let weights = patch.weights;
  let includedFamilyIds = patch.includedFamilyIds;
  let familyWeights = patch.familyWeights;
  let packageRate: number | undefined;
  let packageConfig: ExpenseEditPlan['packageConfig'];
  let splitConfig: ExpenseEditPlan['splitConfig'];

  switch (newMethod) {
    case 'CUSTOM':
      if (!customShares && wasMethod === 'CUSTOM') {
        if (patch.includedParticipantIds !== undefined) {
          const existingSet = new Set(existingIds);
          const nextSet = new Set(patch.includedParticipantIds);
          const sameParticipants =
            existingSet.size === nextSet.size &&
            Array.from(nextSet).every((id) => existingSet.has(id));
          if (!sameParticipants) {
            throw new Error(
              'Changing includedParticipantIds on a CUSTOM split requires explicit customShares.'
            );
          }
        }
        const scaled = distributeByWeights(
          newAmount,
          expense.shares
            .filter((s) => s.sharePaisa > 0)
            .map((s) => ({ id: s.participantId, weight: s.sharePaisa }))
        );
        customShares = Array.from(scaled.entries()).map(([participantId, amountPaisa]) => ({
          participantId,
          amountPaisa,
        }));
      }
      break;
    case 'WEIGHTED':
      if (!weights && wasMethod === 'WEIGHTED') {
        weights = expense.shares.map((s) => ({
          participantId: s.participantId,
          weight: s.weightUsed && s.weightUsed > 0 ? s.weightUsed : 1,
        }));
      }
      break;
    case 'PER_FAMILY': {
      if (wasMethod === 'PER_FAMILY') {
        const prev = resolvePerFamilyConfig(expense);
        includedFamilyIds = includedFamilyIds ?? prev.includedFamilyIds;
        familyWeights = familyWeights ?? prev.familyWeights;
      }
      splitConfig = { includedFamilyIds, familyWeights };
      break;
    }
    case 'PACKAGE': {
      const targetIds =
        includedParticipantIds && includedParticipantIds.length > 0
          ? Array.from(new Set(includedParticipantIds))
          : participants.filter((p) => p.isActive).map((p) => p.id);
      const headcount = targetIds.length;
      packageRate = patch.packageRatePerPersonPaisa;
      if (packageRate === undefined) {
        if (
          !amountChanged &&
          wasMethod === 'PACKAGE' &&
          expense.packageConfig?.ratePerUnitPaisa
        ) {
          packageRate = expense.packageConfig.ratePerUnitPaisa;
        } else {
          if (headcount === 0 || newAmount % headcount !== 0) {
            throw new Error(
              `Package amount (${newAmount} paisa) is not divisible by ${headcount} participants. ` +
                'Provide packageRatePerPersonPaisa so that rate × participants equals the amount.'
            );
          }
          packageRate = newAmount / headcount;
        }
      }
      packageConfig = { ratePerUnitPaisa: packageRate, unitCount: headcount };
      break;
    }
    default:
      break;
  }

  // Configuration belonging to a method we are leaving must not linger.
  if (methodChanged && wasMethod === 'PACKAGE') packageConfig = null;
  if (newMethod !== 'PER_FAMILY' && (expense.splitConfig || wasMethod === 'PER_FAMILY')) {
    splitConfig = null;
  }

  const shares = calculateExpenseShares({
    amountPaisa: newAmount,
    splitMethod: newMethod,
    participants,
    families,
    includedParticipantIds,
    includedFamilyIds,
    customShares,
    weights,
    familyWeights,
    packageRatePerPersonPaisa: packageRate,
  });

  let payments: ExpensePaymentInput[] | null = null;
  if (patch.payments) {
    payments = patch.payments;
    validateExpensePayments(newAmount, payments, activeIds);
  } else if (amountChanged) {
    payments = rescalePayments(expense.payments, newAmount);
    validateExpensePayments(newAmount, payments);
  }

  const paid = (payments ?? expense.payments).reduce((a, p) => a + p.amountPaisa, 0);
  const owed = shares.reduce((a, s) => a + s.sharePaisa, 0);
  if (paid !== newAmount || owed !== newAmount) {
    throw new Error(
      `Edit invariant violation: payments=${paid}, shares=${owed}, expected=${newAmount}.`
    );
  }

  return { amountPaisa: newAmount, splitMethod: newMethod, payments, shares, packageConfig, splitConfig };
}
