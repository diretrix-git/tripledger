import crypto from 'crypto';
import type mongoose from 'mongoose';
import type {
  ExpenseApprovalStatus,
  ExpenseCategory,
  ExpensePaymentInput,
  ExpenseRecord,
  PaymentMethod,
  SplitMethod,
} from '@tripledger/shared';
import { ExpenseModel, type IExpense } from '../models/index.js';
import { loadTripLedgerData } from './ledgerService.js';
import { AppError } from '../utils/http.js';

export interface CanonicalExpenseRequestInput {
  tripId: string;
  actorParticipantId: string;
  title: string;
  description?: string;
  category: ExpenseCategory;
  amountPaisa: number;
  isEstimated: boolean;
  isPackage: boolean;
  packageRatePerPersonPaisa?: number;
  splitMethod: SplitMethod;
  paymentMethod: PaymentMethod;
  explicitIncurredAtIso: string | null;
  payments: ExpensePaymentInput[];
  includedParticipantIds?: string[];
  includedFamilyIds?: string[];
  customShares?: Array<{ participantId: string; amountPaisa: number }>;
  weights?: Array<{ participantId: string; weight: number }>;
  familyWeights?: Array<{ familyId: string; weight?: number }>;
}

export interface LegacyExpenseComputedState {
  approvalStatus: ExpenseApprovalStatus;
  computedShares: Array<{
    participantId: string;
    familyId?: string | null;
    sharePaisa: number;
    weightUsed?: number;
  }>;
}

/** Locale-independent UTF-16 code-point comparator for deterministic canonical ordering. */
function compareCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown };
    errorResponse?: {
      code?: unknown;
      writeErrors?: Array<{ code?: unknown }>;
    };
    writeErrors?: Array<{ code?: unknown; err?: { code?: unknown } }>;
  };
  if (
    e.code === 11000 ||
    e.cause?.code === 11000 ||
    e.errorResponse?.code === 11000
  ) {
    return true;
  }
  if (Array.isArray(e.writeErrors)) {
    if (e.writeErrors.some((w) => w?.code === 11000 || w?.err?.code === 11000)) {
      return true;
    }
  }
  if (Array.isArray(e.errorResponse?.writeErrors)) {
    if (e.errorResponse.writeErrors.some((w) => w?.code === 11000)) {
      return true;
    }
  }
  return false;
}

function normalizeCanonicalPayments(
  payments: ExpensePaymentInput[],
  defaultPaymentMethod: PaymentMethod
) {
  return payments
    .map((p) => ({
      participantId: p.participantId,
      amountPaisa: p.amountPaisa,
      paymentMethod: p.paymentMethod ?? defaultPaymentMethod,
      notes: p.notes && p.notes.length > 0 ? p.notes : null,
    }))
    .sort(
      (a, b) =>
        compareCodePoint(a.participantId, b.participantId) ||
        a.amountPaisa - b.amountPaisa ||
        compareCodePoint(a.paymentMethod, b.paymentMethod) ||
        compareCodePoint(a.notes ?? '', b.notes ?? '')
    );
}

function normalizeCanonicalIncludedIds(ids?: string[]): string[] | null {
  if (ids === undefined) return null;
  return [...new Set(ids)].sort(compareCodePoint);
}

function normalizeCanonicalCustomShares(
  customShares?: Array<{ participantId: string; amountPaisa: number }>
) {
  if (!customShares || customShares.length === 0) return [];
  // Last entry wins for duplicate participantId values before removing zero-paisa rows.
  const byParticipant = new Map<string, number>();
  for (const item of customShares) {
    byParticipant.set(item.participantId, item.amountPaisa);
  }
  return [...byParticipant.entries()]
    .filter(([, amountPaisa]) => amountPaisa > 0)
    .map(([participantId, amountPaisa]) => ({ participantId, amountPaisa }))
    .sort((a, b) => compareCodePoint(a.participantId, b.participantId));
}

