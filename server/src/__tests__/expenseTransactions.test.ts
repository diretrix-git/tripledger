import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { verifyLedgerInvariants } from '@tripledger/shared';
import {
  ActivityLogModel,
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
  TripModel,
} from '../models/index.js';
import { supportsTransactions } from '../services/atomicWrite.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_expense_transactions';

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveMongodExecutable(): string {
  const envMongod = process.env.MONGOD_PATH?.trim();
  if (envMongod) {
    if (!isExecutableFile(envMongod)) {
      throw new Error(
        `Replica-set test cannot run: MONGOD_PATH is set to "${envMongod}", but no executable was found there.`
      );
    }
    return envMongod;
  }

  const candidateNames =
    process.platform === 'win32' ? ['mongod.exe', 'mongod.cmd', 'mongod'] : ['mongod'];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  const fallbackCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe',
          'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe',
          'C:\\Program Files\\MongoDB\\Server\\6.0\\bin\\mongod.exe',
        ]
      : [
          '/usr/bin/mongod',
          '/usr/local/bin/mongod',
          '/opt/homebrew/bin/mongod',
          '/opt/mongodb/bin/mongod',
        ];

  for (const candidate of fallbackCandidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Replica-set transaction test requires either TEST_REPLICA_SET_URI (or MONGODB_REPLICA_URI) pointing to a running MongoDB replica set, MONGOD_PATH pointing to a mongod executable, or mongod available in PATH or standard install directories.'
  );
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() =>
          reject(new Error('Failed to allocate ephemeral port for replica-set test.'))
        );
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function startOrConnectReplicaSet(): Promise<{ cleanup: () => Promise<void> }> {
  const externalUri =
    process.env.TEST_REPLICA_SET_URI?.trim() || process.env.MONGODB_REPLICA_URI?.trim();

  if (externalUri) {
    await disconnectDatabase();
    let hasDbName = false;
    try {
      const parsedUrl = new URL(externalUri);
      hasDbName = parsedUrl.pathname.length > 1;
    } catch {
      hasDbName = /\/[^/?]+/.test(externalUri.replace(/^[a-zA-Z+]+:\/\//, ''));
    }

    await mongoose.connect(externalUri, {
      serverSelectionTimeoutMS: 5000,
      ...(hasDbName ? {} : { dbName: 'tripledger_test_replset_tx' }),
    });

    if (!(await supportsTransactions())) {
      await disconnectDatabase();
      throw new Error(
        `Configured TEST_REPLICA_SET_URI / MONGODB_REPLICA_URI is not connected to a replica set or mongos (supportsTransactions() returned false).`
      );
    }

    await mongoose.connection.db!.dropDatabase();

    return {
      cleanup: async () => {
        try {
          if (mongoose.connection.db) {
            await mongoose.connection.db.dropDatabase();
          }
        } finally {
          await disconnectDatabase();
        }
      },
    };
  }

  const mongodPath = resolveMongodExecutable();
  const replPort = await allocateEphemeralPort();
  const replDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripledger-replset-tx-'));
  let replProc: ChildProcess | null = null;
  let spawnStderr = '';

  const cleanupLocal = async () => {
    await disconnectDatabase();
    if (replProc) {
      if (replProc.exitCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          replProc?.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          replProc?.kill();
        });
      }
      replProc = null;
    }
    try {
      fs.rmSync(replDbDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file lock cleanup delay
    }
  };

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
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );
    replProc.stderr?.on('data', (chunk: Buffer) => {
      spawnStderr += chunk.toString();
      if (spawnStderr.length > 2000) spawnStderr = spawnStderr.slice(-2000);
    });

    const directUri = `mongodb://127.0.0.1:${replPort}/tripledger_test_replset_tx?directConnection=true`;
    let connected = false;
    for (let i = 0; i < 40; i++) {
      if (replProc.exitCode !== null) {
        throw new Error(
          `mongod replica-set process (${mongodPath}) exited early with code ${replProc.exitCode}. Stderr: ${spawnStderr}`
        );
      }
      try {
        await mongoose.connect(directUri, { serverSelectionTimeoutMS: 500 });
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!connected) {
      throw new Error(
        `Timed out connecting to spawned replica-set mongod (${mongodPath}) on port ${replPort}.`
      );
    }

    await mongoose.connection.db!.admin().command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: `127.0.0.1:${replPort}` }],
      },
    });

    let isPrimary = false;
    for (let i = 0; i < 40; i++) {
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      if (hello.isWritablePrimary || hello.ismaster) {
        isPrimary = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!isPrimary) {
      throw new Error('Replica set rs0 failed to elect a writable primary within timeout.');
    }

    if (!(await supportsTransactions())) {
      throw new Error('Spawned replica set does not report multi-document transaction support.');
    }

    return { cleanup: cleanupLocal };
  } catch (err) {
    await cleanupLocal();
    throw err;
  }
}

