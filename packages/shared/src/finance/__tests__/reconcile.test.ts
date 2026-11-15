import { describe, expect, it } from 'vitest';
import { planExpenseEdit, rescaleExpense } from '../reconcile.js';
import { calculateExpenseShares } from '../splitting.js';
import type { ExpenseRecord, FamilyEntity, ParticipantEntity } from '../../types/index.js';

const mk = (id: string, familyId: string | null = null, w = 1): ParticipantEntity => ({
  id,
  tripId: 't',
  userId: null,
  familyId,
  name: id,
  role: 'PARTICIPANT',
  memberType: 'ADULT',
  defaultWeight: w,
  isActive: true,
});

const participants = [mk('a', 'F1'), mk('b', 'F1'), mk('c', 'F2'), mk('d', 'F2'), mk('e', 'F3')];
const families: FamilyEntity[] = [
  { id: 'F1', tripId: 't', name: 'One', representativeId: 'a', defaultWeight: 1 },
  { id: 'F2', tripId: 't', name: 'Two', representativeId: 'c', defaultWeight: 1 },
  { id: 'F3', tripId: 't', name: 'Three', representativeId: 'e', defaultWeight: 1 },
];

const sum = (xs: { amountPaisa?: number; sharePaisa?: number }[]) =>
  xs.reduce((a, x) => a + (x.amountPaisa ?? x.sharePaisa ?? 0), 0);

function build(
  amountPaisa: number,
  splitMethod: ExpenseRecord['splitMethod'],
  payments: ExpenseRecord['payments'],
  extra: Partial<Parameters<typeof calculateExpenseShares>[0]>,
  splitConfig?: ExpenseRecord['splitConfig']
) {
  const shares = calculateExpenseShares({
    amountPaisa,
    splitMethod,
    participants,
    families,
    ...(extra as object),
  });
  return { amountPaisa, splitMethod, payments, shares, splitConfig, packageConfig: undefined };
}