function normalizeCanonicalWeights(
  weights?: Array<{ participantId: string; weight: number }>
) {
  if (!weights || weights.length === 0) return [];
  const byParticipant = new Map<string, number>();
  for (const w of weights) {
    byParticipant.set(w.participantId, w.weight);
  }
  return [...byParticipant.entries()]
    .map(([participantId, weight]) => ({ participantId, weight }))
    .sort((a, b) => compareCodePoint(a.participantId, b.participantId));
}

function normalizeCanonicalSplitConfig(splitConfig?: {
  includedFamilyIds?: string[];
  familyWeights?: Array<{ familyId: string; weight?: number }>;
}) {
  if (!splitConfig) return null;
  const includedFamilyIds = [...new Set(splitConfig.includedFamilyIds ?? [])].sort(
    compareCodePoint
  );
  const byFamily = new Map<string, number>();
  for (const fw of splitConfig.familyWeights ?? []) {
    byFamily.set(fw.familyId, fw.weight ?? 1);
  }
  const familyWeights = [...byFamily.entries()]
    .map(([familyId, weight]) => ({ familyId, weight }))
    .sort((a, b) => compareCodePoint(a.familyId, b.familyId));

  // Treat empty splitConfig fields identically to omitted splitConfig so legacy
  // PER_FAMILY records without splitConfig do not trigger false 409 conflicts.
  if (includedFamilyIds.length === 0 && familyWeights.length === 0) {
    return null;
  }

  return {
    includedFamilyIds,
    familyWeights,
  };
}

function normalizeCanonicalShares(
  shares: Array<{
    participantId: string;
    familyId?: string | null;
    sharePaisa: number;
    weightUsed?: number;
  }>
) {
  return shares
    .map((s) => ({
      participantId: s.participantId,
      familyId: s.familyId ?? null,
      sharePaisa: s.sharePaisa,
      weightUsed: s.weightUsed ?? 1,
    }))
    .sort((a, b) => compareCodePoint(a.participantId, b.participantId));
}