interface Fixture {
  tripId: string;
  otherTripId: string;
  otherTripParticipantId: string;
  otherTripFamilyId: string;
  ids: { aarav: string; bina: string; dipesh: string; esha: string; farhan: string };
  famIds: { sharma: string; thapa: string; karki: string };
}

describe('Task 3: transactional consistency for createExpense, approveOrConfirmExpense & softDeleteExpense (DB-01)', () => {
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

  async function del(path: string) {
    return request(app).delete(`/api/v1/trips/${fx.tripId}${path}`).set(auth());
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
    // Retain schema indexes after dropDatabase() so sparse unique (tripId, clientMutationId)
    // behavior is still enforced when normal Task 3 expenses omit clientMutationId.
    await ExpenseModel.createIndexes();

    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Aarav Sharma',
      email: 'aarav.tx@example.com',
      password: 'Password123',
    });
    token = reg.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set(auth())
      .send({ name: 'Annapurna Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
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

    const otherTripRes = await request(app)
      .post('/api/v1/trips')
      .set(auth())
      .send({ name: 'Foreign Trip', mode: 'FAMILY', organizerFamilyName: 'Foreign Family' });
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

  // ---------------------------------------------------------------------------
  // 1. createExpense / createInitialExpenseLedger
  // ---------------------------------------------------------------------------

  it('createExpense rejects invalid, inactive, and cross-trip participant/family IDs before any DB mutation', async () => {
    const { aarav, bina, farhan } = fx.ids;
    await patch(`/participants/${farhan}`, { isActive: false });
    const logsBefore = await ActivityLogModel.countDocuments({ tripId: fx.tripId });

    // Malformed ObjectId in includedParticipantIds
    const badIncluded = await post('/expenses', {
      title: 'Bad Included',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      includedParticipantIds: [aarav, 'not-an-object-id'],
    });
    expect(badIncluded.status).toBe(400);

    // Inactive participant in weights
    const inactiveWeight = await post('/expenses', {
      title: 'Inactive Weight',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'WEIGHTED',
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      weights: [
        { participantId: aarav, weight: 1 },
        { participantId: farhan, weight: 1 },
      ],
    });
    expect(inactiveWeight.status).toBe(400);

    // Cross-trip participant in customShares
    const foreignCustom = await post('/expenses', {
      title: 'Foreign Custom',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'CUSTOM',
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      customShares: [
        { participantId: aarav, amountPaisa: 50000 },
        { participantId: fx.otherTripParticipantId, amountPaisa: 50000 },
      ],
    });
    expect(foreignCustom.status).toBe(400);

    // Cross-trip family in includedFamilyIds
    const foreignFamily = await post('/expenses', {
      title: 'Foreign Family',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'PER_FAMILY',
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      includedParticipantIds: [aarav, bina],
      includedFamilyIds: [fx.otherTripFamilyId],
    });
    expect(foreignFamily.status).toBe(400);

    // Cross-trip participant in payments
    const foreignPayment = await post('/expenses', {
      title: 'Foreign Payment',
      category: 'FOOD_DRINKS',
      amountPaisa: 100000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: fx.otherTripParticipantId, amountPaisa: 100000 }],
    });
    expect(foreignPayment.status).toBe(400);

    // Zero expenses, payments, shares, or new activity logs written; checklist unchanged
    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ActivityLogModel.countDocuments({ tripId: fx.tripId })).toBe(logsBefore);

    const tripDoc = await TripModel.findById(fx.tripId).lean();
    expect(tripDoc?.checklist.find((c) => c.category === 'FOOD_DRINKS')?.checked).toBe(false);
    await expectInvariants();
  });

  it('createExpense rolls back Expense, payments, shares, checklist & skips activity log on partial failure without overwriting concurrent trip edits', async () => {
    const { aarav, bina } = fx.ids;
    const logsBefore = await ActivityLogModel.countDocuments({ tripId: fx.tripId });

    // A: Failure after Expense + Payments were written (at ExpenseShareModel.insertMany)
    vi.spyOn(ExpenseShareModel, 'insertMany').mockRejectedValueOnce(
      new Error('Simulated share insert failure on create')
    );

    const failSharesRes = await post('/expenses', {
      title: 'Failed Share Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 200000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 200000 }],
      includedParticipantIds: [aarav, bina],
    });
    expect(failSharesRes.status).toBeGreaterThanOrEqual(400);
    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ActivityLogModel.countDocuments({ tripId: fx.tripId })).toBe(logsBefore);

    // B: Failure at the FINAL step (ActivityLogModel.create) AFTER Expense, Payments, Shares,
    // AND Trip.checklist auto-check were all persisted; also verify concurrent Trip.name edit
    // happens right before rollback and is NOT overwritten by rollback!
    vi.spyOn(ActivityLogModel, 'create').mockImplementationOnce((async () => {
      await TripModel.updateOne({ _id: fx.tripId }, { $set: { name: 'Annapurna Concurrent Rename' } });
      throw new Error('Simulated final-step ActivityLog failure on create');
    }) as never);

    const failActivityRes = await post('/expenses', {
      title: 'Failed Activity Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 300000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 300000 }],
      includedParticipantIds: [aarav, bina],
    });
    expect(failActivityRes.status).toBeGreaterThanOrEqual(400);

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ActivityLogModel.countDocuments({ tripId: fx.tripId })).toBe(logsBefore);

    const tripAfter = await TripModel.findById(fx.tripId).lean();
    expect(tripAfter?.name).toBe('Annapurna Concurrent Rename');
    expect(tripAfter?.checklist.find((c) => c.category === 'FOOD_DRINKS')?.checked).toBe(false);

    // C: Production fail-closed check (even with MONGO_TRANSACTIONS=disabled)
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.MONGO_TRANSACTIONS = 'disabled';
    try {
      const prodRes = await post('/expenses', {
        title: 'Strict Prod Create',
        category: 'FOOD_DRINKS',
        amountPaisa: 100000,
        splitMethod: 'EQUAL',
        payments: [{ participantId: aarav, amountPaisa: 100000 }],
      });
      expect(prodRes.status).toBe(503);
      expect(prodRes.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');
    } finally {
      process.env.NODE_ENV = prevEnv;
      delete process.env.MONGO_TRANSACTIONS;
    }

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 2. approveOrConfirmExpense
  // ---------------------------------------------------------------------------

  it('approveOrConfirmExpense validates IDs, rolls back partial writes on approval & rejection, enforces production fail-closed & handles optimistic concurrency cleanly', async () => {
    const { aarav, bina, dipesh, farhan } = fx.ids;
    await patch(`/participants/${farhan}`, { isActive: false });

    const estRes = await post('/expenses', {
      title: 'Estimated Hotel',
      category: 'ACCOMMODATION',
      amountPaisa: 400000,
      isEstimated: true,
      splitMethod: 'CUSTOM',
      payments: [
        { participantId: aarav, amountPaisa: 250000 },
        { participantId: bina, amountPaisa: 150000 },
      ],
      customShares: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: bina, amountPaisa: 200000 },
      ],
    });
    expect(estRes.status).toBe(201);
    const expenseId = estRes.body.data.expense.id as string;

    // A: Invalid expenseId & referenced IDs fail BEFORE DB mutation
    expect((await post('/expenses/bad-id/approve', { approvalStatus: 'APPROVED' })).status).toBe(400);
    expect(
      (
        await post(`/expenses/${expenseId}/approve`, {
          approvalStatus: 'APPROVED',
          actualAmountPaisa: 500000,
          payments: [{ participantId: fx.otherTripParticipantId, amountPaisa: 500000 }],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await post(`/expenses/${expenseId}/approve`, {
          approvalStatus: 'APPROVED',
          actualAmountPaisa: 500000,
          customShares: [
            { participantId: aarav, amountPaisa: 250000 },
            { participantId: farhan, amountPaisa: 250000 },
          ],
        })
      ).status
    ).toBe(400);

    // B: Partial failure at FINAL step (ActivityLogModel.create) AFTER rescaled payments/shares,
    // Expense update, AND old row deletions all occurred -> must restore original payments/shares/Expense!
    vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
      new Error('Simulated ActivityLog failure during confirmation')
    );

    const failedConfirm = await post(`/expenses/${expenseId}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 800000,
    });
    expect(failedConfirm.status).toBeGreaterThanOrEqual(400);

    const expAfterFail = await ExpenseModel.findById(expenseId).lean();
    expect(expAfterFail?.amountPaisa).toBe(400000);
    expect(expAfterFail?.approvalStatus).toBe('PENDING_CONFIRMATION');
    expect(expAfterFail?.isEstimated).toBe(true);
    expect(expAfterFail?.__v).toBe(0);
    expect((await ExpensePaymentModel.find({ expenseId }).lean()).reduce((a, p) => a + p.amountPaisa, 0)).toBe(400000);
    expect((await ExpenseShareModel.find({ expenseId }).lean()).reduce((a, s) => a + s.sharePaisa, 0)).toBe(400000);

    // C: Partial failure during REJECTION (ActivityLogModel.create fails after Expense status update) -> restores PENDING_CONFIRMATION
    vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
      new Error('Simulated ActivityLog failure during rejection')
    );
    const failedReject = await post(`/expenses/${expenseId}/approve`, {
      approvalStatus: 'REJECTED',
    });
    expect(failedReject.status).toBeGreaterThanOrEqual(400);
    const expAfterFailedReject = await ExpenseModel.findById(expenseId).lean();
    expect(expAfterFailedReject?.approvalStatus).toBe('PENDING_CONFIRMATION');
    expect(expAfterFailedReject?.isEstimated).toBe(true);

    // D: Production fail-closed check (even for non-rescaled rejection)
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodReject = await post(`/expenses/${expenseId}/approve`, {
        approvalStatus: 'REJECTED',
      });
      expect(prodReject.status).toBe(503);
      expect(prodReject.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // E: Optimistic concurrency conflict (409) when a concurrent writer updates Expense (and replaces
    // its payments/shares) right before approveOrConfirmExpense executes ExpenseModel.findOneAndUpdate:
    // The stale confirmation MUST fail with 409 CONCURRENT_MODIFICATION, clean up its own tentative rows,
    // and NEVER re-insert deleted old rows or overwrite the concurrent winner!
    const realInsertMany = ExpenseShareModel.insertMany.bind(ExpenseShareModel);
    vi.spyOn(ExpenseShareModel, 'insertMany').mockImplementationOnce((async (
      docs: unknown,
      opts?: unknown
    ) => {
      // Simulate concurrent winner updating Expense + deleting old payments + inserting Dipesh payment
      await ExpenseModel.updateOne(
        { _id: expenseId },
        { $set: { title: 'Concurrent Winner Hotel', amountPaisa: 600000 }, $inc: { __v: 1 } }
      );
      await ExpensePaymentModel.deleteMany({ expenseId });
      await ExpensePaymentModel.create({
        tripId: fx.tripId,
        expenseId,
        participantId: dipesh,
        amountPaisa: 600000,
        paymentMethod: 'CASH',
        paidAt: new Date(),
      });
      await ExpenseShareModel.deleteMany({ expenseId });
      await realInsertMany([
        { tripId: fx.tripId, expenseId, participantId: aarav, sharePaisa: 300000, weightUsed: 1 },
        { tripId: fx.tripId, expenseId, participantId: bina, sharePaisa: 300000, weightUsed: 1 },
      ]);
      return realInsertMany(docs as never, opts as never);
    }) as never);

    const staleConfirm = await post(`/expenses/${expenseId}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 900000,
    });
    expect(staleConfirm.status).toBe(409);
    expect(staleConfirm.body.error.code).toBe('CONCURRENT_MODIFICATION');

    // Verify ONLY the concurrent winner's 600,000 paisa state remains (old rows were NOT re-inserted!)
    const winnerPayments = await ExpensePaymentModel.find({ expenseId }).lean();
    const winnerShares = await ExpenseShareModel.find({ expenseId }).lean();
    expect(winnerPayments).toHaveLength(1);
    expect(winnerPayments[0]!.amountPaisa).toBe(600000);
    expect(winnerShares).toHaveLength(2);
    expect(winnerShares.reduce((a, s) => a + s.sharePaisa, 0)).toBe(600000);

    const winnerExp = await ExpenseModel.findById(expenseId).lean();
    expect(winnerExp?.title).toBe('Concurrent Winner Hotel');
    expect(winnerExp?.approvalStatus).toBe('PENDING_CONFIRMATION');

    // F: Successful rejection after cleanup leaves ledger untouched
    const rejectRes = await post(`/expenses/${expenseId}/approve`, {
      approvalStatus: 'REJECTED',
      actualAmountPaisa: 999999,
    });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.expense.approvalStatus).toBe('REJECTED');
    expect(rejectRes.body.data.expense.amountPaisa).toBe(600000);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 3. softDeleteExpense
  // ---------------------------------------------------------------------------

  it('softDeleteExpense validates IDs, rolls back failed activity log write, handles concurrency, and enforces production fail-closed', async () => {
    const { aarav, bina } = fx.ids;
    const createRes = await post('/expenses', {
      title: 'Deletable Boat Ride',
      category: 'ACTIVITIES',
      amountPaisa: 200000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 200000 }],
      includedParticipantIds: [aarav, bina],
    });
    expect(createRes.status).toBe(201);
    const expenseId = createRes.body.data.expense.id as string;

    // A: Invalid ID -> 400 INVALID_ID
    expect((await del('/expenses/invalid-id')).status).toBe(400);

    // B: ActivityLogModel.create fails after Expense.isDeleted=true -> rollback restores isDeleted=false & __v=0
    vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
      new Error('Simulated ActivityLog failure during delete')
    );
    const failedDel = await del(`/expenses/${expenseId}`);
    expect(failedDel.status).toBeGreaterThanOrEqual(400);

    const restoredDoc = await ExpenseModel.findById(expenseId).lean();
    expect(restoredDoc?.isDeleted).toBe(false);
    expect(restoredDoc?.deletedAt).toBeNull();
    expect(restoredDoc?.__v).toBe(0);

    // C: Production fail-closed check
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodDel = await del(`/expenses/${expenseId}`);
      expect(prodDel.status).toBe(503);
      expect(prodDel.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // D: Optimistic concurrency check: concurrent version bump causes 409 CONCURRENT_MODIFICATION
    const realFindOneAndUpdate = ExpenseModel.findOneAndUpdate.bind(ExpenseModel);
    vi.spyOn(ExpenseModel, 'findOneAndUpdate').mockImplementationOnce((async (
      filter: unknown,
      update: unknown,
      opts?: unknown
    ) => {
      await ExpenseModel.updateOne({ _id: expenseId }, { $set: { title: 'Edited Concurrently' }, $inc: { __v: 1 } });
      return realFindOneAndUpdate(filter as never, update as never, opts as never);
    }) as never);

    const staleDel = await del(`/expenses/${expenseId}`);
    expect(staleDel.status).toBe(409);
    expect(staleDel.body.error.code).toBe('CONCURRENT_MODIFICATION');
    expect((await ExpenseModel.findById(expenseId).lean())?.isDeleted).toBe(false);

    // E: Successful delete marks isDeleted=true, updates ledger & logs EXPENSE_DELETED
    const okDel = await del(`/expenses/${expenseId}`);
    expect(okDel.status).toBe(200);
    expect(okDel.body.data.ledger.totalApprovedExpensePaisa).toBe(0);
    expect(
      await ActivityLogModel.countDocuments({
        tripId: fx.tripId,
        entityId: expenseId,
        actionType: 'EXPENSE_DELETED',
      })
    ).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 4. Real Replica-Set MongoDB ACID Transaction Tests (create, approve, reject, delete)
  // ---------------------------------------------------------------------------

  it('executes real MongoDB ACID transactions with shared ClientSession across createExpense, approveOrConfirmExpense & softDeleteExpense and aborts cleanly on failure', async () => {
    let replicaSet: { cleanup: () => Promise<void> } | null = null;

    try {
      replicaSet = await startOrConnectReplicaSet();
      expect(await supportsTransactions()).toBe(true);
      process.env.MONGO_TRANSACTIONS = 'required';

      const reg = await request(app).post('/api/v1/auth/register').send({
        name: 'Aarav Sharma',
        email: 'aarav.txrepl@example.com',
        password: 'Password123',
      });
      token = reg.body.data.accessToken as string;

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set(auth())
        .send({ name: 'Manang Replica Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
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

      const sessionOf = (call: unknown[] | undefined) =>
        call
          ?.map((arg) => (arg as { session?: { id?: unknown } } | undefined)?.session)
          .find((s) => Boolean(s));

      // Verify every participating model receives the SAME non-null ClientSession on createExpense
      const createSpy = vi.spyOn(ExpenseModel, 'create');
      const payInsertSpy = vi.spyOn(ExpensePaymentModel, 'insertMany');
      const shareInsertSpy = vi.spyOn(ExpenseShareModel, 'insertMany');
      const tripUpdateSpy = vi.spyOn(TripModel, 'findOneAndUpdate');
      const logSpy = vi.spyOn(ActivityLogModel, 'create');

      // 1. Committed createExpense (first expense on fresh replica set -> creates collections + auto-checks checklist + logs activity)
      const createRes = await post('/expenses', {
        title: 'Manang Lodge',
        category: 'ACCOMMODATION',
        amountPaisa: 600000,
        splitMethod: 'EQUAL',
        payments: [{ participantId: aarav, amountPaisa: 600000 }],
        includedParticipantIds: [aarav, bina],
      });
      expect(createRes.status).toBe(201);

      const s1 = sessionOf(createSpy.mock.calls[0] as unknown[]);
      const s2 = sessionOf(payInsertSpy.mock.calls[0] as unknown[]);
      const s3 = sessionOf(shareInsertSpy.mock.calls[0] as unknown[]);
      const s4 = sessionOf(tripUpdateSpy.mock.calls[0] as unknown[]);
      const s5 = sessionOf(logSpy.mock.calls[0] as unknown[]);
      expect(s1).toBeTruthy();
      expect(s2?.id).toEqual(s1?.id);
      expect(s3?.id).toEqual(s1?.id);
      expect(s4?.id).toEqual(s1?.id);
      expect(s5?.id).toEqual(s1?.id);
      vi.restoreAllMocks();

      const lodgedExpenseId = createRes.body.data.expense.id as string;
      const tripAfterCreate = await TripModel.findById(tripId).lean();
      expect(tripAfterCreate?.checklist.find((c) => c.category === 'ACCOMMODATION')?.checked).toBe(true);
      await expectInvariants();

      // 2. Aborted createExpense inside real transaction (fail at ActivityLogModel.create)
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
        new Error('Simulated ActivityLog failure inside replica-set create transaction')
      );
      const abortedCreate = await post('/expenses', {
        title: 'Should Abort Transport',
        category: 'TRANSPORTATION',
        amountPaisa: 300000,
        splitMethod: 'EQUAL',
        payments: [{ participantId: aarav, amountPaisa: 300000 }],
        includedParticipantIds: [aarav, bina],
      });
      expect(abortedCreate.status).toBeGreaterThanOrEqual(400);
      expect(await ExpenseModel.countDocuments({ tripId })).toBe(1);
      expect(await ExpensePaymentModel.countDocuments({ tripId })).toBe(1);
      expect(await ExpenseShareModel.countDocuments({ tripId })).toBe(2);
      const tripAfterAbort = await TripModel.findById(tripId).lean();
      expect(tripAfterAbort?.checklist.find((c) => c.category === 'TRANSPORTATION')?.checked).toBe(false);

      // 3. Create estimated expense, abort approveOrConfirmExpense mid-transaction, then commit with shared ClientSession
      const estRes = await post('/expenses', {
        title: 'Estimated Porter',
        category: 'MISCELLANEOUS',
        amountPaisa: 400000,
        isEstimated: true,
        splitMethod: 'EQUAL',
        payments: [
          { participantId: aarav, amountPaisa: 300000 },
          { participantId: bina, amountPaisa: 100000 },
        ],
        includedParticipantIds: [aarav, bina],
      });
      expect(estRes.status).toBe(201);
      const estId = estRes.body.data.expense.id as string;

      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
        new Error('Simulated ActivityLog failure inside replica-set approve transaction')
      );
      const abortedApprove = await post(`/expenses/${estId}/approve`, {
        approvalStatus: 'APPROVED',
        actualAmountPaisa: 800000,
      });
      expect(abortedApprove.status).toBeGreaterThanOrEqual(400);
      expect((await ExpenseModel.findById(estId).lean())?.amountPaisa).toBe(400000);
      expect((await ExpenseModel.findById(estId).lean())?.approvalStatus).toBe('PENDING_CONFIRMATION');
      expect((await ExpensePaymentModel.find({ expenseId: estId }).lean()).reduce((a, p) => a + p.amountPaisa, 0)).toBe(400000);

      const appPayInsSpy = vi.spyOn(ExpensePaymentModel, 'insertMany');
      const appShareInsSpy = vi.spyOn(ExpenseShareModel, 'insertMany');
      const appExpUpdSpy = vi.spyOn(ExpenseModel, 'findOneAndUpdate');
      const appPayDelSpy = vi.spyOn(ExpensePaymentModel, 'deleteMany');
      const appShareDelSpy = vi.spyOn(ExpenseShareModel, 'deleteMany');
      const appLogSpy = vi.spyOn(ActivityLogModel, 'create');

      const committedApprove = await post(`/expenses/${estId}/approve`, {
        approvalStatus: 'APPROVED',
        actualAmountPaisa: 800000,
      });
      expect(committedApprove.status).toBe(200);
      expect(committedApprove.body.data.expense.amountPaisa).toBe(800000);
      expect(committedApprove.body.data.expense.approvalStatus).toBe('APPROVED');

      const approveSession = sessionOf(appExpUpdSpy.mock.calls[0] as unknown[]);
      expect(approveSession).toBeTruthy();
      expect(sessionOf(appPayInsSpy.mock.calls[0] as unknown[])?.id).toEqual(approveSession?.id);
      expect(sessionOf(appShareInsSpy.mock.calls[0] as unknown[])?.id).toEqual(approveSession?.id);
      expect(sessionOf(appPayDelSpy.mock.calls[0] as unknown[])?.id).toEqual(approveSession?.id);
      expect(sessionOf(appShareDelSpy.mock.calls[0] as unknown[])?.id).toEqual(approveSession?.id);
      expect(sessionOf(appLogSpy.mock.calls[0] as unknown[])?.id).toEqual(approveSession?.id);
      vi.restoreAllMocks();
      await expectInvariants();

      // 3b. Estimated expense rejection inside a real transaction (abort on failure, then commit cleanly)
      const rejEstRes = await post('/expenses', {
        title: 'Estimated Helicopter',
        category: 'TRANSPORTATION',
        amountPaisa: 500000,
        isEstimated: true,
        splitMethod: 'EQUAL',
        payments: [{ participantId: aarav, amountPaisa: 500000 }],
        includedParticipantIds: [aarav, bina],
      });
      expect(rejEstRes.status).toBe(201);
      const rejId = rejEstRes.body.data.expense.id as string;

      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
        new Error('Simulated ActivityLog failure inside replica-set reject transaction')
      );
      const abortedReject = await post(`/expenses/${rejId}/approve`, {
        approvalStatus: 'REJECTED',
      });
      expect(abortedReject.status).toBeGreaterThanOrEqual(400);
      expect((await ExpenseModel.findById(rejId).lean())?.approvalStatus).toBe('PENDING_CONFIRMATION');

      const committedReject = await post(`/expenses/${rejId}/approve`, {
        approvalStatus: 'REJECTED',
        actualAmountPaisa: 999999,
      });
      expect(committedReject.status).toBe(200);
      expect(committedReject.body.data.expense.approvalStatus).toBe('REJECTED');
      expect(committedReject.body.data.expense.amountPaisa).toBe(500000);
      await expectInvariants();

      // 4. softDeleteExpense: abort mid-transaction on failure, then commit with shared ClientSession
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
        new Error('Simulated ActivityLog failure inside replica-set delete transaction')
      );
      const abortedDelete = await del(`/expenses/${lodgedExpenseId}`);
      expect(abortedDelete.status).toBeGreaterThanOrEqual(400);
      expect((await ExpenseModel.findById(lodgedExpenseId).lean())?.isDeleted).toBe(false);

      const delExpUpdSpy = vi.spyOn(ExpenseModel, 'findOneAndUpdate');
      const delLogSpy = vi.spyOn(ActivityLogModel, 'create');

      const committedDelete = await del(`/expenses/${lodgedExpenseId}`);
      expect(committedDelete.status).toBe(200);
      expect((await ExpenseModel.findById(lodgedExpenseId).lean())?.isDeleted).toBe(true);

      const delSession = sessionOf(delExpUpdSpy.mock.calls[0] as unknown[]);
      expect(delSession).toBeTruthy();
      expect(sessionOf(delLogSpy.mock.calls[0] as unknown[])?.id).toEqual(delSession?.id);
      vi.restoreAllMocks();
      await expectInvariants();
    } finally {
      delete process.env.MONGO_TRANSACTIONS;
      if (replicaSet) {
        await replicaSet.cleanup();
      } else {
        await disconnectDatabase();
      }
      await connectDatabase(TEST_DB_URI);
    }
  }, 60000);
});