describe('rescaleExpense', () => {
  it('scales multiple payers proportionally with exact paisa and no payer favouritism', () => {
    const exp = build(
      100000,
      'EQUAL',
      [
        { participantId: 'a', amountPaisa: 60000 },
        { participantId: 'b', amountPaisa: 40000 },
      ],
      { includedParticipantIds: ['a', 'b', 'c', 'd'] }
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 100001, participants, families });
    expect(r.payments.map((p) => p.amountPaisa)).toEqual([60001, 40000]);
    expect(sum(r.payments)).toBe(100001);
    expect(sum(r.shares)).toBe(100001);
  });

  it('keeps three payers exact when scaling down', () => {
    const exp = build(
      10000,
      'EQUAL',
      [
        { participantId: 'a', amountPaisa: 3333 },
        { participantId: 'b', amountPaisa: 3333 },
        { participantId: 'c', amountPaisa: 3334 },
      ],
      {}
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 7777, participants, families });
    expect(sum(r.payments)).toBe(7777);
    expect(sum(r.shares)).toBe(7777);
  });

  it('uses and validates explicit payer override', () => {
    const exp = build(
      1000,
      'EQUAL',
      [
        { participantId: 'a', amountPaisa: 600 },
        { participantId: 'b', amountPaisa: 400 },
      ],
      {}
    );
    const ok = rescaleExpense({
      expense: exp,
      newAmountPaisa: 2000,
      participants,
      families,
      overridePayments: [
        { participantId: 'a', amountPaisa: 500 },
        { participantId: 'c', amountPaisa: 1500 },
      ],
    });
    expect(ok.payments.map((p) => p.amountPaisa)).toEqual([500, 1500]);
    expect(() =>
      rescaleExpense({
        expense: exp,
        newAmountPaisa: 2000,
        participants,
        families,
        overridePayments: [{ participantId: 'a', amountPaisa: 1999 }],
      })
    ).toThrow(/must equal expense amount/);
    expect(() =>
      rescaleExpense({
        expense: exp,
        newAmountPaisa: 2000,
        participants,
        families,
        overridePayments: [{ participantId: 'zzz', amountPaisa: 2000 }],
      })
    ).toThrow(/does not belong/);
  });

  it('CUSTOM: scales original custom shares proportionally', () => {
    const exp = build(
      400000,
      'CUSTOM',
      [{ participantId: 'a', amountPaisa: 400000 }],
      {
        customShares: [
          { participantId: 'a', amountPaisa: 100000 },
          { participantId: 'b', amountPaisa: 100000 },
          { participantId: 'c', amountPaisa: 200000 },
        ],
      }
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 800000, participants, families });
    const byId = Object.fromEntries(r.shares.map((s) => [s.participantId, s.sharePaisa]));
    expect(byId).toEqual({ a: 200000, b: 200000, c: 400000 });
  });

  it('CUSTOM: scaled shares stay exact on awkward totals and honour explicit overrides', () => {
    const exp = build(
      300,
      'CUSTOM',
      [{ participantId: 'a', amountPaisa: 300 }],
      {
        customShares: [
          { participantId: 'a', amountPaisa: 100 },
          { participantId: 'b', amountPaisa: 100 },
          { participantId: 'c', amountPaisa: 100 },
        ],
      }
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 301, participants, families });
    expect(sum(r.shares)).toBe(301);
    const o = rescaleExpense({
      expense: exp,
      newAmountPaisa: 500,
      participants,
      families,
      overrideCustomShares: [
        { participantId: 'a', amountPaisa: 450 },
        { participantId: 'b', amountPaisa: 50 },
      ],
    });
    expect(o.shares.map((s) => s.sharePaisa)).toEqual([450, 50]);
  });

  it('WEIGHTED: preserves per-expense weights (not defaults)', () => {
    const exp = build(
      400000,
      'WEIGHTED',
      [{ participantId: 'a', amountPaisa: 400000 }],
      {
        includedParticipantIds: ['a', 'b', 'c'],
        weights: [
          { participantId: 'a', weight: 2 },
          { participantId: 'b', weight: 1 },
          { participantId: 'c', weight: 1 },
        ],
      }
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 800000, participants, families });
    const byId = Object.fromEntries(r.shares.map((s) => [s.participantId, s.sharePaisa]));
    expect(byId).toEqual({ a: 400000, b: 200000, c: 200000 });
    expect(r.shares.find((s) => s.participantId === 'a')?.weightUsed).toBe(2);
  });

  it('PER_FAMILY: preserves included families and family weights, excludes others', () => {
    const cfg = {
      includedFamilyIds: ['F1', 'F2'],
      familyWeights: [
        { familyId: 'F1', weight: 1 },
        { familyId: 'F2', weight: 3 },
      ],
    };
    const exp = build(
      400000,
      'PER_FAMILY',
      [{ participantId: 'a', amountPaisa: 400000 }],
      { includedFamilyIds: cfg.includedFamilyIds, familyWeights: cfg.familyWeights },
      cfg
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 800000, participants, families });
    const famTotal = (fid: string) =>
      r.shares.filter((s) => s.familyId === fid).reduce((a, s) => a + s.sharePaisa, 0);
    expect(famTotal('F1')).toBe(200000);
    expect(famTotal('F2')).toBe(600000);
    expect(r.shares.some((s) => s.participantId === 'e')).toBe(false);
  });

  it('PER_FAMILY legacy (no persisted config) derives families from shares', () => {
    const exp = build(
      300000,
      'PER_FAMILY',
      [{ participantId: 'a', amountPaisa: 300000 }],
      { includedFamilyIds: ['F1', 'F2'] }
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 600000, participants, families });
    expect(r.shares.some((s) => s.participantId === 'e')).toBe(false);
    expect(sum(r.shares)).toBe(600000);
  });

  it('PACKAGE: re-derives rate and unit count; rejects non-integer rate; accepts explicit rate', () => {
    const exp = build(
      1200000,
      'PACKAGE',
      [{ participantId: 'a', amountPaisa: 1200000 }],
      {
        includedParticipantIds: ['a', 'b', 'c', 'd'],
        packageRatePerPersonPaisa: 300000,
      }
    );
    const r = rescaleExpense({ expense: exp, newAmountPaisa: 1600000, participants, families });
    expect(r.packageConfig).toEqual({ ratePerUnitPaisa: 400000, unitCount: 4 });
    expect(r.shares.every((s) => s.sharePaisa === 400000)).toBe(true);
    expect(() =>
      rescaleExpense({ expense: exp, newAmountPaisa: 1300001, participants, families })
    ).toThrow(/not divisible/);
    const e = rescaleExpense({
      expense: exp,
      newAmountPaisa: 1300000,
      participants,
      families,
      overridePackageRatePerPersonPaisa: 325000,
    });
    expect(e.packageConfig?.ratePerUnitPaisa).toBe(325000);
    expect(() =>
      rescaleExpense({
        expense: exp,
        newAmountPaisa: 1300000,
        participants,
        families,
        overridePackageRatePerPersonPaisa: 300000,
      })
    ).toThrow(/Package total/);
  });

  it('rejects overrides that do not apply to the split method', () => {
    const exp = build(1000, 'EQUAL', [{ participantId: 'a', amountPaisa: 1000 }], {});
    expect(() =>
      rescaleExpense({
        expense: exp,
        newAmountPaisa: 2000,
        participants,
        families,
        overrideCustomShares: [{ participantId: 'a', amountPaisa: 2000 }],
      })
    ).toThrow(/only valid for CUSTOM/);
  });
});