function buildCanonicalRequestProjection(input: CanonicalExpenseRequestInput) {
  const effectiveIsPackage = Boolean(
    input.isPackage || input.splitMethod === 'PACKAGE' || input.category === 'PACKAGE'
  );
  return {
    tripId: input.tripId,
    actorParticipantId: input.actorParticipantId,
    title: input.title,
    description: input.description && input.description.length > 0 ? input.description : null,
    category: input.category,
    amountPaisa: input.amountPaisa,
    isEstimated: input.isEstimated,
    isPackage: effectiveIsPackage,
    packageRatePerPersonPaisa: input.packageRatePerPersonPaisa ?? null,
    splitMethod: input.splitMethod,
    paymentMethod: input.paymentMethod,
    incurredAt: input.explicitIncurredAtIso,
    payments: normalizeCanonicalPayments(input.payments, input.paymentMethod),
    includedParticipantIds: normalizeCanonicalIncludedIds(input.includedParticipantIds),
    customShares: normalizeCanonicalCustomShares(input.customShares),
    weights: normalizeCanonicalWeights(input.weights),
    splitConfig: normalizeCanonicalSplitConfig({
      includedFamilyIds: input.includedFamilyIds,
      familyWeights: input.familyWeights,
    }),
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint solely from immutable authenticated
 * identity (`tripId`, `actorParticipantId`) and canonicalized request fields.
 * Never depends on mutable trip roster state, weights, or server-derived share rows.
 */
export function computeExpenseIdempotencyHash(input: CanonicalExpenseRequestInput): string {
  const canonical = buildCanonicalRequestProjection(input);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Fallback equivalence check for legacy Expense records created before `idempotencyHash`
 * existed. Compares persisted record, payment rows, and recomputed share rows canonically.
 *
 * Documented legacy limitations (when `idempotencyHash` is absent):
 * 1. If the retry omits `incurredAt`, the server cannot verify whether the original legacy
 *    submission omitted `incurredAt` or explicitly passed the server-generated timestamp.
 * 2. If a legacy expense was later edited, approved/rescaled, or affected by participant or
 *    family mutations (roster active status, participant `defaultWeight`, family membership,
 *    or family `defaultWeight`), the legacy comparison fails closed with `409 IDEMPOTENCY_KEY_REUSED`.
 * 3. Missing legacy `splitConfig` on `PER_FAMILY` or missing `packageConfig` on `PACKAGE`
 *    fails closed with `409` whenever the retry explicitly specifies those parameters.
 */
export function matchesLegacyExpenseRecord(
  record: ExpenseRecord,
  incoming: CanonicalExpenseRequestInput,
  legacyComputed: LegacyExpenseComputedState
): boolean {
  if (record.tripId !== incoming.tripId) return false;
  if (record.createdByParticipantId !== incoming.actorParticipantId) return false;
  if (record.title !== incoming.title) return false;

  const recordDescription =
    record.description && record.description.length > 0 ? record.description : null;
  const incomingDescription =
    incoming.description && incoming.description.length > 0 ? incoming.description : null;
  if (recordDescription !== incomingDescription) return false;

  if (record.category !== incoming.category) return false;
  if (record.amountPaisa !== incoming.amountPaisa) return false;
  if (record.isEstimated !== incoming.isEstimated) return false;

  const effectiveIsPackage = Boolean(
    incoming.isPackage || incoming.splitMethod === 'PACKAGE' || incoming.category === 'PACKAGE'
  );
  if (record.isPackage !== effectiveIsPackage) return false;
  if (record.splitMethod !== incoming.splitMethod) return false;
  if (record.paymentMethod !== incoming.paymentMethod) return false;
  if (record.approvalStatus !== legacyComputed.approvalStatus) return false;

  if (
    incoming.explicitIncurredAtIso !== null &&
    record.incurredAt !== incoming.explicitIncurredAtIso
  ) {
    return false;
  }

  if (incoming.packageRatePerPersonPaisa !== undefined) {
    if (
      !record.isPackage ||
      !record.packageConfig ||
      record.packageConfig.ratePerUnitPaisa !== incoming.packageRatePerPersonPaisa ||
      record.packageConfig.unitCount !== legacyComputed.computedShares.length
    ) {
      return false;
    }
  } else if (record.packageConfig !== undefined) {
    return false;
  }

  const incomingSplitConfig = normalizeCanonicalSplitConfig({
    includedFamilyIds: incoming.includedFamilyIds,
    familyWeights: incoming.familyWeights,
  });
  const recordSplitConfig = normalizeCanonicalSplitConfig(record.splitConfig);
  if (incoming.splitMethod !== 'PER_FAMILY' && incomingSplitConfig !== null) {
    return false;
  }
  if (JSON.stringify(recordSplitConfig) !== JSON.stringify(incomingSplitConfig)) {
    return false;
  }

  if (
    incoming.splitMethod !== 'CUSTOM' &&
    normalizeCanonicalCustomShares(incoming.customShares).length > 0
  ) {
    return false;
  }
  if (
    incoming.splitMethod !== 'WEIGHTED' &&
    normalizeCanonicalWeights(incoming.weights).length > 0
  ) {
    return false;
  }
  if (
    (incoming.splitMethod === 'CUSTOM' || incoming.splitMethod === 'PER_FAMILY') &&
    incoming.includedParticipantIds !== undefined &&
    incoming.includedParticipantIds.length > 0
  ) {
    // The PWA submits `includedParticipantIds` for every split method, including PER_FAMILY and
    // CUSTOM (often containing all active selected participants). Every persisted share recipient
    // must remain present in `includedParticipantIds`; for PER_FAMILY, exact participant-set
    // changes also fail `sharesMatch` below because `computeLegacyMatchInput` filters targets by
    // `includedParticipantIds`.
    const incomingIncludedSet = new Set(incoming.includedParticipantIds);
    for (const share of record.shares) {
      if (!incomingIncludedSet.has(share.participantId)) {
        return false;
      }
    }
  }

  const paymentsMatch =
    JSON.stringify(normalizeCanonicalPayments(record.payments, record.paymentMethod)) ===
    JSON.stringify(normalizeCanonicalPayments(incoming.payments, incoming.paymentMethod));
  if (!paymentsMatch) return false;

  const sharesMatch =
    JSON.stringify(normalizeCanonicalShares(record.shares)) ===
    JSON.stringify(normalizeCanonicalShares(legacyComputed.computedShares));
  return sharesMatch;
}

export function throwIdempotencyConflict(): never {
  throw new AppError(
    'This clientMutationId has already been used for a different expense payload in this trip.',
    409,
    'IDEMPOTENCY_KEY_REUSED'
  );
}

export type LoadedTripLedgerData = Awaited<ReturnType<typeof loadTripLedgerData>>;

async function matchesOmittedDefaultParticipantsHash(params: {
  existingHash: string;
  canonicalRequest: CanonicalExpenseRequestInput;
  resolveDefaultIncludedParticipantIds?: () => Promise<string[] | null>;
}): Promise<boolean> {
  const { existingHash, canonicalRequest, resolveDefaultIncludedParticipantIds } = params;
  if (
    !resolveDefaultIncludedParticipantIds ||
    canonicalRequest.includedParticipantIds !== undefined ||
    (canonicalRequest.splitMethod !== 'EQUAL' &&
      canonicalRequest.splitMethod !== 'WEIGHTED' &&
      canonicalRequest.splitMethod !== 'PACKAGE')
  ) {
    return false;
  }

  const activeParticipantIds = await resolveDefaultIncludedParticipantIds();
  if (!activeParticipantIds || activeParticipantIds.length === 0) {
    return false;
  }

  const alternateHash = computeExpenseIdempotencyHash({
    ...canonicalRequest,
    includedParticipantIds: activeParticipantIds,
  });
  return alternateHash === existingHash;
}

/**
 * Verifies actor ownership and payload equivalence against an existing Expense document
 * and builds the deduplicated `200` response payload, or throws `409 IDEMPOTENCY_KEY_REUSED`.
 *
 * When a concurrent standalone write has created the parent Expense document milliseconds
 * before its child payment/share rows finish inserting, waits briefly for child rows before
 * building the response. If child rows never appear on an existing Expense, fails with `503
 * IDEMPOTENCY_INCOMPLETE` instead of returning an incomplete `200` payload. Returns `null`
 * only if the concurrent document rolled back / ceased to exist.
 */
export async function resolveExistingIdempotentResponse(params: {
  tripId: mongoose.Types.ObjectId;
  existingDoc: Pick<IExpense, '_id' | 'idempotencyHash' | 'createdByParticipantId'> & {
    isDeleted?: boolean;
  };
  expectedHash: string;
  canonicalRequest: CanonicalExpenseRequestInput;
  resolveDefaultIncludedParticipantIds?: () => Promise<string[] | null>;
  computeLegacyMatchInput?: () => Promise<LegacyExpenseComputedState>;
  preloadedLedgerData?: LoadedTripLedgerData;
}) {
  const { tripId, existingDoc, expectedHash, canonicalRequest } = params;

  // Enforce same-actor ownership and payload hash equivalence before exposing/returning the expense.
  if (existingDoc.createdByParticipantId.toString() !== canonicalRequest.actorParticipantId) {
    throwIdempotencyConflict();
  }

  if (existingDoc.idempotencyHash && existingDoc.idempotencyHash !== expectedHash) {
    const matchedOmittedDefaults = await matchesOmittedDefaultParticipantsHash({
      existingHash: existingDoc.idempotencyHash,
      canonicalRequest,
      resolveDefaultIncludedParticipantIds: params.resolveDefaultIncludedParticipantIds,
    });
    if (!matchedOmittedDefaults) {
      throwIdempotencyConflict();
    }
  }

  if (existingDoc.isDeleted) {
    throwIdempotencyConflict();
  }

  const existingId = existingDoc._id.toString();
  let ledgerData = params.preloadedLedgerData;

  for (let attempt = 0; attempt < 5; attempt++) {
    let existingRecord = ledgerData?.expenses.find((e) => e.id === existingId);
    if (!existingRecord || existingRecord.payments.length === 0 || existingRecord.shares.length === 0) {
      ledgerData = await loadTripLedgerData(tripId);
      existingRecord = ledgerData.expenses.find((e) => e.id === existingId);
    }

    if (!existingRecord) {
      const deletedExists = await ExpenseModel.exists({ _id: existingDoc._id, isDeleted: true });
      if (deletedExists) {
        throwIdempotencyConflict();
      }
      const activeExists = await ExpenseModel.exists({ _id: existingDoc._id, isDeleted: false });
      if (!activeExists) {
        return null;
      }
    } else if (existingRecord.payments.length > 0 && existingRecord.shares.length > 0) {
      if (!existingDoc.idempotencyHash) {
        if (!params.computeLegacyMatchInput) {
          throwIdempotencyConflict();
        }
        const legacyComputed = await params.computeLegacyMatchInput();
        if (!matchesLegacyExpenseRecord(existingRecord, canonicalRequest, legacyComputed)) {
          throwIdempotencyConflict();
        }
      }
      return {
        expense: existingRecord,
        deduplicated: true as const,
        ledger: ledgerData!.ledger,
        individualSettlementSuggestions: ledgerData!.individualSettlementSuggestions,
        familySettlementSuggestions: ledgerData!.familySettlementSuggestions,
      };
    }

    await new Promise((r) => setTimeout(r, 20));
    const stillExists = await ExpenseModel.exists({ _id: existingDoc._id });
    if (!stillExists) {
      return null;
    }
    ledgerData = undefined;
  }

  const finalLedgerData = await loadTripLedgerData(tripId);
  const finalRecord = finalLedgerData.expenses.find((e) => e.id === existingId);
  if (!finalRecord) {
    const deletedExists = await ExpenseModel.exists({ _id: existingDoc._id, isDeleted: true });
    if (deletedExists) {
      throwIdempotencyConflict();
    }
    const activeExists = await ExpenseModel.exists({ _id: existingDoc._id, isDeleted: false });
    if (!activeExists) {
      return null;
    }
    throw new AppError(
      'Concurrent expense creation is incomplete or still finalizing. Please retry shortly.',
      503,
      'IDEMPOTENCY_INCOMPLETE'
    );
  }

  if (finalRecord.payments.length === 0 || finalRecord.shares.length === 0) {
    throw new AppError(
      'Concurrent expense creation is incomplete or still finalizing. Please retry shortly.',
      503,
      'IDEMPOTENCY_INCOMPLETE'
    );
  }

  if (!existingDoc.idempotencyHash) {
    if (!params.computeLegacyMatchInput) {
      throwIdempotencyConflict();
    }
    const legacyComputed = await params.computeLegacyMatchInput();
    if (!matchesLegacyExpenseRecord(finalRecord, canonicalRequest, legacyComputed)) {
      throwIdempotencyConflict();
    }
  }

  return {
    expense: finalRecord,
    deduplicated: true as const,
    ledger: finalLedgerData.ledger,
    individualSettlementSuggestions: finalLedgerData.individualSettlementSuggestions,
    familySettlementSuggestions: finalLedgerData.familySettlementSuggestions,
  };
}

/**
 * Recovers from a concurrent `E11000` duplicate-key error on `(tripId, clientMutationId)`
 * AFTER any failed transaction has already aborted. Runs outside any aborted `ClientSession`
 * so committed winner state is readable even after a multi-document transaction abort.
 */
export async function recoverDuplicateKeyExpenseResponse(params: {
  tripId: mongoose.Types.ObjectId;
  clientMutationId: string;
  expectedHash: string;
  canonicalRequest: CanonicalExpenseRequestInput;
  resolveDefaultIncludedParticipantIds?: () => Promise<string[] | null>;
  computeLegacyMatchInput?: () => Promise<LegacyExpenseComputedState>;
}) {
  const {
    tripId,
    clientMutationId,
    expectedHash,
    canonicalRequest,
    resolveDefaultIncludedParticipantIds,
    computeLegacyMatchInput,
  } = params;

  const winner = await ExpenseModel.findOne({ tripId, clientMutationId });
  if (!winner) {
    return null;
  }

  return resolveExistingIdempotentResponse({
    tripId,
    existingDoc: winner,
    expectedHash,
    canonicalRequest,
    resolveDefaultIncludedParticipantIds,
    computeLegacyMatchInput,
  });
}
