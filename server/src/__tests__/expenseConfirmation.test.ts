import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { verifyLedgerInvariants } from '@tripledger/shared';
import { ExpenseModel } from '../models/index.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_estimate_confirm';

interface Fixture {
  tripId: string;
  ids: { aarav: string; bina: string; dipesh: string; esha: string; farhan: string };
  famIds: { sharma: string; thapa: string; karki: string };
}

describe('Task 1: estimated expense confirmation (FIN-01 / FIN-02)', () => {
  const app = createApp();
  let token = '';
  let fx: Fixture;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function post(path: string, body: unknown) {
    return request(app).post(`/api/v1/trips/${fx.tripId}${path}`).set(auth()).send(body as object);
  }

  async function createEstimated(body: Record<string, unknown>) {
    const res = await post('/expenses', { isEstimated: true, ...body });
    expect(res.status).toBe(201);
    expect(res.body.data.expense.approvalStatus).toBe('PENDING_CONFIRMATION');
    return res.body.data.expense.id as string;
  }

  async function getTrip() {
    const res = await request(app).get(`/api/v1/trips/${fx.tripId}`).set(auth());
    expect(res.status).toBe(200);
    return res.body.data;
  }

  async function expectInvariants() {
    const t = await getTrip();
    const result = verifyLedgerInvariants(t.participants, t.families, t.expenses, t.settlements);
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
    for (const e of t.expenses as Array<{
      amountPaisa: number;
      payments: { amountPaisa: number }[];
      shares: { sharePaisa: number }[];
      isDeleted: boolean;
    }>) {
      expect(e.payments.reduce((a, p) => a + p.amountPaisa, 0)).toBe(e.amountPaisa);
      expect(e.shares.reduce((a, s) => a + s.sharePaisa, 0)).toBe(e.amountPaisa);
    }
    return t;
  }

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Aarav Sharma',
      email: 'aarav@example.com',
      password: 'Password123',
    });
    token = reg.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set(auth())
      .send({ name: 'Estimate Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
    const tripId = tripRes.body.data.trip.id as string;
    const sharma = tripRes.body.data.families[0].id as string;
    const aarav = tripRes.body.data.myParticipant.id as string;

    const addFam = async (name: string) =>
      (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set(auth())
          .send({ name })
      ).body.data.family.id as string;
    const addPerson = async (name: string, familyId: string) =>
      (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set(auth())
          .send({ name, familyId, role: 'PARTICIPANT', memberType: 'ADULT' })
      ).body.data.participant.id as string;

    const thapa = await addFam('Thapa Family');
    const karki = await addFam('Karki Family');
    const bina = await addPerson('Bina Sharma', sharma);
    const dipesh = await addPerson('Dipesh Thapa', thapa);
    const esha = await addPerson('Esha Thapa', thapa);
    const farhan = await addPerson('Farhan Karki', karki);

    fx = {
      tripId,
      ids: { aarav, bina, dipesh, esha, farhan },
      famIds: { sharma, thapa, karki },
    };
  });

  const byParticipant = (rows: { participantId: string; amountPaisa?: number; sharePaisa?: number }[]) =>
    Object.fromEntries(rows.map((r) => [r.participantId, r.amountPaisa ?? r.sharePaisa]));

  it('multi-payer EQUAL: payer contributions scale proportionally and reconcile to the paisa', async () => {
    const { aarav, bina, dipesh, esha } = fx.ids;
    const id = await createEstimated({
      title: 'Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'EQUAL',
      payments: [
        { participantId: aarav, amountPaisa: 60000 },
        { participantId: bina, amountPaisa: 40000 },
      ],
      includedParticipantIds: [aarav, bina, dipesh, esha],
    });

    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 100001,
    });
    expect(res.status).toBe(200);
    const e = res.body.data.expense;
    expect(e.amountPaisa).toBe(100001);
    expect(byParticipant(e.payments)).toEqual({ [aarav]: 60001, [bina]: 40000 });
    expect(e.shares.reduce((a: number, s: { sharePaisa: number }) => a + s.sharePaisa, 0)).toBe(100001);
    await expectInvariants();
  });

  it('multi-payer: explicit payer override is honoured; mismatching override is rejected with no mutation', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const id = await createEstimated({
      title: 'Taxi',
      category: 'TRANSPORTATION',
      amountPaisa: 50000,
      splitMethod: 'EQUAL',
      payments: [
        { participantId: aarav, amountPaisa: 30000 },
        { participantId: bina, amountPaisa: 20000 },
      ],
    });

    const bad = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 80000,
      payments: [{ participantId: aarav, amountPaisa: 79999 }],
    });
    expect(bad.status).toBe(400);
    let t = await getTrip();
    let e = t.expenses.find((x: { id: string }) => x.id === id);
    expect(e.amountPaisa).toBe(50000);
    expect(e.approvalStatus).toBe('PENDING_CONFIRMATION');
    expect(e.isEstimated).toBe(true);
    expect(byParticipant(e.payments)).toEqual({ [aarav]: 30000, [bina]: 20000 });

    const ok = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 80000,
      payments: [
        { participantId: aarav, amountPaisa: 10000 },
        { participantId: dipesh, amountPaisa: 70000 },
      ],
    });
    expect(ok.status).toBe(200);
    t = await expectInvariants();
    e = t.expenses.find((x: { id: string }) => x.id === id);
    expect(byParticipant(e.payments)).toEqual({ [aarav]: 10000, [dipesh]: 70000 });
  });

  it('rejects adjustment overrides when the amount does not change', async () => {
    const { aarav } = fx.ids;
    const id = await createEstimated({
      title: 'Misc',
      category: 'MISCELLANEOUS',
      amountPaisa: 1000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 1000 }],
    });
    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      payments: [{ participantId: aarav, amountPaisa: 1000 }],
    });
    expect(res.status).toBe(400);
  });

  it('CUSTOM: confirmation scales original custom shares and keeps the configuration', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const id = await createEstimated({
      title: 'Custom Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 400000,
      splitMethod: 'CUSTOM',
      payments: [
        { participantId: aarav, amountPaisa: 250000 },
        { participantId: bina, amountPaisa: 150000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 100000 },
        { participantId: bina, amountPaisa: 100000 },
        { participantId: dipesh, amountPaisa: 200000 },
      ],
    });
    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 800000,
    });
    expect(res.status).toBe(200);
    expect(byParticipant(res.body.data.expense.shares)).toEqual({
      [aarav]: 200000,
      [bina]: 200000,
      [dipesh]: 400000,
    });
    expect(byParticipant(res.body.data.expense.payments)).toEqual({
      [aarav]: 500000,
      [bina]: 300000,
    });
    await expectInvariants();
  });

  it('CUSTOM: explicit new custom shares are used and must sum to the actual amount', async () => {
    const { aarav, bina } = fx.ids;
    const id = await createEstimated({
      title: 'Custom 2',
      category: 'FOOD_DRINKS',
      amountPaisa: 1000,
      splitMethod: 'CUSTOM',
      payments: [{ participantId: aarav, amountPaisa: 1000 }],
      customShares: [
        { participantId: aarav, amountPaisa: 500 },
        { participantId: bina, amountPaisa: 500 },
      ],
    });
    const bad = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 2000,
      customShares: [
        { participantId: aarav, amountPaisa: 1000 },
        { participantId: bina, amountPaisa: 999 },
      ],
    });
    expect(bad.status).toBe(400);
    const ok = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 2000,
      customShares: [
        { participantId: aarav, amountPaisa: 1500 },
        { participantId: bina, amountPaisa: 500 },
      ],
    });
    expect(ok.status).toBe(200);
    expect(byParticipant(ok.body.data.expense.shares)).toEqual({ [aarav]: 1500, [bina]: 500 });
    await expectInvariants();
  });

  it('WEIGHTED: confirmation preserves per-expense weights', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const id = await createEstimated({
      title: 'Weighted Stay',
      category: 'ACCOMMODATION',
      amountPaisa: 400000,
      splitMethod: 'WEIGHTED',
      payments: [
        { participantId: aarav, amountPaisa: 100000 },
        { participantId: bina, amountPaisa: 300000 },
      ],
      includedParticipantIds: [aarav, bina, dipesh],
      weights: [
        { participantId: aarav, weight: 2 },
        { participantId: bina, weight: 1 },
        { participantId: dipesh, weight: 1 },
      ],
    });
    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 400001,
    });
    expect(res.status).toBe(200);
    const e = res.body.data.expense;
    const shares = byParticipant(e.shares) as Record<string, number>;
    // 2:1:1 split of 400001 — Aarav 200000.5 -> largest remainder.
    expect(shares[aarav]! + shares[bina]! + shares[dipesh]!).toBe(400001);
    expect(Math.abs(shares[aarav]! - 2 * shares[bina]!)).toBeLessThanOrEqual(2);
    expect(
      e.shares.find((s: { participantId: string }) => s.participantId === aarav).weightUsed
    ).toBe(2);
    const e2 = (await expectInvariants()).expenses.find((x: { id: string }) => x.id === id);
    expect(e2.payments.reduce((a: number, p: { amountPaisa: number }) => a + p.amountPaisa, 0)).toBe(400001);
  });

  it('PER_FAMILY: confirmation preserves included families and family weights', async () => {
    const { aarav, bina, dipesh, esha, farhan } = fx.ids;
    const { sharma, thapa, karki } = fx.famIds;
    const id = await createEstimated({
      title: 'Family Meal',
      category: 'FOOD_DRINKS',
      amountPaisa: 400000,
      splitMethod: 'PER_FAMILY',
      payments: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: dipesh, amountPaisa: 200000 },
      ],
      includedParticipantIds: [aarav, bina, dipesh, esha, farhan],
      includedFamilyIds: [sharma, thapa],
      familyWeights: [
        { familyId: sharma, weight: 1 },
        { familyId: thapa, weight: 3 },
      ],
    });
    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 800000,
    });
    expect(res.status).toBe(200);
    const shares = res.body.data.expense.shares as { participantId: string; familyId: string; sharePaisa: number }[];
    const famTotal = (f: string) =>
      shares.filter((s) => s.familyId === f).reduce((a, s) => a + s.sharePaisa, 0);
    expect(famTotal(sharma)).toBe(200000);
    expect(famTotal(thapa)).toBe(600000);
    expect(famTotal(karki)).toBe(0);
    expect(shares.some((s) => s.participantId === farhan)).toBe(false);
    await expectInvariants();
  });

  it('PACKAGE: confirmation updates rate/headcount; non-divisible totals are rejected; explicit rate accepted', async () => {
    const { aarav, bina, dipesh, esha } = fx.ids;
    const id = await createEstimated({
      title: 'Resort Package',
      category: 'PACKAGE',
      amountPaisa: 1200000,
      isPackage: true,
      packageRatePerPersonPaisa: 300000,
      splitMethod: 'PACKAGE',
      payments: [
        { participantId: aarav, amountPaisa: 800000 },
        { participantId: dipesh, amountPaisa: 400000 },
      ],
      includedParticipantIds: [aarav, bina, dipesh, esha],
    });

    const bad = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 1300001,
    });
    expect(bad.status).toBe(400);
    let e = (await getTrip()).expenses.find((x: { id: string }) => x.id === id);
    expect(e.amountPaisa).toBe(1200000);
    expect(e.approvalStatus).toBe('PENDING_CONFIRMATION');

    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 1600000,
    });
    expect(res.status).toBe(200);
    e = res.body.data.expense;
    expect(e.isPackage).toBe(true);
    expect(e.packageConfig).toEqual({ ratePerUnitPaisa: 400000, unitCount: 4 });
    expect(e.shares.every((s: { sharePaisa: number }) => s.sharePaisa === 400000)).toBe(true);
    expect(byParticipant(e.payments)).toEqual({ [aarav]: 1066667, [dipesh]: 533333 });
    await expectInvariants();
  });

  it('legacy PER_FAMILY expense without persisted splitConfig is still confirmed correctly (single payer)', async () => {
    const { aarav, bina, dipesh, esha, farhan } = fx.ids;
    const { sharma, thapa } = fx.famIds;
    const id = await createEstimated({
      title: 'Legacy Meal',
      category: 'FOOD_DRINKS',
      amountPaisa: 400000,
      splitMethod: 'PER_FAMILY',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      includedParticipantIds: [aarav, bina, dipesh, esha, farhan],
      includedFamilyIds: [sharma, thapa],
    });
    // Simulate a pre-migration document that has no splitConfig field.
    await ExpenseModel.updateOne({ _id: id }, { $unset: { splitConfig: 1 } });

    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 600000,
    });
    expect(res.status).toBe(200);
    const e = res.body.data.expense;
    expect(byParticipant(e.payments)).toEqual({ [aarav]: 600000 });
    expect(e.shares.some((s: { participantId: string }) => s.participantId === farhan)).toBe(false);
    expect(e.shares.reduce((a: number, s: { sharePaisa: number }) => a + s.sharePaisa, 0)).toBe(600000);
    await expectInvariants();
  });

  it('rejecting an estimated expense ignores actualAmountPaisa and never touches the ledger', async () => {
    const { aarav } = fx.ids;
    const id = await createEstimated({
      title: 'Maybe',
      category: 'MISCELLANEOUS',
      amountPaisa: 5000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 5000 }],
    });
    const res = await post(`/expenses/${id}/approve`, {
      approvalStatus: 'REJECTED',
      actualAmountPaisa: 9999,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.expense.amountPaisa).toBe(5000);
    expect(res.body.data.expense.approvalStatus).toBe('REJECTED');
    await expectInvariants();
  });
});
