import type {
  FamilyBalanceSummary,
  IndividualBalanceSummary,
  SettlementSuggestion,
} from '../types/index.js';

interface NetNode {
  id: string;
  participantId: string;
  participantName: string;
  familyId?: string | null;
  familyName?: string | null;
  balancePaisa: number;
}

/**
 * Core debt-simplification engine that minimizes the number of transfers required
 * to settle all outstanding balances to zero while preserving exact net balances.
 *
 * Uses exact-match pairing first (settling two parties in 1 transfer when debt === credit),
 * followed by greedy largest-debtor to largest-creditor matching with deterministic tie-breaking.
 */
function optimizeNetNodes(
  nodes: NetNode[],
  mode: 'INDIVIDUAL' | 'FAMILY'
): SettlementSuggestion[] {
  const debtors = nodes
    .filter((n) => n.balancePaisa < 0)
    .map((n) => ({ ...n, remainingPaisa: -n.balancePaisa }));

  const creditors = nodes
    .filter((n) => n.balancePaisa > 0)
    .map((n) => ({ ...n, remainingPaisa: n.balancePaisa }));

  const suggestions: SettlementSuggestion[] = [];

  const sortBucket = (bucket: Array<NetNode & { remainingPaisa: number }>) => {
    bucket.sort((a, b) => {
      if (b.remainingPaisa !== a.remainingPaisa) {
        return b.remainingPaisa - a.remainingPaisa;
      }
      return a.id.localeCompare(b.id);
    });
  };

  while (debtors.length > 0 && creditors.length > 0) {
    sortBucket(debtors);
    sortBucket(creditors);

    // Check if an exact match exists between any active debtor and creditor
    let matchedDebtorIdx = 0;
    let matchedCreditorIdx = 0;
    let foundExact = false;

    for (let dIdx = 0; dIdx < debtors.length && !foundExact; dIdx++) {
      for (let cIdx = 0; cIdx < creditors.length; cIdx++) {
        if (debtors[dIdx].remainingPaisa === creditors[cIdx].remainingPaisa) {
          matchedDebtorIdx = dIdx;
          matchedCreditorIdx = cIdx;
          foundExact = true;
          break;
        }
      }
    }

    const debtor = debtors[matchedDebtorIdx];
    const creditor = creditors[matchedCreditorIdx];
    const transferPaisa = Math.min(debtor.remainingPaisa, creditor.remainingPaisa);

    if (transferPaisa > 0) {
      suggestions.push({
        mode,
        fromParticipantId: debtor.participantId,
        fromParticipantName: debtor.participantName,
        toParticipantId: creditor.participantId,
        toParticipantName: creditor.participantName,
        fromFamilyId: debtor.familyId ?? null,
        fromFamilyName: debtor.familyName ?? null,
        toFamilyId: creditor.familyId ?? null,
        toFamilyName: creditor.familyName ?? null,
        amountPaisa: transferPaisa,
      });
    }

    debtor.remainingPaisa -= transferPaisa;
    creditor.remainingPaisa -= transferPaisa;

    if (debtor.remainingPaisa === 0) {
      debtors.splice(matchedDebtorIdx, 1);
    }
    if (creditor.remainingPaisa === 0) {
      const adjustedCreditorIdx = creditors.indexOf(creditor);
      if (adjustedCreditorIdx !== -1) {
        creditors.splice(adjustedCreditorIdx, 1);
      }
    }
  }

  return suggestions;
}

/**
 * Generates minimum-transfer settlement suggestions at the individual participant level.
 */
export function calculateIndividualSettlements(
  individualBalances: IndividualBalanceSummary[]
): SettlementSuggestion[] {
  const nodes: NetNode[] = individualBalances.map((b) => ({
    id: b.participantId,
    participantId: b.participantId,
    participantName: b.participantName,
    familyId: b.familyId,
    familyName: b.familyName,
    balancePaisa: b.outstandingBalancePaisa,
  }));

  return optimizeNetNodes(nodes, 'INDIVIDUAL');
}

/**
 * Generates minimum-transfer settlement suggestions at the Family level
 * (routing family transfers through each family's designated representative,
 * while also including any ungrouped solo participants in the trip).
 */
export function calculateFamilySettlements(
  familyBalances: FamilyBalanceSummary[],
  ungroupedBalances: IndividualBalanceSummary[] = []
): SettlementSuggestion[] {
  const nodes: NetNode[] = [];

  for (const fam of familyBalances) {
    if (fam.memberCount === 0 || !fam.representativeId || !fam.representativeName) {
      continue;
    }
    nodes.push({
      id: `family:${fam.familyId}`,
      participantId: fam.representativeId,
      participantName: fam.representativeName,
      familyId: fam.familyId,
      familyName: fam.familyName,
      balancePaisa: fam.outstandingBalancePaisa,
    });
  }

  for (const solo of ungroupedBalances) {
    nodes.push({
      id: `solo:${solo.participantId}`,
      participantId: solo.participantId,
      participantName: solo.participantName,
      familyId: null,
      familyName: null,
      balancePaisa: solo.outstandingBalancePaisa,
    });
  }

  return optimizeNetNodes(nodes, 'FAMILY');
}