describe('planExpenseEdit', () => {
  it('metadata-only edit on CUSTOM or WEIGHTED returns null payments and null shares (no recalculation)', () => {
    const customExp = build(
      500000,
      'CUSTOM',
      [{ participantId: 'a', amountPaisa: 500000 }],
      {
        customShares: [
          { participantId: 'a', amountPaisa: 150000 },
          { participantId: 'b', amountPaisa: 350000 },
        ],
      }
    );
    const planCustom = planExpenseEdit({
      expense: customExp,
      patch: {},
      participants,
      families,
    });
    expect(planCustom.payments).toBeNull();
    expect(planCustom.shares).toBeNull();
    expect(planCustom.amountPaisa).toBe(500000);
    expect(planCustom.splitMethod).toBe('CUSTOM');

    const weightedExp = build(
      400000,
      'WEIGHTED',
      [{ participantId: 'a', amountPaisa: 400000 }],
      {
        includedParticipantIds: ['a', 'b', 'c'],
        weights: [
          { participantId: 'a', weight: 2 },
          { participantId: 'b', weight: 1 },
          { participantId: 'c', weight: 1 },
        ],
      }
    );
    const planWeighted = planExpenseEdit({
      expense: weightedExp,
      patch: { amountPaisa: 400000, splitMethod: 'WEIGHTED' },
      participants,
      families,
    });
    expect(planWeighted.payments).toBeNull();
    expect(planWeighted.shares).toBeNull();
  });

  it('payments-only edit replaces payments and leaves shares untouched', () => {
    const exp = build(
      400000,
      'CUSTOM',
      [{ participantId: 'a', amountPaisa: 400000 }],
      {
        customShares: [
          { participantId: 'a', amountPaisa: 100000 },
          { participantId: 'b', amountPaisa: 300000 },
        ],
      }
    );
    const plan = planExpenseEdit({
      expense: exp,
      patch: {
        payments: [
          { participantId: 'a', amountPaisa: 250000 },
          { participantId: 'b', amountPaisa: 150000 },
        ],
      },
      participants,
      families,
    });
    expect(plan.shares).toBeNull();
    expect(plan.payments?.map((p) => p.amountPaisa)).toEqual([250000, 150000]);
  });

  it('amount-only edit on WEIGHTED and CUSTOM scales shares and multi-payer payments', () => {
    const weightedExp = build(
      400000,
      'WEIGHTED',
      [
        { participantId: 'a', amountPaisa: 300000 },
        { participantId: 'b', amountPaisa: 100000 },
      ],
      {
        includedParticipantIds: ['a', 'b', 'c'],
        weights: [
          { participantId: 'a', weight: 2 },
          { participantId: 'b', weight: 1 },
          { participantId: 'c', weight: 1 },
        ],
      }
    );
    const plan = planExpenseEdit({
      expense: weightedExp,
      patch: { amountPaisa: 800000 },
      participants,
      families,
    });
    expect(plan.payments?.map((p) => p.amountPaisa)).toEqual([600000, 200000]);
    expect(Object.fromEntries((plan.shares ?? []).map((s) => [s.participantId, s.sharePaisa]))).toEqual({
      a: 400000,
      b: 200000,
      c: 200000,
    });
  });

  it('PER_FAMILY edit maintains splitConfig and includes members of newly added families', () => {
    const cfg = {
      includedFamilyIds: ['F1', 'F2'],
      familyWeights: [
        { familyId: 'F1', weight: 1 },
        { familyId: 'F2', weight: 1 },
      ],
    };
    const exp = build(
      400000,
      'PER_FAMILY',
      [{ participantId: 'a', amountPaisa: 400000 }],
      { includedFamilyIds: cfg.includedFamilyIds, familyWeights: cfg.familyWeights },
      cfg
    );

    const plan = planExpenseEdit({
      expense: exp,
      patch: {
        includedFamilyIds: ['F1', 'F2', 'F3'],
        familyWeights: [
          { familyId: 'F1', weight: 1 },
          { familyId: 'F2', weight: 1 },
          { familyId: 'F3', weight: 2 },
        ],
      },
      participants,
      families,
    });
    expect(plan.splitConfig).toEqual({
      includedFamilyIds: ['F1', 'F2', 'F3'],
      familyWeights: [
        { familyId: 'F1', weight: 1 },
        { familyId: 'F2', weight: 1 },
        { familyId: 'F3', weight: 2 },
      ],
    });
    expect(plan.shares?.find((s) => s.participantId === 'e')?.sharePaisa).toBe(200000);
    expect(sum(plan.shares ?? [])).toBe(400000);
  });

  it('clears splitConfig and packageConfig when switching away from PER_FAMILY or PACKAGE', () => {
    const pkgExp = {
      ...build(
        900000,
        'PACKAGE',
        [{ participantId: 'a', amountPaisa: 900000 }],
        { includedParticipantIds: ['a', 'b', 'c'], packageRatePerPersonPaisa: 300000 }
      ),
      packageConfig: { ratePerUnitPaisa: 300000, unitCount: 3 },
    };
    const plan = planExpenseEdit({
      expense: pkgExp,
      patch: { splitMethod: 'EQUAL' },
      participants,
      families,
    });
    expect(plan.packageConfig).toBeNull();
    expect(plan.shares?.every((s) => s.sharePaisa === 300000)).toBe(true);
  });

  it('rejects changing includedParticipantIds on CUSTOM without explicit customShares', () => {
    const customExp = build(
      300000,
      'CUSTOM',
      [{ participantId: 'a', amountPaisa: 300000 }],
      {
        customShares: [
          { participantId: 'a', amountPaisa: 100000 },
          { participantId: 'b', amountPaisa: 200000 },
        ],
      }
    );
    expect(() =>
      planExpenseEdit({
        expense: customExp,
        patch: { includedParticipantIds: ['a', 'b', 'c'] },
        participants,
        families,
      })
    ).toThrow(/requires explicit customShares/);
  });
});
