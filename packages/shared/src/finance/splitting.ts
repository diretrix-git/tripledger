import { assertNonNegativePaisa, assertPositivePaisa, formatPaisaToNPR } from '../currency/index.js';
import type { SplitMethod } from '../constants/index.js';
import type {
  ExpensePaymentInput,
  ExpenseShareRecord,
  FamilyEntity,
  ParticipantEntity,
} from '../types/index.js';

export interface WeightedParticipantInput {
  participantId: string;
  weight: number;
}

export interface CustomShareInput {
  participantId: string;
  amountPaisa: number;
}

export interface FamilyWeightInput {
  familyId: string;
  weight?: number;
}

export interface CalculateSplitParams {
  amountPaisa: number;
  splitMethod: SplitMethod;
  participants: ParticipantEntity[];
  families?: FamilyEntity[];
  includedParticipantIds?: string[];
  includedFamilyIds?: string[];
  customShares?: CustomShareInput[];
  weights?: WeightedParticipantInput[];
  familyWeights?: FamilyWeightInput[];
  packageRatePerPersonPaisa?: number;
}

/**
 * Validates that all payment contributions are positive integers and sum to the exact expense amount.
 */
export function validateExpensePayments(
  amountPaisa: number,
  payments: ExpensePaymentInput[],
  validParticipantIds?: Set<string>
): void {
  assertPositivePaisa(amountPaisa, 'Expense total amount');

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error('At least one payer contribution is required for an expense.');
  }

  let totalPaidPaisa = 0;
  for (const payment of payments) {
    if (!payment.participantId || payment.participantId.trim() === '') {
      throw new Error('Every payment contribution must reference a valid participantId.');
    }
    if (validParticipantIds && !validParticipantIds.has(payment.participantId)) {
      throw new Error(`Payer "${payment.participantId}" does not belong to this trip.`);
    }
    assertPositivePaisa(payment.amountPaisa, `Contribution by ${payment.participantId}`);
    totalPaidPaisa += payment.amountPaisa;
  }

  if (totalPaidPaisa !== amountPaisa) {
    throw new Error(
      `Total recorded payments (${formatPaisaToNPR(totalPaidPaisa, { showDecimalsIfZero: true })}) must equal expense amount (${formatPaisaToNPR(amountPaisa, { showDecimalsIfZero: true })}).`
    );
  }
}

/**
 * Distributes an integer paisa amount proportionally across weighted items using the
 * Largest Remainder Method with canonical ID tie-breaking.
 * Never loses or fabricates a single paisa.
 */
export function distributeByWeights<T extends { id: string; weight: number }>(
  amountPaisa: number,
  items: T[]
): Map<string, number> {
  assertNonNegativePaisa(amountPaisa, 'Distribution amount');

  if (items.length === 0) {
    if (amountPaisa === 0) return new Map();
    throw new Error('Cannot distribute positive amount across zero recipients.');
  }

  // Convert weights to integer basis points (1 weight unit = 10,000 basis points)
  const scaledItems = items.map((item) => {
    if (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight <= 0) {
      throw new Error(`Invalid weight (${String(item.weight)}) for recipient "${item.id}". Weight must be > 0.`);
    }
    const scaledWeight = Math.round(item.weight * 10000);
    if (scaledWeight <= 0) {
      throw new Error(`Weight for recipient "${item.id}" is too small.`);
    }
    return { id: item.id, scaledWeight };
  });

  const totalScaledWeight = scaledItems.reduce((acc, item) => acc + item.scaledWeight, 0);
  if (totalScaledWeight <= 0) {
    throw new Error('Total weight must be greater than zero.');
  }

  // Use BigInt for intermediate numerator products to avoid overflow on large amounts
  const bigAmount = BigInt(amountPaisa);
  const bigTotalWeight = BigInt(totalScaledWeight);

  const allocations = scaledItems.map((item) => {
    const numerator = bigAmount * BigInt(item.scaledWeight);
    const floorShare = Number(numerator / bigTotalWeight);
    const remainderNumerator = numerator % bigTotalWeight;
    return {
      id: item.id,
      floorShare,
      remainderNumerator,
    };
  });

  const sumFloor = allocations.reduce((acc, a) => acc + a.floorShare, 0);
  const leftoverPaisa = amountPaisa - sumFloor;

  // Sort by largest remainder descending, then canonical ID ascending for deterministic tie-breaking
  const sortedForRemainder = [...allocations].sort((a, b) => {
    if (b.remainderNumerator > a.remainderNumerator) return 1;
    if (b.remainderNumerator < a.remainderNumerator) return -1;
    return a.id.localeCompare(b.id);
  });

  const result = new Map<string, number>();
  for (let i = 0; i < sortedForRemainder.length; i++) {
    const entry = sortedForRemainder[i];
    const bonus = i < leftoverPaisa ? 1 : 0;
    result.set(entry.id, entry.floorShare + bonus);
  }

  return result;
}

