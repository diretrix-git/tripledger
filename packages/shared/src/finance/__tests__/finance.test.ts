import { describe, expect, it } from 'vitest';
import {
  formatPaisaToNPR,
  nprToPaisa,
  paisaToNprNumber,
  paisaToNprString,
} from '../../currency/index.js';
import {
  calculateExpenseShares,
  calculateFamilySettlements,
  calculateIndividualSettlements,
  calculateTripBalances,
  validateExpensePayments,
  verifyLedgerInvariants,
} from '../../index.js';
import type {
  ExpenseRecord,
  FamilyEntity,
  ParticipantEntity,
  SettlementRecord,
} from '../../types/index.js';

const mockParticipants: ParticipantEntity[] = [
  {
    id: 'p1',
    tripId: 't1',
    familyId: 'f1',
    name: 'Aarav Sharma',
    role: 'ORGANIZER',
    memberType: 'ADULT',
    defaultWeight: 1,
    isActive: true,
  },
  {
    id: 'p2',
    tripId: 't1',
    familyId: 'f1',
    name: 'Bina Sharma',
    role: 'FAMILY_REP',
    memberType: 'ADULT',
    defaultWeight: 1,
    isActive: true,
  },
  {
    id: 'p3',
    tripId: 't1',
    familyId: 'f1',
    name: 'Chiran Sharma (Child)',
    role: 'PARTICIPANT',
    memberType: 'CHILD',
    defaultWeight: 0.5,
    isActive: true,
  },
  {
    id: 'p4',
    tripId: 't1',
    familyId: 'f2',
    name: 'Dipesh Thapa',
    role: 'FAMILY_REP',
    memberType: 'ADULT',
    defaultWeight: 1,
    isActive: true,
  },
  {
    id: 'p5',
    tripId: 't1',
    familyId: 'f2',
    name: 'Esha Thapa',
    role: 'PARTICIPANT',
    memberType: 'ADULT',
    defaultWeight: 1,
    isActive: true,
  },
  {
    id: 'p6',
    tripId: 't1',
    familyId: null,
    name: 'Gaurav Gurung (Solo)',
    role: 'CONTRIBUTOR',
    memberType: 'ADULT',
    defaultWeight: 1,
    isActive: true,
  },
];

const mockFamilies: FamilyEntity[] = [
  {
    id: 'f1',
    tripId: 't1',
    name: 'Sharma Family',
    representativeId: 'p1',
    defaultWeight: 1,
  },
  {
    id: 'f2',
    tripId: 't1',
    name: 'Thapa Family',
    representativeId: 'p4',
    defaultWeight: 1,
  },
];

describe('TripLedger Currency & Paisa Math', () => {
  it('accurately converts NPR strings and numbers to integer paisa without float drift', () => {
    expect(nprToPaisa('1')).toBe(100);
    expect(nprToPaisa('33000')).toBe(3300000);
    expect(nprToPaisa('33,000.75')).toBe(3300075);
    expect(nprToPaisa(19.99)).toBe(1999);
    expect(nprToPaisa('0.05')).toBe(5);
    expect(paisaToNprNumber(3300075)).toBe(33000.75);
    expect(paisaToNprString(3300000)).toBe('33000');
    expect(paisaToNprString(3300050)).toBe('33000.50');
  });

  it('formats integer paisa into South Asian / Nepali NPR strings', () => {
    expect(formatPaisaToNPR(3300000)).toBe('NPR 33,000');
    expect(formatPaisaToNPR(125050)).toBe('NPR 1,250.50');
    expect(formatPaisaToNPR(-50000, { showSign: true })).toBe('-NPR 500');
    expect(formatPaisaToNPR(50000, { showSign: true })).toBe('+NPR 500');
  });

  it('rejects invalid decimal precision or non-numeric currency input', () => {
    expect(() => nprToPaisa('100.123')).toThrow();
    expect(() => nprToPaisa('abc')).toThrow();
  });
});

describe('Multiple Payer Validation (Invariant 1)', () => {
  it('accepts multiple payers whose contributions equal the exact expense amount', () => {
    // Fuel expense: NPR 5,000 (500,000 paisa). Person A pays 3,000; Person B pays 2,000.
    expect(() =>
      validateExpensePayments(500000, [
        { participantId: 'p1', amountPaisa: 300000 },
        { participantId: 'p4', amountPaisa: 200000 },
      ])
    ).not.toThrow();
  });

  it('rejects multiple payers when sum does not match the expense amount', () => {
    expect(() =>
      validateExpensePayments(500000, [
        { participantId: 'p1', amountPaisa: 300000 },
        { participantId: 'p4', amountPaisa: 199999 },
      ])
    ).toThrow(/must equal expense amount/);
  });
});

