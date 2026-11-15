import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { verifyLedgerInvariants } from '@tripledger/shared';
import {
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
} from '../models/index.js';
import { supportsTransactions } from '../services/atomicWrite.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_expense_editing';

interface Fixture {
  tripId: string;
  otherTripId: string;
  otherTripParticipantId: string;
  otherTripFamilyId: string;
  ids: { aarav: string; bina: string; dipesh: string; esha: string; farhan: string };
  famIds: { sharma: string; thapa: string; karki: string };
}

describe('Task 2: expense editing & atomic persistence (FIN-03 / DB-01)', () => {
  const app = createApp();
  let token = '';
  let fx: Fixture;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function post(path: string, body: unknown) {
    return request(app).post(`/api/v1/trips/${fx.tripId}${path}`).set(auth()).send(body as object);
  }

  async function patch(path: string, body: unknown) {
    return request(app).patch(`/api/v1/trips/${fx.tripId}${path}`).set(auth()).send(body as object);
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
    }>) {
      expect(e.payments.reduce((a, p) => a + p.amountPaisa, 0)).toBe(e.amountPaisa);
      expect(e.shares.reduce((a, s) => a + s.sharePaisa, 0)).toBe(e.amountPaisa);
    }
    return t;
  }

  const byParticipant = (
    rows: { participantId: string; amountPaisa?: number; sharePaisa?: number }[]
  ) => Object.fromEntries(rows.map((r) => [r.participantId, r.amountPaisa ?? r.sharePaisa]));

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    delete process.env.MONGO_TRANSACTIONS;
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
      .send({ name: 'Pokhara Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
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

    // Create a second isolated trip to test cross-trip ID rejection
    const otherTripRes = await request(app)
      .post('/api/v1/trips')
      .set(auth())
      .send({ name: 'Chitwan Trip', mode: 'FAMILY', organizerFamilyName: 'Foreign Family' });
    const otherTripId = otherTripRes.body.data.trip.id as string;
    const otherTripParticipantId = otherTripRes.body.data.myParticipant.id as string;
    const otherTripFamilyId = otherTripRes.body.data.families[0].id as string;

    fx = {
      tripId,
      otherTripId,
      otherTripParticipantId,
      otherTripFamilyId,
      ids: { aarav, bina, dipesh, esha, farhan },
      famIds: { sharma, thapa, karki },
    };
  });

  it('6. Metadata-only editing of a CUSTOM expense preserves exact shares and database row IDs', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Initial Custom Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 450000,
      splitMethod: 'CUSTOM',
      payments: [
        { participantId: aarav, amountPaisa: 300000 },
        { participantId: bina, amountPaisa: 150000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 100000 },
        { participantId: bina, amountPaisa: 150000 },
        { participantId: dipesh, amountPaisa: 200000 },
      ],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    const sharesBefore = await ExpenseShareModel.find({ expenseId }).lean();
    const paymentsBefore = await ExpensePaymentModel.find({ expenseId }).lean();

    const editRes = await patch(`/expenses/${expenseId}`, {
      title: 'Updated Lakeside Dinner',
      description: 'Added tip note',
      category: 'ACTIVITIES',
    });
    expect(editRes.status).toBe(200);
    expect(editRes.body.data.expense.title).toBe('Updated Lakeside Dinner');
    expect(editRes.body.data.expense.description).toBe('Added tip note');
    expect(editRes.body.data.expense.category).toBe('ACTIVITIES');
    expect(byParticipant(editRes.body.data.expense.shares)).toEqual({
      [aarav]: 100000,
      [bina]: 150000,
      [dipesh]: 200000,
    });
    expect(byParticipant(editRes.body.data.expense.payments)).toEqual({
      [aarav]: 300000,
      [bina]: 150000,
    });

    // Verify existing share and payment documents were NOT deleted and re-inserted
    const sharesAfter = await ExpenseShareModel.find({ expenseId }).lean();
    const paymentsAfter = await ExpensePaymentModel.find({ expenseId }).lean();
    expect(sharesAfter.map((s) => s._id.toString()).sort()).toEqual(
      sharesBefore.map((s) => s._id.toString()).sort()
    );
    expect(paymentsAfter.map((p) => p._id.toString()).sort()).toEqual(
      paymentsBefore.map((p) => p._id.toString()).sort()
    );

    await expectInvariants();
  });

  it('7. Metadata-only editing of a WEIGHTED expense preserves custom per-expense weights', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Weighted Jeep Hire',
      category: 'TRANSPORTATION',
      amountPaisa: 400000,
      splitMethod: 'WEIGHTED',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      includedParticipantIds: [aarav, bina, dipesh],
      weights: [
        { participantId: aarav, weight: 2 },
        { participantId: bina, weight: 1 },
        { participantId: dipesh, weight: 1 },
      ],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    const editRes = await patch(`/expenses/${expenseId}`, {
      title: 'Weighted 4x4 Jeep Hire',
      description: 'Updated vendor name',
    });
    expect(editRes.status).toBe(200);
    expect(byParticipant(editRes.body.data.expense.shares)).toEqual({
      [aarav]: 200000,
      [bina]: 100000,
      [dipesh]: 100000,
    });
    const aaravShare = editRes.body.data.expense.shares.find(
      (s: { participantId: string }) => s.participantId === aarav
    );
    expect(aaravShare.weightUsed).toBe(2);

    // Also test editing amountPaisa on the WEIGHTED expense without re-sending weights:
    // custom weightUsed (2:1:1) must still be preserved!
    const amountEditRes = await patch(`/expenses/${expenseId}`, {
      amountPaisa: 800000,
    });
    expect(amountEditRes.status).toBe(200);
    expect(byParticipant(amountEditRes.body.data.expense.shares)).toEqual({
      [aarav]: 400000,
      [bina]: 200000,
      [dipesh]: 200000,
    });

    await expectInvariants();
  });

  it('maintains splitConfig when editing PER_FAMILY expenses and uses updated config on subsequent confirmation', async () => {
    const { aarav, bina, dipesh, esha, farhan } = fx.ids;
    const { sharma, thapa, karki } = fx.famIds;

    // Start with estimated PER_FAMILY expense across Sharma and Thapa only
    const createRes = await post('/expenses', {
      title: 'Boating & Snacks',
      category: 'ACTIVITIES',
      amountPaisa: 400000,
      isEstimated: true,
      splitMethod: 'PER_FAMILY',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      includedParticipantIds: [aarav, bina, dipesh, esha],
      includedFamilyIds: [sharma, thapa],
      familyWeights: [
        { familyId: sharma, weight: 1 },
        { familyId: thapa, weight: 1 },
      ],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    // Metadata edit preserves splitConfig
    const metaEdit = await patch(`/expenses/${expenseId}`, {
      title: 'Phewa Lake Boating',
    });
    expect(metaEdit.status).toBe(200);
    expect(metaEdit.body.data.expense.splitConfig).toEqual({
      includedFamilyIds: [sharma, thapa],
      familyWeights: [
        { familyId: sharma, weight: 1 },
        { familyId: thapa, weight: 1 },
      ],
    });

    // Now edit PER_FAMILY to include Karki Family with weights 1:1:2
    const famEdit = await patch(`/expenses/${expenseId}`, {
      includedFamilyIds: [sharma, thapa, karki],
      familyWeights: [
        { familyId: sharma, weight: 1 },
        { familyId: thapa, weight: 1 },
        { familyId: karki, weight: 2 },
      ],
    });
    expect(famEdit.status).toBe(200);
    expect(famEdit.body.data.expense.splitConfig).toEqual({
      includedFamilyIds: [sharma, thapa, karki],
      familyWeights: [
        { familyId: sharma, weight: 1 },
        { familyId: thapa, weight: 1 },
        { familyId: karki, weight: 2 },
      ],
    });
    expect(
      famEdit.body.data.expense.shares.find(
        (s: { participantId: string }) => s.participantId === farhan
      )?.sharePaisa
    ).toBe(200000);

    // Confirm the estimated expense with a new actual amount (800,000 paisa) -> must use the updated splitConfig!
    const confirmRes = await post(`/expenses/${expenseId}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 800000,
    });
    expect(confirmRes.status).toBe(200);
    expect(
      confirmRes.body.data.expense.shares.find(
        (s: { participantId: string }) => s.participantId === farhan
      )?.sharePaisa
    ).toBe(400000);

    await expectInvariants();
  });

  it('9. Rejects invalid, inactive, or cross-trip participant and family IDs safely before any DB mutation', async () => {
    const { aarav, bina, farhan } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Hotel Deposit',
      category: 'ACCOMMODATION',
      amountPaisa: 300000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 300000 }],
      includedParticipantIds: [aarav, bina],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    // Deactivate farhan
    await patch(`/participants/${farhan}`, { isActive: false });

    // 9a. Malformed non-ObjectId in payments
    const badPaymentId = await patch(`/expenses/${expenseId}`, {
      payments: [{ participantId: 'not-a-valid-object-id', amountPaisa: 300000 }],
    });
    expect(badPaymentId.status).toBe(400);

    // 9b. Malformed non-ObjectId in includedParticipantIds
    const badIncludedId = await patch(`/expenses/${expenseId}`, {
      includedParticipantIds: [aarav, 'invalid-hex'],
    });
    expect(badIncludedId.status).toBe(400);

    // 9c. Deactivated participant in payments or split
    const inactiveParticipantRes = await patch(`/expenses/${expenseId}`, {
      includedParticipantIds: [aarav, farhan],
    });
    expect(inactiveParticipantRes.status).toBe(400);

    // 9d. Cross-trip participant ID
    const foreignParticipantRes = await patch(`/expenses/${expenseId}`, {
      payments: [{ participantId: fx.otherTripParticipantId, amountPaisa: 300000 }],
    });
    expect(foreignParticipantRes.status).toBe(400);

    // 9e. Cross-trip family ID
    const foreignFamilyRes = await patch(`/expenses/${expenseId}`, {
      splitMethod: 'PER_FAMILY',
      includedFamilyIds: [fx.otherTripFamilyId],
    });
    expect(foreignFamilyRes.status).toBe(400);

    // Verify the original expense, payments, and shares are completely untouched in MongoDB
    const paymentsInDb = await ExpensePaymentModel.find({ expenseId }).lean();
    const sharesInDb = await ExpenseShareModel.find({ expenseId }).lean();
    expect(paymentsInDb).toHaveLength(1);
    expect(paymentsInDb[0]!.amountPaisa).toBe(300000);
    expect(sharesInDb).toHaveLength(2);
    expect(sharesInDb.reduce((a, s) => a + s.sharePaisa, 0)).toBe(300000);

    await expectInvariants();
  });

  it('8. Failed mid-update persistence rolls back and preserves existing payments, shares, and expense state', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Cable Car Tickets',
      category: 'ENTRY_FEES',
      amountPaisa: 200000,
      splitMethod: 'CUSTOM',
      payments: [
        { participantId: aarav, amountPaisa: 120000 },
        { participantId: bina, amountPaisa: 80000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 80000 },
        { participantId: bina, amountPaisa: 120000 },
      ],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    // Simulate a database failure when inserting the new shares (after new payments were already inserted & old payments deleted)
    const spy = vi
      .spyOn(ExpenseShareModel, 'insertMany')
      .mockRejectedValueOnce(new Error('Simulated mid-write share insertion failure'));

    const failedEdit = await patch(`/expenses/${expenseId}`, {
      title: 'Corrupted Cable Car Edit',
      amountPaisa: 500000,
      payments: [
        { participantId: aarav, amountPaisa: 250000 },
        { participantId: dipesh, amountPaisa: 250000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: bina, amountPaisa: 150000 },
        { participantId: dipesh, amountPaisa: 150000 },
      ],
    });
    expect(failedEdit.status).toBeGreaterThanOrEqual(400);
    expect(spy).toHaveBeenCalledTimes(1);

    // Verify original expense, payments, and shares were restored intact
    const expDoc = await ExpenseModel.findById(expenseId).lean();
    expect(expDoc?.title).toBe('Cable Car Tickets');
    expect(expDoc?.amountPaisa).toBe(200000);

    const paymentsAfter = await ExpensePaymentModel.find({ expenseId }).lean();
    const sharesAfter = await ExpenseShareModel.find({ expenseId }).lean();
    expect(paymentsAfter).toHaveLength(2);
    expect(
      Object.fromEntries(paymentsAfter.map((p) => [p.participantId.toString(), p.amountPaisa]))
    ).toEqual({
      [aarav]: 120000,
      [bina]: 80000,
    });
    expect(sharesAfter).toHaveLength(2);
    expect(
      Object.fromEntries(sharesAfter.map((s) => [s.participantId.toString(), s.sharePaisa]))
    ).toEqual({
      [aarav]: 80000,
      [bina]: 120000,
    });

    await expectInvariants();
  });

  it('refuses multi-collection financial edits with 503 when MONGO_TRANSACTIONS=required on standalone MongoDB', async () => {
    const { aarav, bina } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Strict Atomic Test',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      includedParticipantIds: [aarav, bina],
    });
    const expenseId = createRes.body.data.expense.id as string;

    process.env.MONGO_TRANSACTIONS = 'required';
    const res = await patch(`/expenses/${expenseId}`, {
      amountPaisa: 200000,
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');

    delete process.env.MONGO_TRANSACTIONS;
    const t = await expectInvariants();
    const exp = t.expenses.find((e: { id: string }) => e.id === expenseId);
    expect(exp.amountPaisa).toBe(100000);
  });

  it('preserves and backfills legacy PER_FAMILY expenses lacking splitConfig during metadata and amount edits', async () => {
    const { aarav, bina, dipesh, esha, farhan } = fx.ids;
    const { sharma, thapa } = fx.famIds;

    // Create a PER_FAMILY expense across Sharma and Thapa only (Karki / Farhan excluded)
    const createRes = await post('/expenses', {
      title: 'Legacy Family Lunch',
      category: 'FOOD_DRINKS',
      amountPaisa: 400000,
      splitMethod: 'PER_FAMILY',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      includedParticipantIds: [aarav, bina, dipesh, esha],
      includedFamilyIds: [sharma, thapa],
      familyWeights: [
        { familyId: sharma, weight: 1 },
        { familyId: thapa, weight: 1 },
      ],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    // Simulate a legacy pre-Task-1 PER_FAMILY document that has no splitConfig stored
    await ExpenseModel.updateOne({ _id: expenseId }, { $unset: { splitConfig: 1 } });

    // 1. Metadata-only edit on legacy PER_FAMILY expense keeps exact shares
    const metaRes = await patch(`/expenses/${expenseId}`, {
      title: 'Legacy Family Lunch (Renamed)',
    });
    expect(metaRes.status).toBe(200);
    expect(byParticipant(metaRes.body.data.expense.shares)).toEqual({
      [aarav]: 100000,
      [bina]: 100000,
      [dipesh]: 100000,
      [esha]: 100000,
    });

    // 2. Amount-only edit on legacy PER_FAMILY expense infers Sharma+Thapa from shares,
    // excludes Karki (Farhan), and backfills splitConfig on the Expense document
    const amountRes = await patch(`/expenses/${expenseId}`, {
      amountPaisa: 800000,
    });
    expect(amountRes.status).toBe(200);
    expect(byParticipant(amountRes.body.data.expense.shares)).toEqual({
      [aarav]: 200000,
      [bina]: 200000,
      [dipesh]: 200000,
      [esha]: 200000,
    });
    expect(
      amountRes.body.data.expense.shares.find(
        (s: { participantId: string }) => s.participantId === farhan
      )
    ).toBeUndefined();
    expect(amountRes.body.data.expense.splitConfig?.includedFamilyIds.sort()).toEqual(
      [sharma, thapa].sort()
    );

    await expectInvariants();
  });

  it('rolls back partial writes when deletion fails after insertion and Expense update, and enforces production fail-closed & optimistic concurrency', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Paragliding Deposit',
      category: 'ACTIVITIES',
      amountPaisa: 300000,
      splitMethod: 'CUSTOM',
      payments: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: bina, amountPaisa: 100000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 150000 },
        { participantId: bina, amountPaisa: 150000 },
      ],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    // A: Simulate failure at Step 4 (ExpenseShareModel.deleteMany) AFTER:
    // - new payments were inserted,
    // - new shares were inserted,
    // - Expense document was updated (and __v incremented),
    // - old payments were ALREADY deleted!
    const deleteShareSpy = vi
      .spyOn(ExpenseShareModel, 'deleteMany')
      .mockRejectedValueOnce(new Error('Simulated failure during old share deletion'));

    const failedAtDelete = await patch(`/expenses/${expenseId}`, {
      title: 'Paragliding Full Payment',
      amountPaisa: 600000,
      payments: [
        { participantId: aarav, amountPaisa: 300000 },
        { participantId: dipesh, amountPaisa: 300000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: bina, amountPaisa: 200000 },
        { participantId: dipesh, amountPaisa: 200000 },
      ],
    });
    expect(failedAtDelete.status).toBeGreaterThanOrEqual(400);
    // Called once for the failing forward delete of old shares, and once in rollback() to remove newly inserted shares
    expect(deleteShareSpy).toHaveBeenCalledTimes(2);

    // Compensating rollback must have:
    // 1. Deleted the newly inserted 600,000 paisa payments & shares
    // 2. Restored the deleted old 300,000 paisa payments
    // 3. Restored the Expense document back to 'Paragliding Deposit' (300,000 paisa, __v: 0)
    const restoredExp = await ExpenseModel.findById(expenseId).lean();
    expect(restoredExp?.title).toBe('Paragliding Deposit');
    expect(restoredExp?.amountPaisa).toBe(300000);
    expect(restoredExp?.__v).toBe(0);

    const paymentsAfterRollback = await ExpensePaymentModel.find({ expenseId }).lean();
    const sharesAfterRollback = await ExpenseShareModel.find({ expenseId }).lean();
    expect(
      Object.fromEntries(
        paymentsAfterRollback.map((p) => [p.participantId.toString(), p.amountPaisa])
      )
    ).toEqual({
      [aarav]: 200000,
      [bina]: 100000,
    });
    expect(
      Object.fromEntries(sharesAfterRollback.map((s) => [s.participantId.toString(), s.sharePaisa]))
    ).toEqual({
      [aarav]: 150000,
      [bina]: 150000,
    });

    // B: Production fail-closed check: even if MONGO_TRANSACTIONS=disabled is set,
    // NODE_ENV=production must refuse standalone compensation with 503 TRANSACTIONS_UNAVAILABLE
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.MONGO_TRANSACTIONS = 'disabled';
    try {
      const prodRes = await patch(`/expenses/${expenseId}`, {
        amountPaisa: 400000,
      });
      expect(prodRes.status).toBe(503);
      expect(prodRes.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      delete process.env.MONGO_TRANSACTIONS;
    }

    // C: Optimistic concurrency check: if a concurrent edit bumps __v after the Expense
    // is loaded but before ExpenseModel.findOneAndUpdate executes, the stale edit rejects
    // with 409 CONCURRENT_MODIFICATION and does NOT overwrite the winning edit.
    const realInsertMany = ExpensePaymentModel.insertMany.bind(ExpensePaymentModel);
    vi.spyOn(ExpensePaymentModel, 'insertMany').mockImplementationOnce((async (
      docs: unknown,
      opts?: unknown
    ) => {
      // Simulate another writer committing an update right before our findOneAndUpdate
      await ExpenseModel.updateOne(
        { _id: expenseId },
        { $set: { title: 'Concurrent Winner Title' }, $inc: { __v: 1 } }
      );
      return realInsertMany(docs as never, opts as never);
    }) as never);

    const staleRes = await patch(`/expenses/${expenseId}`, {
      title: 'Stale Loser Title',
      amountPaisa: 600000,
    });
    expect(staleRes.status).toBe(409);
    expect(staleRes.body.error.code).toBe('CONCURRENT_MODIFICATION');

    const winnerExp = await ExpenseModel.findById(expenseId).lean();
    expect(winnerExp?.title).toBe('Concurrent Winner Title');
    expect(winnerExp?.amountPaisa).toBe(300000);

    await expectInvariants();
  });

  it('executes real MongoDB multi-document ACID transactions against an actual replica set and aborts cleanly on failure', async () => {
    const mongodPath = 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe';
    if (!fs.existsSync(mongodPath)) {
      return;
    }

    const replPort = 27029;
    const replDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripledger-replset-'));
    let replProc: ChildProcess | null = null;

    try {
      await disconnectDatabase();

      replProc = spawn(
        mongodPath,
        [
          '--replSet',
          'rs0',
          '--port',
          String(replPort),
          '--bind_ip',
          '127.0.0.1',
          '--dbpath',
          replDbDir,
        ],
        { stdio: 'ignore', windowsHide: true }
      );

      // Connect directConnection=true first to initialize the single-node replica set
      const directUri = `mongodb://127.0.0.1:${replPort}/tripledger_test_replset?directConnection=true`;
      let connected = false;
      for (let i = 0; i < 30; i++) {
        try {
          await mongoose.connect(directUri, { serverSelectionTimeoutMS: 500 });
          connected = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      expect(connected).toBe(true);

      await mongoose.connection.db!.admin().command({
        replSetInitiate: {
          _id: 'rs0',
          members: [{ _id: 0, host: `127.0.0.1:${replPort}` }],
        },
      });

      // Wait until the node transitions to PRIMARY (isWritablePrimary: true)
      let isPrimary = false;
      for (let i = 0; i < 40; i++) {
        const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
        if (hello.isWritablePrimary || hello.ismaster) {
          isPrimary = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(isPrimary).toBe(true);

      // Verify supportsTransactions() detects the real replica set
      expect(await supportsTransactions()).toBe(true);

      // Enforce required transactions mode
      process.env.MONGO_TRANSACTIONS = 'required';

      // Seed user, trip, participants, and an initial expense on the replica set
      const reg = await request(app).post('/api/v1/auth/register').send({
        name: 'Aarav Sharma',
        email: 'aarav.repl@example.com',
        password: 'Password123',
      });
      token = reg.body.data.accessToken as string;

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set(auth())
        .send({ name: 'Mustang Replica Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
      const tripId = tripRes.body.data.trip.id as string;
      const sharma = tripRes.body.data.families[0].id as string;
      const aarav = tripRes.body.data.myParticipant.id as string;
      const bina = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set(auth())
          .send({ name: 'Bina Sharma', familyId: sharma, role: 'PARTICIPANT', memberType: 'ADULT' })
      ).body.data.participant.id as string;

      fx = {
        ...fx,
        tripId,
        ids: { ...fx.ids, aarav, bina },
        famIds: { ...fx.famIds, sharma },
      };

      const createRes = await post('/expenses', {
        title: 'Mustang Jeep Charter',
        category: 'TRANSPORTATION',
        amountPaisa: 500000,
        splitMethod: 'CUSTOM',
        payments: [
          { participantId: aarav, amountPaisa: 300000 },
          { participantId: bina, amountPaisa: 200000 },
        ],
        customShares: [
          { participantId: aarav, amountPaisa: 250000 },
          { participantId: bina, amountPaisa: 250000 },
        ],
      });
      expect(createRes.status).toBe(201);
      const expenseId = createRes.body.data.expense.id as string;

      // 1. Successful multi-collection edit inside a real MongoDB ACID transaction
      const txEditRes = await patch(`/expenses/${expenseId}`, {
        title: 'Mustang Jeep Charter (Extended)',
        amountPaisa: 1000000,
      });
      expect(txEditRes.status).toBe(200);
      expect(txEditRes.body.data.expense.amountPaisa).toBe(1000000);
      expect(byParticipant(txEditRes.body.data.expense.payments)).toEqual({
        [aarav]: 600000,
        [bina]: 400000,
      });
      expect(byParticipant(txEditRes.body.data.expense.shares)).toEqual({
        [aarav]: 500000,
        [bina]: 500000,
      });
      await expectInvariants();

      // 2. Mid-transaction failure at the final step (ExpenseShareModel.deleteMany)
      // Verify WiredTiger aborts the transaction and rolls back ALL prior writes automatically
      vi.spyOn(ExpenseShareModel, 'deleteMany').mockRejectedValueOnce(
        new Error('Simulated failure inside real MongoDB transaction')
      );

      const abortedEditRes = await patch(`/expenses/${expenseId}`, {
        title: 'Should Be Aborted By WiredTiger',
        amountPaisa: 2000000,
      });
      expect(abortedEditRes.status).toBeGreaterThanOrEqual(400);

      const expAfterAbort = await ExpenseModel.findById(expenseId).lean();
      expect(expAfterAbort?.title).toBe('Mustang Jeep Charter (Extended)');
      expect(expAfterAbort?.amountPaisa).toBe(1000000);

      const paymentsAfterAbort = await ExpensePaymentModel.find({ expenseId }).lean();
      const sharesAfterAbort = await ExpenseShareModel.find({ expenseId }).lean();
      expect(paymentsAfterAbort).toHaveLength(2);
      expect(paymentsAfterAbort.reduce((a, p) => a + p.amountPaisa, 0)).toBe(1000000);
      expect(sharesAfterAbort).toHaveLength(2);
      expect(sharesAfterAbort.reduce((a, s) => a + s.sharePaisa, 0)).toBe(1000000);

      await expectInvariants();
    } finally {
      delete process.env.MONGO_TRANSACTIONS;
      await disconnectDatabase();
      if (replProc) {
        replProc.kill();
        await new Promise((r) => setTimeout(r, 500));
      }
      try {
        fs.rmSync(replDbDir, { recursive: true, force: true });
      } catch {
        // ignore Windows file lock cleanup delay
      }
      await connectDatabase(TEST_DB_URI);
    }
  }, 60000);
});