/**
 * Calculates participant ExpenseShareRecords for any of the 6 supported split strategies:
 * EQUAL, SELECTIVE, CUSTOM, WEIGHTED, PER_FAMILY, PACKAGE.
 */
export function calculateExpenseShares(params: CalculateSplitParams): ExpenseShareRecord[] {
  const {
    amountPaisa,
    splitMethod,
    participants,
    families = [],
    includedParticipantIds,
    includedFamilyIds,
    customShares,
    weights,
    familyWeights,
    packageRatePerPersonPaisa,
  } = params;

  assertPositivePaisa(amountPaisa, 'Expense amount');

  const activeParticipants = participants.filter((p) => p.isActive);
  if (activeParticipants.length === 0) {
    throw new Error('Trip has no active participants to split the expense across.');
  }

  const participantMap = new Map(activeParticipants.map((p) => [p.id, p]));

  const resolveIncludedParticipants = (): ParticipantEntity[] => {
    if (!includedParticipantIds || includedParticipantIds.length === 0) {
      return activeParticipants;
    }
    const uniqueIds = Array.from(new Set(includedParticipantIds));
    const resolved: ParticipantEntity[] = [];
    for (const id of uniqueIds) {
      const p = participantMap.get(id);
      if (!p) {
        throw new Error(`Included participant "${id}" is not an active participant in this trip.`);
      }
      resolved.push(p);
    }
    return resolved;
  };

  let shares: ExpenseShareRecord[] = [];

  switch (splitMethod) {
    case 'EQUAL': {
      const targets = resolveIncludedParticipants();
      if (targets.length === 0) {
        throw new Error('EQUAL split requires at least one participant.');
      }
      const distribution = distributeByWeights(
        amountPaisa,
        targets.map((p) => ({ id: p.id, weight: 1 }))
      );
      shares = targets.map((p) => ({
        participantId: p.id,
        familyId: p.familyId ?? null,
        sharePaisa: distribution.get(p.id) ?? 0,
        weightUsed: 1,
      }));
      break;
    }

    case 'SELECTIVE': {
      if (!includedParticipantIds || includedParticipantIds.length === 0) {
        throw new Error('SELECTIVE split requires at least one selected participant.');
      }
      const targets = resolveIncludedParticipants();
      const distribution = distributeByWeights(
        amountPaisa,
        targets.map((p) => ({ id: p.id, weight: 1 }))
      );
      shares = targets.map((p) => ({
        participantId: p.id,
        familyId: p.familyId ?? null,
        sharePaisa: distribution.get(p.id) ?? 0,
        weightUsed: 1,
      }));
      break;
    }

    case 'CUSTOM': {
      if (!customShares || customShares.length === 0) {
        throw new Error('CUSTOM split requires explicit custom share amounts.');
      }
      let totalCustomPaisa = 0;
      const seenIds = new Set<string>();
      const customRecords: ExpenseShareRecord[] = [];

      for (const item of customShares) {
        if (seenIds.has(item.participantId)) {
          throw new Error(`Duplicate participant "${item.participantId}" in custom split.`);
        }
        seenIds.add(item.participantId);

        const participant = participantMap.get(item.participantId);
        if (!participant) {
          throw new Error(`Participant "${item.participantId}" is not active in this trip.`);
        }
        assertNonNegativePaisa(item.amountPaisa, `Custom share for ${participant.name}`);
        if (item.amountPaisa > 0) {
          totalCustomPaisa += item.amountPaisa;
          customRecords.push({
            participantId: participant.id,
            familyId: participant.familyId ?? null,
            sharePaisa: item.amountPaisa,
          });
        }
      }

      if (totalCustomPaisa !== amountPaisa) {
        const diff = amountPaisa - totalCustomPaisa;
        throw new Error(
          `Custom split shares (${formatPaisaToNPR(totalCustomPaisa, { showDecimalsIfZero: true })}) do not equal expense amount (${formatPaisaToNPR(amountPaisa, { showDecimalsIfZero: true })}). Difference: ${formatPaisaToNPR(diff, { showDecimalsIfZero: true, showSign: true })}.`
        );
      }

      shares = customRecords;
      break;
    }

    case 'WEIGHTED': {
      const targets = resolveIncludedParticipants();
      if (targets.length === 0) {
        throw new Error('WEIGHTED split requires at least one participant.');
      }

      const customWeightMap = new Map(
        (weights ?? []).map((w) => [w.participantId, w.weight])
      );

      const weightedItems = targets
        .map((p) => {
          const w = customWeightMap.has(p.id) ? customWeightMap.get(p.id)! : p.defaultWeight;
          return { participant: p, weight: w };
        })
        .filter((item) => item.weight > 0);

      if (weightedItems.length === 0) {
        throw new Error('WEIGHTED split requires at least one participant with weight > 0.');
      }

      const distribution = distributeByWeights(
        amountPaisa,
        weightedItems.map((item) => ({ id: item.participant.id, weight: item.weight }))
      );

      shares = weightedItems.map((item) => ({
        participantId: item.participant.id,
        familyId: item.participant.familyId ?? null,
        sharePaisa: distribution.get(item.participant.id) ?? 0,
        weightUsed: item.weight,
      }));
      break;
    }

    case 'PER_FAMILY': {
      const targets = resolveIncludedParticipants();
      if (targets.length === 0) {
        throw new Error('PER_FAMILY split requires participating members.');
      }

      // Group participating members by familyId (ungrouped participants form individual pseudo-units)
      const familyMap = new Map(families.map((f) => [f.id, f]));
      const unitMembers = new Map<string, ParticipantEntity[]>();

      for (const p of targets) {
        const unitKey = p.familyId ? `family:${p.familyId}` : `solo:${p.id}`;
        if (includedFamilyIds && includedFamilyIds.length > 0) {
          if (!p.familyId || !includedFamilyIds.includes(p.familyId)) {
            continue;
          }
        }
        const list = unitMembers.get(unitKey) ?? [];
        list.push(p);
        unitMembers.set(unitKey, list);
      }

      if (unitMembers.size === 0) {
        throw new Error('No valid families or members matched for PER_FAMILY split.');
      }

      const customFamilyWeightMap = new Map(
        (familyWeights ?? []).map((fw) => [`family:${fw.familyId}`, fw.weight ?? 1])
      );

      const unitWeightList = Array.from(unitMembers.keys()).map((unitKey) => {
        if (customFamilyWeightMap.has(unitKey)) {
          return { id: unitKey, weight: customFamilyWeightMap.get(unitKey)! };
        }
        if (unitKey.startsWith('family:')) {
          const fId = unitKey.slice('family:'.length);
          const fam = familyMap.get(fId);
          return { id: unitKey, weight: fam?.defaultWeight ?? 1 };
        }
        return { id: unitKey, weight: 1 };
      });

      // Step 1: Distribute total expense across family units
      const unitAllocations = distributeByWeights(amountPaisa, unitWeightList);

      // Step 2: Distribute each family unit's allocation across its participating members
      const computedShares: ExpenseShareRecord[] = [];
      for (const [unitKey, members] of unitMembers.entries()) {
        const unitPaisa = unitAllocations.get(unitKey) ?? 0;
        const memberDistribution = distributeByWeights(
          unitPaisa,
          members.map((m) => ({ id: m.id, weight: m.defaultWeight > 0 ? m.defaultWeight : 1 }))
        );
        for (const member of members) {
          computedShares.push({
            participantId: member.id,
            familyId: member.familyId ?? null,
            sharePaisa: memberDistribution.get(member.id) ?? 0,
            weightUsed: member.defaultWeight > 0 ? member.defaultWeight : 1,
          });
        }
      }

      shares = computedShares;
      break;
    }

    case 'PACKAGE': {
      const targets = resolveIncludedParticipants();
      if (targets.length === 0) {
        throw new Error('PACKAGE split requires at least one participant included in the package.');
      }

      if (packageRatePerPersonPaisa !== undefined) {
        assertPositivePaisa(packageRatePerPersonPaisa, 'Package rate per person');
        const expectedTotal = packageRatePerPersonPaisa * targets.length;
        if (expectedTotal !== amountPaisa) {
          throw new Error(
            `Package total (${formatPaisaToNPR(amountPaisa)}) must equal rate (${formatPaisaToNPR(packageRatePerPersonPaisa)}) × ${targets.length} participants (${formatPaisaToNPR(expectedTotal)}).`
          );
        }
        shares = targets.map((p) => ({
          participantId: p.id,
          familyId: p.familyId ?? null,
          sharePaisa: packageRatePerPersonPaisa,
          weightUsed: 1,
        }));
      } else {
        // Fallback if rate is derived from amountPaisa / targets.length
        const distribution = distributeByWeights(
          amountPaisa,
          targets.map((p) => ({ id: p.id, weight: 1 }))
        );
        shares = targets.map((p) => ({
          participantId: p.id,
          familyId: p.familyId ?? null,
          sharePaisa: distribution.get(p.id) ?? 0,
          weightUsed: 1,
        }));
      }
      break;
    }

    default: {
      const exhaustiveCheck: never = splitMethod;
      throw new Error(`Unsupported split method: ${String(exhaustiveCheck)}`);
    }
  }

  // Final post-condition invariant check
  const totalSharePaisa = shares.reduce((sum, s) => sum + s.sharePaisa, 0);
  if (totalSharePaisa !== amountPaisa) {
    throw new Error(
      `Internal Split Invariant Violation: sum of shares (${totalSharePaisa}) !== amountPaisa (${amountPaisa}).`
    );
  }

  return shares.sort((a, b) => a.participantId.localeCompare(b.participantId));
}