describe('Deterministic Splitting Strategies (Invariant 2 — Never Lose Leftover Paisa)', () => {
  it('splits NPR 100.00 (10,000 paisa) equally across 3 people deterministically without losing 1 paisa', () => {
    const threePeople = mockParticipants.slice(0, 3);
    const shares = calculateExpenseShares({
      amountPaisa: 10000,
      splitMethod: 'EQUAL',
      participants: threePeople,
    });

    expect(shares).toHaveLength(3);
    expect(shares.map((s) => s.sharePaisa)).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((acc, s) => acc + s.sharePaisa, 0)).toBe(10000);
  });

  it('supports selective splitting across a subset of participants', () => {
    const shares = calculateExpenseShares({
      amountPaisa: 1000,
      splitMethod: 'SELECTIVE',
      participants: mockParticipants,
      includedParticipantIds: ['p1', 'p4', 'p6'],
    });

    expect(shares).toHaveLength(3);
    expect(shares.map((s) => s.participantId)).toEqual(['p1', 'p4', 'p6']);
    expect(shares.reduce((acc, s) => acc + s.sharePaisa, 0)).toBe(1000);
  });

  it('validates and computes custom amount splitting', () => {
    const shares = calculateExpenseShares({
      amountPaisa: 500000,
      splitMethod: 'CUSTOM',
      participants: mockParticipants,
      customShares: [
        { participantId: 'p1', amountPaisa: 200000 },
        { participantId: 'p4', amountPaisa: 150000 },
        { participantId: 'p6', amountPaisa: 150000 },
      ],
    });

    expect(shares.reduce((acc, s) => acc + s.sharePaisa, 0)).toBe(500000);

    expect(() =>
      calculateExpenseShares({
        amountPaisa: 500000,
        splitMethod: 'CUSTOM',
        participants: mockParticipants,
        customShares: [
          { participantId: 'p1', amountPaisa: 200000 },
          { participantId: 'p4', amountPaisa: 200000 },
        ],
      })
    ).toThrow(/do not equal expense amount/);
  });

  it('computes weighted splitting using participant default weights or overrides', () => {
    // p1 (1), p2 (1), p3 (0.5) => total weight = 2.5. Expense = NPR 2,500 (250,000 paisa)
    const shares = calculateExpenseShares({
      amountPaisa: 250000,
      splitMethod: 'WEIGHTED',
      participants: mockParticipants.slice(0, 3),
    });

    const map = new Map(shares.map((s) => [s.participantId, s.sharePaisa]));
    expect(map.get('p1')).toBe(100000);
    expect(map.get('p2')).toBe(100000);
    expect(map.get('p3')).toBe(50000);
  });

  it('computes PER_FAMILY splitting and reconciles family totals with member shares', () => {
    // 2 families: Sharma (3 members) and Thapa (2 members). Total = NPR 10,000 (1,000,000 paisa)
    const shares = calculateExpenseShares({
      amountPaisa: 1000000,
      splitMethod: 'PER_FAMILY',
      participants: mockParticipants.slice(0, 5),
      families: mockFamilies,
    });

    const sharmaTotal = shares
      .filter((s) => s.familyId === 'f1')
      .reduce((sum, s) => sum + s.sharePaisa, 0);
    const thapaTotal = shares
      .filter((s) => s.familyId === 'f2')
      .reduce((sum, s) => sum + s.sharePaisa, 0);

    expect(sharmaTotal).toBe(500000);
    expect(thapaTotal).toBe(500000);
    expect(sharmaTotal + thapaTotal).toBe(1000000);
  });

  it('computes fixed per-person PACKAGE expenses (e.g. NPR 3,000 × 6 participants = NPR 18,000)', () => {
    const shares = calculateExpenseShares({
      amountPaisa: 1800000,
      splitMethod: 'PACKAGE',
      participants: mockParticipants,
      packageRatePerPersonPaisa: 300000,
    });

    expect(shares).toHaveLength(6);
    expect(shares.every((s) => s.sharePaisa === 300000)).toBe(true);
  });
});

describe('Full Ledger Invariants, Family Reconciliation, Editing & Settlements (Invariants 3-8)', () => {
  const buildTestLedger = () => {
    // Expense 1: Resort Package (NPR 3,000 per person * 6 = NPR 18,000 = 1,800,000 paisa)
    // Paid by Aarav (p1: NPR 10,000) and Dipesh (p4: NPR 8,000)
    const exp1Shares = calculateExpenseShares({
      amountPaisa: 1800000,
      splitMethod: 'PACKAGE',
      participants: mockParticipants,
      packageRatePerPersonPaisa: 300000,
    });

    const exp1: ExpenseRecord = {
      id: 'e1',
      tripId: 't1',
      title: 'Resort Package',
      category: 'PACKAGE',
      amountPaisa: 1800000,
      isEstimated: false,
      isPackage: true,
      packageConfig: { ratePerUnitPaisa: 300000, unitCount: 6 },
      splitMethod: 'PACKAGE',
      paymentMethod: 'BANK_TRANSFER',
      approvalStatus: 'APPROVED',
      incurredAt: new Date().toISOString(),
      createdByParticipantId: 'p1',
      isDeleted: false,
      payments: [
        { participantId: 'p1', amountPaisa: 1000000 },
        { participantId: 'p4', amountPaisa: 800000 },
      ],
      shares: exp1Shares,
    };

    // Expense 2: Fuel (NPR 5,000 = 500,000 paisa), split PER_FAMILY across f1 & f2 (excluding solo p6)
    // Paid by Gaurav (p6: NPR 5,000)
    const exp2Shares = calculateExpenseShares({
      amountPaisa: 500000,
      splitMethod: 'PER_FAMILY',
      participants: mockParticipants,
      families: mockFamilies,
      includedFamilyIds: ['f1', 'f2'],
    });

    const exp2: ExpenseRecord = {
      id: 'e2',
      tripId: 't1',
      title: 'Highway Fuel',
      category: 'FUEL',
      amountPaisa: 500000,
      isEstimated: false,
      isPackage: false,
      splitMethod: 'PER_FAMILY',
      paymentMethod: 'CASH',
      approvalStatus: 'APPROVED',
      incurredAt: new Date().toISOString(),
      createdByParticipantId: 'p6',
      isDeleted: false,
      payments: [{ participantId: 'p6', amountPaisa: 500000 }],
      shares: exp2Shares,
    };

    return [exp1, exp2];
  };

  it('satisfies all 8 financial invariants before and after partial/full settlements', () => {
    const expenses = buildTestLedger();

    // 1. Pre-settlement invariant check
    const initialCheck = verifyLedgerInvariants(mockParticipants, mockFamilies, expenses, []);
    expect(initialCheck.valid).toBe(true);
    expect(initialCheck.violations).toHaveLength(0);

    const initialLedger = calculateTripBalances(mockParticipants, mockFamilies, expenses, []);
    expect(initialLedger.totalApprovedExpensePaisa).toBe(2300000);
    expect(initialLedger.totalPackageExpensePaisa).toBe(1800000);
    expect(initialLedger.totalAdditionalExpensePaisa).toBe(500000);

    // Sharma family (f1): Paid 1,000,000. Shares: 3 * 300,000 (package) + 250,000 (fuel) = 1,150,000 -> Net: -150,000 (owes NPR 1,500)
    // Thapa family (f2): Paid 800,000. Shares: 2 * 300,000 (package) + 250,000 (fuel) = 850,000 -> Net: -50,000 (owes NPR 500)
    // Gaurav solo (p6): Paid 500,000. Shares: 1 * 300,000 (package) + 0 (fuel) = 300,000 -> Net: +200,000 (owed NPR 2,000)
    const sharmaBalance = initialLedger.familyBalances.find((f) => f.familyId === 'f1')!;
    const thapaBalance = initialLedger.familyBalances.find((f) => f.familyId === 'f2')!;
    const gauravBalance = initialLedger.ungroupedParticipantBalances.find(
      (u) => u.participantId === 'p6'
    )!;

    expect(sharmaBalance.outstandingBalancePaisa).toBe(-150000);
    expect(thapaBalance.outstandingBalancePaisa).toBe(-50000);
    expect(gauravBalance.outstandingBalancePaisa).toBe(200000);

    // 2. Partial Settlement: Sharma Family Rep (p1) pays Gaurav (p6) NPR 600 (60,000 paisa)
    // First test as REPORTED (unconfirmed) -> should NOT reduce confirmed outstanding balances yet
    const reportedSettlement: SettlementRecord = {
      id: 's1',
      tripId: 't1',
      settlementMode: 'FAMILY',
      fromParticipantId: 'p1',
      toParticipantId: 'p6',
      fromFamilyId: 'f1',
      toFamilyId: null,
      amountPaisa: 60000,
      paymentMethod: 'ESEWA',
      status: 'REPORTED',
      settledAt: new Date().toISOString(),
      reportedByParticipantId: 'p1',
    };

    const ledgerWithUnconfirmed = calculateTripBalances(
      mockParticipants,
      mockFamilies,
      expenses,
      [reportedSettlement]
    );
    expect(
      ledgerWithUnconfirmed.familyBalances.find((f) => f.familyId === 'f1')!
        .outstandingBalancePaisa
    ).toBe(-150000);

    // Now confirm the partial settlement
    const confirmedSettlement: SettlementRecord = {
      ...reportedSettlement,
      status: 'CONFIRMED',
      confirmedByParticipantId: 'p6',
    };

    const postPartialLedger = calculateTripBalances(mockParticipants, mockFamilies, expenses, [
      confirmedSettlement,
    ]);

    // Verify original expense total is completely untouched by the settlement
    expect(postPartialLedger.totalApprovedExpensePaisa).toBe(2300000);

    // Sharma family now owes NPR 900 (-90,000 paisa); Gaurav is now owed NPR 1,400 (+140,000 paisa)
    expect(
      postPartialLedger.familyBalances.find((f) => f.familyId === 'f1')!.outstandingBalancePaisa
    ).toBe(-90000);
    expect(
      postPartialLedger.ungroupedParticipantBalances.find((u) => u.participantId === 'p6')!
        .outstandingBalancePaisa
    ).toBe(140000);

    // Invariants still hold after partial settlement
    const postPartialCheck = verifyLedgerInvariants(mockParticipants, mockFamilies, expenses, [
      confirmedSettlement,
    ]);
    expect(postPartialCheck.valid).toBe(true);

    // Family settlement suggestions should now recommend:
    // Sharma (p1) -> Gaurav (p6): 90,000 paisa (NPR 900)
    // Thapa (p4) -> Gaurav (p6): 50,000 paisa (NPR 500)
    const familySuggestions = calculateFamilySettlements(
      postPartialLedger.familyBalances,
      postPartialLedger.ungroupedParticipantBalances
    );
    expect(familySuggestions).toHaveLength(2);
    expect(familySuggestions[0].amountPaisa).toBe(90000);
    expect(familySuggestions[1].amountPaisa).toBe(50000);

    // Individual settlement suggestions also sum to exact receivables
    const indivSuggestions = calculateIndividualSettlements(
      postPartialLedger.individualBalances
    );
    expect(indivSuggestions.reduce((acc, s) => acc + s.amountPaisa, 0)).toBe(
      postPartialLedger.individualBalances
        .filter((b) => b.outstandingBalancePaisa > 0)
        .reduce((acc, b) => acc + b.outstandingBalancePaisa, 0)
    );
  });

  it('recalculates balances accurately when an expense is edited', () => {
    const expenses = buildTestLedger();
    // Edit Expense 2 (Fuel) from NPR 5,000 to NPR 6,000 (600,000 paisa)
    const updatedShares = calculateExpenseShares({
      amountPaisa: 600000,
      splitMethod: 'PER_FAMILY',
      participants: mockParticipants,
      families: mockFamilies,
      includedFamilyIds: ['f1', 'f2'],
    });

    const editedExpenses: ExpenseRecord[] = [
      expenses[0],
      {
        ...expenses[1],
        amountPaisa: 600000,
        payments: [{ participantId: 'p6', amountPaisa: 600000 }],
        shares: updatedShares,
      },
    ];

    const check = verifyLedgerInvariants(mockParticipants, mockFamilies, editedExpenses, []);
    expect(check.valid).toBe(true);

    const updatedLedger = calculateTripBalances(
      mockParticipants,
      mockFamilies,
      editedExpenses,
      []
    );
    expect(updatedLedger.totalApprovedExpensePaisa).toBe(2400000);
    expect(
      updatedLedger.ungroupedParticipantBalances.find((u) => u.participantId === 'p6')!
        .outstandingBalancePaisa
    ).toBe(300000);
  });
});
