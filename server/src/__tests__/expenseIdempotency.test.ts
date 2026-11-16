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
} from '../models/index.js';
import { EXPENSE_MUTATION_ID_INDEX_NAME } from '../models/Expense.js';
import {
  computeExpenseIdempotencyHash,
  isDuplicateKeyError,
  matchesLegacyExpenseRecord,
} from '../services/expenseIdempotency.js';
import { migrateExpenseMutationIndex } from '../migrations/migrateExpenseMutationIndex.js';
import { supportsTransactions } from '../services/atomicWrite.js';
import { clearTestEmailOutbox, getTestEmailOutbox } from '../services/emailService.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_expense_idempotency';

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
    'Replica-set concurrency test requires either TEST_REPLICA_SET_URI (or MONGODB_REPLICA_URI) pointing to a running MongoDB replica set, MONGOD_PATH pointing to a mongod executable, or mongod available in PATH or standard install directories.'
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
      ...(hasDbName ? {} : { dbName: 'tripledger_test_replset_idempotency' }),
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
  const replDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripledger-replset-idem-'));
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

    const directUri = `mongodb://127.0.0.1:${replPort}/tripledger_test_replset_idempotency?directConnection=true`;
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

/**
 * Coordinates two concurrent `createExpense` requests so both pass their initial
 * `ExpenseModel.findOne` pre-check simultaneously (observing `null`), forcing a genuine
 * MongoDB `E11000` race on the unique `(tripId, clientMutationId)` index inside `createInitialExpenseLedger`.
 */
function installConcurrentPrecheckBarrier() {
  const origFindOne = ExpenseModel.findOne.bind(ExpenseModel);
  let precheckCount = 0;
  let releasePrechecks!: () => void;
  const bothPrechecksDone = new Promise<void>((resolve) => {
    releasePrechecks = resolve;
  });
  const recordedCalls: Array<{
    phase: 'precheck' | 'recovery';
    filter: unknown;
    options: unknown;
  }> = [];

  const spy = vi.spyOn(ExpenseModel, 'findOne').mockImplementation(((
    filter?: unknown,
    projection?: unknown,
    options?: unknown
  ) => {
    const isIdempotencyLookup =
      typeof filter === 'object' &&
      filter !== null &&
      'clientMutationId' in (filter as Record<string, unknown>);

    if (!isIdempotencyLookup) {
      return origFindOne(filter as never, projection as never, options as never);
    }

    const query = origFindOne(filter as never, projection as never, options as never);
    const execOrig = query.exec.bind(query);
    query.exec = async () => {
      const doc = await execOrig();
      const idx = ++precheckCount;
      recordedCalls.push({
        phase: idx <= 2 ? 'precheck' : 'recovery',
        filter,
        options: query.getOptions(),
      });
      if (idx === 1) {
        await bothPrechecksDone;
      } else if (idx === 2) {
        releasePrechecks();
      }
      return doc;
    };
    return query;
  }) as typeof ExpenseModel.findOne);

  return { spy, recordedCalls };
}

interface Fixture {
  tripId: string;
  otherTripId: string;
  ids: { aarav: string; bina: string; dipesh: string; esha: string };
  famIds: { sharma: string; thapa: string };
}

describe('Task 4: concurrency-safe expense idempotency (FIN/DB)', () => {
  const app = createApp();
  let orgToken = '';
  let contribToken = '';
  let memberToken = '';
  let outsiderToken = '';
  let fx: Fixture;

  const auth = (token = orgToken) => ({ Authorization: `Bearer ${token}` });

  async function post(path: string, body: unknown, token = orgToken) {
    return request(app)
      .post(`/api/v1/trips/${fx.tripId}${path}`)
      .set(auth(token))
      .send(body as object);
  }

  async function getTrip(token = orgToken) {
    const res = await request(app).get(`/api/v1/trips/${fx.tripId}`).set(auth(token));
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
    await ExpenseModel.createIndexes();

    const regOrg = await request(app).post('/api/v1/auth/register').send({
      name: 'Aarav Sharma',
      email: 'aarav.idem@example.com',
      password: 'Password123',
    });
    orgToken = regOrg.body.data.accessToken as string;

    clearTestEmailOutbox();
    const regContrib = await request(app).post('/api/v1/auth/register').send({
      name: 'Dipesh Thapa',
      email: 'dipesh.idem@example.com',
      password: 'Password123',
    });
    contribToken = regContrib.body.data.accessToken as string;
    const contribOutbox = getTestEmailOutbox();
    const contribVerifyTok = new URL(
      contribOutbox[contribOutbox.length - 1]!.verificationUrl
    ).searchParams.get('token')!;
    await request(app).post('/api/v1/auth/verify-email').send({ token: contribVerifyTok });

    const regMember = await request(app).post('/api/v1/auth/register').send({
      name: 'Esha Thapa',
      email: 'esha.idem@example.com',
      password: 'Password123',
    });
    memberToken = regMember.body.data.accessToken as string;

    const regOutsider = await request(app).post('/api/v1/auth/register').send({
      name: 'Kiran Outsider',
      email: 'kiran.idem@example.com',
      password: 'Password123',
    });
    outsiderToken = regOutsider.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set(auth())
      .send({ name: 'Mustang Jeep Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;
    const sharma = tripRes.body.data.families[0].id as string;
    const aarav = tripRes.body.data.myParticipant.id as string;

    const thapa = (
      await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set(auth())
        .send({ name: 'Thapa Family' })
    ).body.data.family.id as string;

    const bina = (
      await request(app)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set(auth())
        .send({ name: 'Bina Sharma', familyId: sharma, role: 'PARTICIPANT', memberType: 'ADULT' })
    ).body.data.participant.id as string;

    const dipeshJoin = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set(auth(contribToken));
    const dipesh = dipeshJoin.body.data.participantId as string;
    await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${dipesh}`)
      .set(auth())
      .send({ familyId: thapa, role: 'CONTRIBUTOR', memberType: 'ADULT' });

    const eshaJoin = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set(auth(memberToken));
    const esha = eshaJoin.body.data.participantId as string;
    await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${esha}`)
      .set(auth())
      .send({ familyId: thapa, role: 'PARTICIPANT', memberType: 'ADULT' });

    const otherTripRes = await request(app)
      .post('/api/v1/trips')
      .set(auth())
      .send({ name: 'Rara Side Trip', mode: 'FRIENDS' });
    const otherTripId = otherTripRes.body.data.trip.id as string;

    fx = {
      tripId,
      otherTripId,
      ids: { aarav, bina, dipesh, esha },
      famIds: { sharma, thapa },
    };
  }, 30000);

  // ---------------------------------------------------------------------------
  // 1. Sequential retry with identical payload
  // ---------------------------------------------------------------------------
  it('1. sequential retry with identical payload (and reordered canonical arrays) returns 200 deduplicated without duplicating records', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const payload = {
      title: 'Pokhara Breakfast',
      category: 'FOOD_DRINKS',
      amountPaisa: 300000,
      splitMethod: 'EQUAL',
      paymentMethod: 'CASH',
      payments: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: bina, amountPaisa: 100000 },
      ],
      includedParticipantIds: [aarav, bina, dipesh],
      clientMutationId: 'seq-identical-001',
    };

    const first = await post('/expenses', payload);
    expect(first.status).toBe(201);
    expect(first.body.data.deduplicated).toBe(false);

    // Retry even with different payer/participant array order (canonically identical) and omitted incurredAt
    const second = await post('/expenses', {
      title: 'Pokhara Breakfast',
      category: 'FOOD_DRINKS',
      amountPaisa: 300000,
      splitMethod: 'EQUAL',
      paymentMethod: 'CASH',
      payments: [
        { participantId: bina, amountPaisa: 100000 },
        { participantId: aarav, amountPaisa: 200000 },
      ],
      includedParticipantIds: [dipesh, bina, aarav],
      clientMutationId: 'seq-identical-001',
    });
    expect(second.status).toBe(200);
    expect(second.body.data.deduplicated).toBe(true);
    expect(second.body.data.expense.id).toBe(first.body.data.expense.id);
    expect(second.body.data.ledger.totalApprovedExpensePaisa).toBe(300000);

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(2);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(3);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 2. Sequential retry with changed amount
  // ---------------------------------------------------------------------------
  it('2. sequential retry with changed amount rejects with 409 IDEMPOTENCY_KEY_REUSED and keeps ledger unchanged', async () => {
    const { aarav, bina } = fx.ids;
    const first = await post('/expenses', {
      title: 'Jeep Deposit',
      category: 'TRANSPORTATION',
      amountPaisa: 500000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 500000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'seq-amount-conflict-001',
    });
    expect(first.status).toBe(201);

    const conflict = await post('/expenses', {
      title: 'Jeep Deposit',
      category: 'TRANSPORTATION',
      amountPaisa: 700000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 700000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'seq-amount-conflict-001',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.success).toBe(false);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Conflict response must never leak existing expense details
    expect(conflict.body.data).toBeUndefined();
    expect(JSON.stringify(conflict.body)).not.toContain('Jeep Deposit');

    const stored = await ExpenseModel.findById(first.body.data.expense.id).lean();
    expect(stored?.amountPaisa).toBe(500000);
    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 3. Sequential retry with changed payer allocation (and split change)
  // ---------------------------------------------------------------------------
  it('3. sequential retry with changed payer allocation or split configuration rejects with 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const first = await post('/expenses', {
      title: 'Fuel Refill',
      category: 'TRANSPORTATION',
      amountPaisa: 400000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'seq-payer-conflict-001',
    });
    expect(first.status).toBe(201);

    // Changed payer allocation (same total amount)
    const payerConflict = await post('/expenses', {
      title: 'Fuel Refill',
      category: 'TRANSPORTATION',
      amountPaisa: 400000,
      splitMethod: 'EQUAL',
      payments: [
        { participantId: aarav, amountPaisa: 200000 },
        { participantId: bina, amountPaisa: 200000 },
      ],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'seq-payer-conflict-001',
    });
    expect(payerConflict.status).toBe(409);
    expect(payerConflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Changed share allocation (custom split instead of equal)
    const splitConflict = await post('/expenses', {
      title: 'Fuel Refill',
      category: 'TRANSPORTATION',
      amountPaisa: 400000,
      splitMethod: 'CUSTOM',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      customShares: [
        { participantId: aarav, amountPaisa: 300000 },
        { participantId: bina, amountPaisa: 100000 },
      ],
      clientMutationId: 'seq-payer-conflict-001',
    });
    expect(splitConflict.status).toBe(409);
    expect(splitConflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Changed included participants
    const participantConflict = await post('/expenses', {
      title: 'Fuel Refill',
      category: 'TRANSPORTATION',
      amountPaisa: 400000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 400000 }],
      includedParticipantIds: [aarav, bina, dipesh],
      clientMutationId: 'seq-payer-conflict-001',
    });
    expect(participantConflict.status).toBe(409);
    expect(participantConflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(2);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 4. Concurrent identical requests (natural + barrier-forced E11000)
  // ---------------------------------------------------------------------------
  it('4. concurrent identical requests create exactly one expense, payment set & share set even on E11000 race', async () => {
    const { aarav, bina } = fx.ids;
    const payload = {
      title: 'Concurrent Mustang Permits',
      category: 'ENTRY_FEES',
      amountPaisa: 200000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 200000 }],
      includedParticipantIds: [aarav, bina],
      incurredAt: '2026-11-12T08:00:00.000Z',
      clientMutationId: 'concurrent-idem-001',
    };

    const barrier = installConcurrentPrecheckBarrier();
    const [r1, r2] = await Promise.all([post('/expenses', payload), post('/expenses', payload)]);

    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 201]);
    expect([r1.body.data.deduplicated, r2.body.data.deduplicated].sort()).toEqual([false, true]);
    expect(r1.body.data.expense.id).toBe(r2.body.data.expense.id);
    expect(r1.body.data.expense.payments).toHaveLength(1);
    expect(r2.body.data.expense.payments).toHaveLength(1);
    expect(r1.body.data.expense.shares).toHaveLength(2);
    expect(r2.body.data.expense.shares).toHaveLength(2);
    expect(barrier.recordedCalls.some((c) => c.phase === 'recovery')).toBe(true);

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(2);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 5. Concurrent requests with same key but different payloads
  // ---------------------------------------------------------------------------
  it('5. concurrent conflicting requests with same clientMutationId allow one winner (201) and reject loser (409) with zero orphans', async () => {
    const { aarav, bina } = fx.ids;
    const payloadA = {
      title: 'Hotel Room A',
      category: 'ACCOMMODATION',
      amountPaisa: 300000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 300000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'concurrent-conflict-001',
    };
    const payloadB = {
      title: 'Hotel Suite B',
      category: 'ACCOMMODATION',
      amountPaisa: 800000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: bina, amountPaisa: 800000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'concurrent-conflict-001',
    };

    const barrier5 = installConcurrentPrecheckBarrier();
    const [r1, r2] = await Promise.all([post('/expenses', payloadA), post('/expenses', payloadB)]);
    vi.restoreAllMocks();

    const sorted = [r1, r2].sort((a, b) => a.status - b.status);
    expect(sorted[0].status).toBe(201);
    expect(sorted[0].body.data.deduplicated).toBe(false);
    expect(sorted[1].status).toBe(409);
    expect(sorted[1].body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(sorted[1].body.data).toBeUndefined();

    const recoveryLookups = barrier5.recordedCalls.filter((c) => c.phase === 'recovery');
    expect(recoveryLookups.length).toBeGreaterThanOrEqual(1);

    const winnerAmount = sorted[0].body.data.expense.amountPaisa as number;
    expect([300000, 800000]).toContain(winnerAmount);
    expect(sorted[0].body.data.ledger.totalApprovedExpensePaisa).toBe(winnerAmount);

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(2);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 6. Multiple ordinary expenses without clientMutationId
  // ---------------------------------------------------------------------------
  it('6. multiple ordinary expenses omitting clientMutationId (or whitespace-only) succeed under the partial unique index', async () => {
    const indexes = await ExpenseModel.collection.indexes();
    const mutationIdx = indexes.find((idx) => idx.name === EXPENSE_MUTATION_ID_INDEX_NAME);
    expect(mutationIdx?.unique).toBe(true);
    expect(mutationIdx?.partialFilterExpression).toEqual({
      clientMutationId: { $type: 'string', $gt: '' },
    });

    const { aarav, bina } = fx.ids;
    const base = {
      category: 'FOOD_DRINKS',
      amountPaisa: 50000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 50000 }],
      includedParticipantIds: [aarav, bina],
    };

    const e1 = await post('/expenses', { ...base, title: 'Tea 1' });
    const e2 = await post('/expenses', { ...base, title: 'Tea 2' });
    const e3 = await post('/expenses', { ...base, title: 'Tea 3', clientMutationId: '   ' });

    expect(e1.status).toBe(201);
    expect(e2.status).toBe(201);
    expect(e3.status).toBe(201);
    expect(new Set([e1.body.data.expense.id, e2.body.data.expense.id, e3.body.data.expense.id]).size).toBe(3);

    const e3Doc = await ExpenseModel.findById(e3.body.data.expense.id).lean();
    expect(e3Doc?.clientMutationId).toBeUndefined();

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(3);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(3);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(6);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 7. No orphaned payments/shares after failed transactions & safe retry
  // ---------------------------------------------------------------------------
  it('7. failed expense transaction leaves no orphaned payments/shares/key and permits subsequent retry with the same clientMutationId', async () => {
    const { aarav, bina } = fx.ids;
    const payload = {
      title: 'Retryable After Failure',
      category: 'MISCELLANEOUS',
      amountPaisa: 120000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 120000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'retry-after-rollback-001',
    };

    vi.spyOn(ExpenseShareModel, 'insertMany').mockRejectedValueOnce(
      new Error('Simulated downstream share failure')
    );

    const failed = await post('/expenses', payload);
    expect(failed.status).toBeGreaterThanOrEqual(400);

    // Rolled back cleanly: no Expense holding the clientMutationId, no orphaned payment/share/activity
    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(0);

    // Retrying with the exact same clientMutationId now succeeds cleanly as the first committed creation
    const retried = await post('/expenses', payload);
    expect(retried.status).toBe(201);
    expect(retried.body.data.deduplicated).toBe(false);
    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(2);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 8. Real MongoDB replica-set integration test proving true ACID concurrency
  // ---------------------------------------------------------------------------
  it('8. real replica-set integration test enforces ACID concurrent E11000 handling and recovers outside aborted sessions', async () => {
    let replicaSet: { cleanup: () => Promise<void> } | null = null;

    try {
      replicaSet = await startOrConnectReplicaSet();
      expect(await supportsTransactions()).toBe(true);
      process.env.MONGO_TRANSACTIONS = 'required';
      await ExpenseModel.createIndexes();

      const regOrg = await request(app).post('/api/v1/auth/register').send({
        name: 'Aarav Replica',
        email: 'aarav.replidem@example.com',
        password: 'Password123',
      });
      orgToken = regOrg.body.data.accessToken as string;

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set(auth())
        .send({ name: 'Langtang Replica Trip', mode: 'FAMILY', organizerFamilyName: 'Sharma Family' });
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

      // 8a. Concurrent identical requests under real withTransaction + barrier-forced E11000
      const identicalPayload = {
        title: 'Kyanjin Gompa Stay',
        category: 'ACCOMMODATION',
        amountPaisa: 600000,
        splitMethod: 'EQUAL',
        payments: [{ participantId: aarav, amountPaisa: 600000 }],
        includedParticipantIds: [aarav, bina],
        clientMutationId: 'replset-concurrent-idem-001',
      };

      const barrierA = installConcurrentPrecheckBarrier();
      const [idR1, idR2] = await Promise.all([
        post('/expenses', identicalPayload),
        post('/expenses', identicalPayload),
      ]);
      vi.restoreAllMocks();

      expect([idR1.status, idR2.status].sort((a, b) => a - b)).toEqual([200, 201]);
      expect([idR1.body.data.deduplicated, idR2.body.data.deduplicated].sort()).toEqual([false, true]);
      expect(idR1.body.data.expense.id).toBe(idR2.body.data.expense.id);

      // Recovery findOne MUST execute outside any aborted ClientSession
      const recoveryLookups = barrierA.recordedCalls.filter((c) => c.phase === 'recovery');
      expect(recoveryLookups.length).toBeGreaterThanOrEqual(1);
      for (const lookup of recoveryLookups) {
        const opts = lookup.options as { session?: unknown } | undefined;
        expect(opts?.session).toBeUndefined();
      }

      // 8b. Concurrent conflicting payloads under real withTransaction + barrier-forced E11000
      const barrierB = installConcurrentPrecheckBarrier();
      const [cR1, cR2] = await Promise.all([
        post('/expenses', {
          title: 'Guide Fee A',
          category: 'ACTIVITIES',
          amountPaisa: 400000,
          splitMethod: 'EQUAL',
          payments: [{ participantId: aarav, amountPaisa: 400000 }],
          includedParticipantIds: [aarav, bina],
          clientMutationId: 'replset-concurrent-conflict-001',
        }),
        post('/expenses', {
          title: 'Guide Fee B',
          category: 'ACTIVITIES',
          amountPaisa: 900000,
          splitMethod: 'EQUAL',
          payments: [{ participantId: bina, amountPaisa: 900000 }],
          includedParticipantIds: [aarav, bina],
          clientMutationId: 'replset-concurrent-conflict-001',
        }),
      ]);
      vi.restoreAllMocks();

      const sortedConflict = [cR1, cR2].sort((a, b) => a.status - b.status);
      expect(sortedConflict[0].status).toBe(201);
      expect(sortedConflict[0].body.data.deduplicated).toBe(false);
      expect(sortedConflict[1].status).toBe(409);
      expect(sortedConflict[1].body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(sortedConflict[1].body.data).toBeUndefined();

      const recoveryConflictLookups = barrierB.recordedCalls.filter((c) => c.phase === 'recovery');
      expect(recoveryConflictLookups.length).toBeGreaterThanOrEqual(1);
      for (const lookup of recoveryConflictLookups) {
        const opts = lookup.options as { session?: unknown } | undefined;
        expect(opts?.session).toBeUndefined();
      }

      // Immediate post-conflict counts must equal exactly 2 expenses (8a winner + 8b winner)
      expect(await ExpenseModel.countDocuments({ tripId })).toBe(2);
      expect(await ExpensePaymentModel.countDocuments({ tripId })).toBe(2);
      expect(await ExpenseShareModel.countDocuments({ tripId })).toBe(4);
      expect(
        await ActivityLogModel.countDocuments({ tripId, actionType: 'EXPENSE_ADDED' })
      ).toBe(2);

      // 8c. Sequential retry & conflict check on real replica set
      const seqDup = await post('/expenses', identicalPayload);
      expect(seqDup.status).toBe(200);
      expect(seqDup.body.data.deduplicated).toBe(true);

      const seqDiff = await post('/expenses', {
        ...identicalPayload,
        amountPaisa: 650000,
        payments: [{ participantId: aarav, amountPaisa: 650000 }],
      });
      expect(seqDiff.status).toBe(409);
      expect(seqDiff.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      // 8d. Real replica-set mid-transaction abort leaves zero orphans and allows 201 retry with same key
      const abortRetryPayload = {
        title: 'Porters Mid-Tx Retry',
        category: 'ACCOMMODATION',
        amountPaisa: 300000,
        splitMethod: 'EQUAL',
        payments: [{ participantId: aarav, amountPaisa: 300000 }],
        includedParticipantIds: [aarav, bina],
        clientMutationId: 'replset-mid-tx-retry-001',
      };
      vi.spyOn(ExpenseShareModel, 'insertMany').mockRejectedValueOnce(
        new Error('Simulated replica-set mid-transaction failure')
      );
      const abortedRes = await post('/expenses', abortRetryPayload);
      expect(abortedRes.status).toBeGreaterThanOrEqual(400);
      vi.restoreAllMocks();

      expect(await ExpenseModel.countDocuments({ tripId })).toBe(2);
      expect(await ExpensePaymentModel.countDocuments({ tripId })).toBe(2);
      expect(await ExpenseShareModel.countDocuments({ tripId })).toBe(4);
      expect(
        await ActivityLogModel.countDocuments({ tripId, actionType: 'EXPENSE_ADDED' })
      ).toBe(2);

      const postAbortRetry = await post('/expenses', abortRetryPayload);
      expect(postAbortRetry.status).toBe(201);
      expect(postAbortRetry.body.data.deduplicated).toBe(false);

      expect(await ExpenseModel.countDocuments({ tripId })).toBe(3);
      expect(await ExpensePaymentModel.countDocuments({ tripId })).toBe(3);
      expect(await ExpenseShareModel.countDocuments({ tripId })).toBe(6);
      expect(
        await ActivityLogModel.countDocuments({ tripId, actionType: 'EXPENSE_ADDED' })
      ).toBe(3);
      await expectInvariants();
    } finally {
      vi.restoreAllMocks();
      delete process.env.MONGO_TRANSACTIONS;
      if (replicaSet) {
        await replicaSet.cleanup();
      } else {
        await disconnectDatabase();
      }
      await connectDatabase(TEST_DB_URI);
    }
  }, 60000);

  // ---------------------------------------------------------------------------
  // 9. Authorization isolation, cross-trip key scoping, & stale offline retry safety
  // ---------------------------------------------------------------------------
  it('9. preserves trip/actor authorization boundaries, scopes keys per trip, and keeps stale retries idempotent after approval', async () => {
    const { aarav, bina, dipesh } = fx.ids;

    // Estimated expense recorded by Organizer with offline clientMutationId
    const estPayload = {
      title: 'Estimated Jeep Fare',
      category: 'TRANSPORTATION',
      amountPaisa: 200000,
      isEstimated: true,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 200000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'auth-and-stale-001',
    };

    const created = await post('/expenses', estPayload, orgToken);
    expect(created.status).toBe(201);
    const expenseId = created.body.data.expense.id as string;

    // 9a. Outsider (403 FORBIDDEN_TRIP_ACCESS) and read-only PARTICIPANT (403 INSUFFICIENT_ROLE) cannot probe idempotency keys
    const outsiderRes = await post('/expenses', estPayload, outsiderToken);
    expect(outsiderRes.status).toBe(403);
    expect(outsiderRes.body.error.code).toBe('FORBIDDEN_TRIP_ACCESS');

    const memberRes = await post('/expenses', estPayload, memberToken);
    expect(memberRes.status).toBe(403);
    expect(memberRes.body.error.code).toBe('INSUFFICIENT_ROLE');

    // 9b. Different contributor within the same trip sending the organizer's key cannot impersonate or retrieve it
    const otherActorSameKey = await post('/expenses', estPayload, contribToken);
    expect(otherActorSameKey.status).toBe(409);
    expect(otherActorSameKey.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // 9c. Same clientMutationId on a DIFFERENT trip is completely independent
    const otherTripOwnerRes = await request(app)
      .post(`/api/v1/trips/${fx.otherTripId}/expenses`)
      .set(auth(orgToken))
      .send({
        title: 'Rara Boat Ride',
        category: 'TRANSPORTATION',
        amountPaisa: 150000,
        splitMethod: 'EQUAL',
        payments: [
          {
            participantId: (
              await request(app).get(`/api/v1/trips/${fx.otherTripId}`).set(auth(orgToken))
            ).body.data.myParticipant.id,
            amountPaisa: 150000,
          },
        ],
        clientMutationId: 'auth-and-stale-001',
      });
    expect(otherTripOwnerRes.status).toBe(201);
    expect(otherTripOwnerRes.body.data.deduplicated).toBe(false);

    // 9d. Confirm/adjust the estimated expense (Task 1 flow), then replay the original creation payload:
    // Because immutable idempotencyHash captures creation inputs, the stale retry deduplicates safely instead of creating a duplicate
    const confirmRes = await post(`/expenses/${expenseId}/approve`, {
      approvalStatus: 'APPROVED',
      actualAmountPaisa: 260000,
    });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.expense.amountPaisa).toBe(260000);

    const staleRetry = await post('/expenses', estPayload, orgToken);
    expect(staleRetry.status).toBe(200);
    expect(staleRetry.body.data.deduplicated).toBe(true);
    expect(staleRetry.body.data.expense.id).toBe(expenseId);
    expect(staleRetry.body.data.expense.amountPaisa).toBe(260000);

    // 9e. Contributor submits an expense, organizer rejects, verify invariants across everything
    const contribRes = await post(
      '/expenses',
      {
        title: 'Dipesh Snacks',
        category: 'SNACKS_WATER',
        amountPaisa: 80000,
        splitMethod: 'PER_FAMILY',
        payments: [{ participantId: dipesh, amountPaisa: 80000 }],
        clientMutationId: 'contrib-idem-001',
      },
      contribToken
    );
    expect(contribRes.status).toBe(201);

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(2);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 10. Priority 1: retries remain idempotent across mutable roster/weight/family/closed-trip state
  // ---------------------------------------------------------------------------
  it('10. preserves idempotent retries after deactivation, roster additions, weight/family changes, and closed trip while still blocking invalid new expenses', async () => {
    const { aarav, bina } = fx.ids;
    const { sharma, thapa } = fx.famIds;

    // 10a. Omitted-default EQUAL expense + PER_FAMILY + WEIGHTED created before mutations
    const equalOmittedPayload = {
      title: 'Morning Coffee',
      category: 'FOOD_DRINKS',
      amountPaisa: 40000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 40000 }],
      clientMutationId: 'mut-state-equal-omitted',
    };
    const equalExplicitPayload = {
      title: 'Lunch Dal Bhat',
      category: 'FOOD_DRINKS',
      amountPaisa: 60000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 60000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'mut-state-equal-bina',
    };
    const weightedOmittedPayload = {
      title: 'Weights Tea',
      category: 'FOOD_DRINKS',
      amountPaisa: 80000,
      splitMethod: 'WEIGHTED',
      payments: [{ participantId: aarav, amountPaisa: 80000 }],
      clientMutationId: 'mut-state-weighted',
    };
    const perFamilyOmittedPayload = {
      title: 'Shared Cab',
      category: 'TRANSPORTATION',
      amountPaisa: 120000,
      splitMethod: 'PER_FAMILY',
      payments: [{ participantId: aarav, amountPaisa: 120000 }],
      clientMutationId: 'mut-state-per-family',
    };

    const [rEqOm, rEqEx, rWt, rFam] = await Promise.all([
      post('/expenses', equalOmittedPayload),
      post('/expenses', equalExplicitPayload),
      post('/expenses', weightedOmittedPayload),
      post('/expenses', perFamilyOmittedPayload),
    ]);
    expect(rEqOm.status).toBe(201);
    expect(rEqEx.status).toBe(201);
    expect(rWt.status).toBe(201);
    expect(rFam.status).toBe(201);
    const originalOmittedShareCount = rEqOm.body.data.expense.shares.length as number;

    // Mutate roster & weights AFTER expenses were already committed:
    // 1) Add new participant
    const addRes = await request(app)
      .post(`/api/v1/trips/${fx.tripId}/participants`)
      .set(auth(orgToken))
      .send({ name: 'Chitra Sharma', familyId: sharma, role: 'PARTICIPANT', memberType: 'ADULT' });
    expect(addRes.status).toBe(201);

    // 2) Mutate Bina's defaultWeight, reassign familyId, and deactivate Bina
    const patchBinaRes = await request(app)
      .patch(`/api/v1/trips/${fx.tripId}/participants/${bina}`)
      .set(auth(orgToken))
      .send({ defaultWeight: 5, familyId: thapa, isActive: false });
    expect(patchBinaRes.status).toBe(200);

    // 3) Mutate Thapa family's defaultWeight
    const patchFamRes = await request(app)
      .patch(`/api/v1/trips/${fx.tripId}/families/${thapa}`)
      .set(auth(orgToken))
      .send({ defaultWeight: 4 });
    expect(patchFamRes.status).toBe(200);

    // Exact retries for ALL four expenses must return 200 deduplicated: true with unchanged share counts
    const [retryEqOm, retryEqEx, retryWt, retryFam] = await Promise.all([
      post('/expenses', equalOmittedPayload),
      post('/expenses', equalExplicitPayload),
      post('/expenses', weightedOmittedPayload),
      post('/expenses', perFamilyOmittedPayload),
    ]);
    expect(retryEqOm.status).toBe(200);
    expect(retryEqOm.body.data.deduplicated).toBe(true);
    expect(retryEqOm.body.data.expense.id).toBe(rEqOm.body.data.expense.id);
    expect(retryEqOm.body.data.expense.shares.length).toBe(originalOmittedShareCount);

    expect(retryEqEx.status).toBe(200);
    expect(retryEqEx.body.data.deduplicated).toBe(true);
    expect(retryEqEx.body.data.expense.id).toBe(rEqEx.body.data.expense.id);

    expect(retryWt.status).toBe(200);
    expect(retryWt.body.data.deduplicated).toBe(true);
    expect(retryWt.body.data.expense.id).toBe(rWt.body.data.expense.id);

    expect(retryFam.status).toBe(200);
    expect(retryFam.body.data.deduplicated).toBe(true);
    expect(retryFam.body.data.expense.id).toBe(rFam.body.data.expense.id);

    // Conflicting retry against deactivated expense must still return 409 IDEMPOTENCY_KEY_REUSED
    const conflictAfterMutation = await post('/expenses', {
      ...equalExplicitPayload,
      amountPaisa: 65000,
      payments: [{ participantId: aarav, amountPaisa: 65000 }],
    });
    expect(conflictAfterMutation.status).toBe(409);
    expect(conflictAfterMutation.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // New submissions referencing deactivated Bina or a foreign participant must STILL fail validation (400)
    const newWithInactivePayer = await post('/expenses', {
      ...equalExplicitPayload,
      payments: [{ participantId: bina, amountPaisa: 60000 }],
      clientMutationId: 'new-inactive-payer-err',
    });
    expect(newWithInactivePayer.status).toBe(400);

    const newWithInactiveIncluded = await post('/expenses', {
      ...equalExplicitPayload,
      clientMutationId: 'new-inactive-included-err',
    });
    expect(newWithInactiveIncluded.status).toBe(400);

    const otherTrip = await request(app)
      .get(`/api/v1/trips/${fx.otherTripId}`)
      .set(auth(orgToken));
    const foreignParticipantId = otherTrip.body.data.myParticipant.id as string;
    const newWithForeign = await post('/expenses', {
      ...equalExplicitPayload,
      payments: [{ participantId: foreignParticipantId, amountPaisa: 60000 }],
      includedParticipantIds: [aarav, foreignParticipantId],
      clientMutationId: 'new-foreign-part-err',
    });
    expect(newWithForeign.status).toBe(400);

    // Closing the trip still lets valid offline retries deduplicate (200) while blocking new expenses (400 TRIP_CLOSED)
    const closeRes = await request(app)
      .post(`/api/v1/trips/${fx.tripId}/close`)
      .set(auth(orgToken))
      .send({ forceClose: true });
    expect(closeRes.status).toBe(200);

    const retryClosed = await post('/expenses', equalExplicitPayload);
    expect(retryClosed.status).toBe(200);
    expect(retryClosed.body.data.deduplicated).toBe(true);

    const newClosed = await post('/expenses', {
      title: 'Too Late After Close',
      category: 'FOOD_DRINKS',
      amountPaisa: 25000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 25000 }],
      includedParticipantIds: [aarav],
      clientMutationId: 'new-closed-trip-err',
    });
    expect(newClosed.status).toBe(400);
    expect(newClosed.body.error.code).toBe('TRIP_CLOSED');

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(4);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 11. Priority 1: actor role promotion vs demotion
  // ---------------------------------------------------------------------------
  it('11. keeps retry idempotent when contributor is promoted to organizer, and denies demoted read-only participant with 403', async () => {
    const { aarav, dipesh } = fx.ids;

    const contribPayload = {
      title: 'Dipesh Trail Snacks',
      category: 'SNACKS_WATER',
      amountPaisa: 90000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: dipesh, amountPaisa: 90000 }],
      includedParticipantIds: [aarav, dipesh],
      clientMutationId: 'role-mutation-001',
    };

    const created = await post('/expenses', contribPayload, contribToken);
    expect(created.status).toBe(201);
    expect(created.body.data.expense.approvalStatus).toBe('PENDING_APPROVAL');
    const expenseId = created.body.data.expense.id as string;

    // Promote Dipesh from CONTRIBUTOR to ORGANIZER via verified ParticipantInvite
    const inviteRes = await request(app)
      .post(`/api/v1/trips/${fx.tripId}/participants/${dipesh}/invites`)
      .set(auth(orgToken))
      .send({ grantedRole: 'ORGANIZER', intendedEmail: 'dipesh.idem@example.com' });
    expect(inviteRes.status).toBe(201);

    const claimRes = await request(app)
      .post('/api/v1/trips/invites/claim')
      .set(auth(contribToken))
      .send({ token: inviteRes.body.data.rawToken as string });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.data.role).toBe('ORGANIZER');

    // Retrying must still return 200 deduplicated: true even though new expenses by ORGANIZER would auto-approve
    const retryPromoted = await post('/expenses', contribPayload, contribToken);
    expect(retryPromoted.status).toBe(200);
    expect(retryPromoted.body.data.deduplicated).toBe(true);
    expect(retryPromoted.body.data.expense.id).toBe(expenseId);
    expect(retryPromoted.body.data.expense.approvalStatus).toBe('PENDING_APPROVAL');

    // Demote Dipesh to read-only PARTICIPANT
    const demoteRes = await request(app)
      .patch(`/api/v1/trips/${fx.tripId}/participants/${dipesh}`)
      .set(auth(orgToken))
      .send({ role: 'PARTICIPANT' });
    expect(demoteRes.status).toBe(200);

    // Demoted actor must be blocked by RBAC with 403 INSUFFICIENT_ROLE
    const retryDemoted = await post('/expenses', contribPayload, contribToken);
    expect(retryDemoted.status).toBe(403);
    expect(retryDemoted.body.error.code).toBe('INSUFFICIENT_ROLE');

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 12. Priority 2: incomplete standalone Expense record returns 503 IDEMPOTENCY_INCOMPLETE
  // ---------------------------------------------------------------------------
  it('12. returns retryable 503 IDEMPOTENCY_INCOMPLETE instead of 200 when existing Expense lacks payments/shares after bounded wait', async () => {
    const { aarav, bina } = fx.ids;
    const payload = {
      title: 'Orphaned Incomplete Parent',
      category: 'MISCELLANEOUS' as const,
      amountPaisa: 75000,
      splitMethod: 'EQUAL' as const,
      payments: [{ participantId: aarav, amountPaisa: 75000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'incomplete-standalone-001',
    };

    const expectedHash = computeExpenseIdempotencyHash({
      tripId: fx.tripId,
      actorParticipantId: aarav,
      title: payload.title,
      category: payload.category,
      amountPaisa: payload.amountPaisa,
      isEstimated: false,
      isPackage: false,
      splitMethod: payload.splitMethod,
      paymentMethod: 'CASH',
      explicitIncurredAtIso: null,
      payments: payload.payments,
      includedParticipantIds: payload.includedParticipantIds,
    });

    // Simulate a stalled standalone write that inserted parent Expense before child payments/shares
    await ExpenseModel.create({
      tripId: fx.tripId,
      createdByParticipantId: aarav,
      title: payload.title,
      category: payload.category,
      amountPaisa: payload.amountPaisa,
      isEstimated: false,
      isPackage: false,
      splitMethod: payload.splitMethod,
      paymentMethod: 'CASH',
      approvalStatus: 'APPROVED',
      incurredAt: new Date(),
      clientMutationId: payload.clientMutationId,
      idempotencyHash: expectedHash,
      isDeleted: false,
    });

    const retryRes = await post('/expenses', payload, orgToken);
    expect(retryRes.status).toBe(503);
    expect(retryRes.body.error.code).toBe('IDEMPOTENCY_INCOMPLETE');
    expect(retryRes.body.data).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 13. Priority 2: standalone concurrent winner rollback returns clean 503 IDEMPOTENCY_CONCURRENT_RETRY
  // ---------------------------------------------------------------------------
  it('13. maps standalone E11000 after concurrent winner rollback to 503 IDEMPOTENCY_CONCURRENT_RETRY without leaking raw E11000', async () => {
    const { aarav, bina } = fx.ids;
    const payload = {
      title: 'Race Winner Compensation',
      category: 'TRANSPORTATION',
      amountPaisa: 180000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 180000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'concurrent-winner-rollback-001',
    };

    installConcurrentPrecheckBarrier();

    let releaseWinnerFailure!: () => void;
    const loserObservedE11000 = new Promise<void>((resolve) => {
      releaseWinnerFailure = resolve;
    });

    const origCreate = ExpenseModel.create.bind(ExpenseModel);
    vi.spyOn(ExpenseModel, 'create').mockImplementation((async (...args: unknown[]) => {
      try {
        return await (origCreate as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          releaseWinnerFailure();
        }
        throw err;
      }
    }) as typeof ExpenseModel.create);

    vi.spyOn(ExpenseShareModel, 'insertMany').mockImplementationOnce((async () => {
      await Promise.race([
        loserObservedE11000,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Barrier timeout')), 3000)),
      ]);
      throw new Error('Simulated standalone winner share write failure');
    }) as never);

    const [resA, resB] = await Promise.all([post('/expenses', payload), post('/expenses', payload)]);
    vi.restoreAllMocks();

    const loser = [resA, resB].find((r) => r.status === 503);
    expect(loser).toBeDefined();
    expect(loser!.status).toBe(503);
    expect(loser!.body.error.code).toBe('IDEMPOTENCY_CONCURRENT_RETRY');
    expect(String(loser!.body.error.message)).not.toMatch(/E11000|duplicate key/i);
    expect(loser!.body.data).toBeUndefined();

    // Standalone rollback cleaned everything cleanly
    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(0);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(0);

    // Subsequent retry creates the expense cleanly
    const retryAfter = await post('/expenses', payload);
    expect(retryAfter.status).toBe(201);
    expect(retryAfter.body.data.deduplicated).toBe(false);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 14. Priority 3: legacy !idempotencyHash compatibility & safe failure
  // ---------------------------------------------------------------------------
  it('14. handles legacy expenses missing idempotencyHash safely for PER_FAMILY, PACKAGE, and matchesLegacyExpenseRecord edge cases', async () => {
    const { aarav, bina } = fx.ids;
    const { sharma, thapa } = fx.famIds;

    // 14a. Legacy PER_FAMILY created before idempotencyHash / splitConfig
    const perFamilyPayload = {
      title: 'Legacy Family Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 120000,
      splitMethod: 'PER_FAMILY' as const,
      payments: [{ participantId: aarav, amountPaisa: 120000 }],
      clientMutationId: 'legacy-per-family-001',
    };
    const famCreated = await post('/expenses', perFamilyPayload);
    expect(famCreated.status).toBe(201);
    const famExpenseId = famCreated.body.data.expense.id as string;

    // Strip idempotencyHash and splitConfig to simulate a pre-Task-4 PER_FAMILY record
    await ExpenseModel.updateOne(
      { _id: famExpenseId },
      { $unset: { idempotencyHash: 1, splitConfig: 1 } }
    );

    // Retrying with omitted family filters must return 200 deduplicated: true (fixes false 409)
    const famRetryOmitted = await post('/expenses', perFamilyPayload);
    expect(famRetryOmitted.status).toBe(200);
    expect(famRetryOmitted.body.data.deduplicated).toBe(true);
    expect(famRetryOmitted.body.data.expense.id).toBe(famExpenseId);

    // Retrying the legacy PER_FAMILY record with explicit family selection must fail safely with 409
    const famRetryExplicit = await post('/expenses', {
      ...perFamilyPayload,
      includedFamilyIds: [sharma, thapa],
    });
    expect(famRetryExplicit.status).toBe(409);
    expect(famRetryExplicit.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Direct unit assertions on matchesLegacyExpenseRecord
    const tripData = await getTrip();
    const famRecord = tripData.expenses.find((e: { id: string }) => e.id === famExpenseId);
    const baseCanonical = {
      tripId: fx.tripId,
      actorParticipantId: aarav,
      title: perFamilyPayload.title,
      category: 'FOOD_DRINKS' as const,
      amountPaisa: 120000,
      isEstimated: false,
      isPackage: false,
      splitMethod: 'PER_FAMILY' as const,
      paymentMethod: 'CASH' as const,
      explicitIncurredAtIso: null,
      payments: perFamilyPayload.payments,
    };
    const computedLegacyState = {
      approvalStatus: famRecord.approvalStatus,
      computedShares: famRecord.shares,
    };
    expect(matchesLegacyExpenseRecord(famRecord, baseCanonical, computedLegacyState)).toBe(true);
    expect(
      matchesLegacyExpenseRecord(
        famRecord,
        { ...baseCanonical, includedFamilyIds: [sharma] },
        computedLegacyState
      )
    ).toBe(false);
    expect(
      matchesLegacyExpenseRecord(
        famRecord,
        { ...baseCanonical, includedParticipantIds: [aarav] },
        computedLegacyState
      )
    ).toBe(false);

    // 14b. Legacy PACKAGE record lacking packageConfig rejects retry specifying packageRatePerPersonPaisa with 409
    const pkgPayload = {
      title: 'Legacy Muktinath Package',
      category: 'PACKAGE',
      amountPaisa: 200000,
      isPackage: true,
      packageRatePerPersonPaisa: 50000,
      splitMethod: 'PACKAGE' as const,
      payments: [{ participantId: aarav, amountPaisa: 200000 }],
      clientMutationId: 'legacy-package-001',
    };
    const pkgCreated = await post('/expenses', pkgPayload);
    expect(pkgCreated.status).toBe(201);
    const pkgExpenseId = pkgCreated.body.data.expense.id as string;
    await ExpenseModel.updateOne(
      { _id: pkgExpenseId },
      { $unset: { idempotencyHash: 1, packageConfig: 1 } }
    );

    const pkgConflict = await post('/expenses', pkgPayload);
    expect(pkgConflict.status).toBe(409);
    expect(pkgConflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // 14c. Legacy CUSTOM expense ignores order & zero-paisa entries via matchesLegacyExpenseRecord
    const customPayload = {
      title: 'Legacy Custom Split',
      category: 'SHOPPING',
      amountPaisa: 100000,
      splitMethod: 'CUSTOM' as const,
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      customShares: [
        { participantId: aarav, amountPaisa: 70000 },
        { participantId: bina, amountPaisa: 30000 },
      ],
      clientMutationId: 'legacy-custom-001',
    };
    const customCreated = await post('/expenses', customPayload);
    expect(customCreated.status).toBe(201);
    const customId = customCreated.body.data.expense.id as string;
    await ExpenseModel.updateOne({ _id: customId }, { $unset: { idempotencyHash: 1 } });

    const customRetry = await post('/expenses', {
      ...customPayload,
      customShares: [
        { participantId: bina, amountPaisa: 30000 },
        { participantId: aarav, amountPaisa: 70000 },
      ],
    });
    expect(customRetry.status).toBe(200);
    expect(customRetry.body.data.deduplicated).toBe(true);

    const customConflict = await post('/expenses', {
      ...customPayload,
      customShares: [
        { participantId: aarav, amountPaisa: 60000 },
        { participantId: bina, amountPaisa: 40000 },
      ],
    });
    expect(customConflict.status).toBe(409);
    expect(customConflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // ---------------------------------------------------------------------------
  // 15. Priority 5: incurredAt timezone equivalence, deduplication, & unexpected error propagation
  // ---------------------------------------------------------------------------
  it('15. canonicalizes incurredAt timezones and duplicate arrays, rejects omitted-vs-explicit incurredAt, and propagates non-E11000 recovery errors', async () => {
    const { aarav, bina } = fx.ids;
    const { sharma, thapa } = fx.famIds;

    // 15a. Explicit incurredAt: UTC vs +05:45 offset representing identical instant deduplicates
    const tzPayload1 = {
      title: 'Mountain Breakfast',
      category: 'FOOD_DRINKS',
      amountPaisa: 45000,
      splitMethod: 'PER_FAMILY',
      incurredAt: '2026-07-01T10:00:00.000Z',
      includedFamilyIds: [thapa, sharma, sharma],
      payments: [{ participantId: aarav, amountPaisa: 45000 }],
      clientMutationId: 'canon-tz-and-dedup-001',
    };
    const tzCreated = await post('/expenses', tzPayload1);
    expect(tzCreated.status).toBe(201);

    const tzRetrySameInstant = await post('/expenses', {
      ...tzPayload1,
      incurredAt: '2026-07-01T15:45:00.000+05:45',
      includedFamilyIds: [sharma, thapa],
    });
    expect(tzRetrySameInstant.status).toBe(200);
    expect(tzRetrySameInstant.body.data.deduplicated).toBe(true);

    // Omitted incurredAt against explicit original incurredAt rejects 409
    const { incurredAt: _omitted, ...withoutIncurredAt } = tzPayload1;
    const tzRetryOmitted = await post('/expenses', withoutIncurredAt);
    expect(tzRetryOmitted.status).toBe(409);
    expect(tzRetryOmitted.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Duplicate weights use deterministic last-wins normalization
    const hashWithDupWeights = computeExpenseIdempotencyHash({
      tripId: fx.tripId,
      actorParticipantId: aarav,
      title: 'Weighted Test',
      category: 'FOOD_DRINKS',
      amountPaisa: 30000,
      isEstimated: false,
      isPackage: false,
      splitMethod: 'WEIGHTED',
      paymentMethod: 'CASH',
      explicitIncurredAtIso: null,
      payments: [{ participantId: aarav, amountPaisa: 30000 }],
      weights: [
        { participantId: bina, weight: 1 },
        { participantId: bina, weight: 3 },
        { participantId: aarav, weight: 2 },
      ],
    });
    const hashCleanWeights = computeExpenseIdempotencyHash({
      tripId: fx.tripId,
      actorParticipantId: aarav,
      title: 'Weighted Test',
      category: 'FOOD_DRINKS',
      amountPaisa: 30000,
      isEstimated: false,
      isPackage: false,
      splitMethod: 'WEIGHTED',
      paymentMethod: 'CASH',
      explicitIncurredAtIso: null,
      payments: [{ participantId: aarav, amountPaisa: 30000 }],
      weights: [
        { participantId: aarav, weight: 2 },
        { participantId: bina, weight: 3 },
      ],
    });
    expect(hashWithDupWeights).toBe(hashCleanWeights);

    // 15b. Unexpected non-E11000 DB failure during concurrent recovery must propagate (never 200 or false 409)
    const origFindOne = ExpenseModel.findOne.bind(ExpenseModel);
    let lookupCount = 0;
    let releasePrechecks!: () => void;
    const bothPrechecksDone = new Promise<void>((resolve) => {
      releasePrechecks = resolve;
    });
    vi.spyOn(ExpenseModel, 'findOne').mockImplementation(((
      filter?: unknown,
      projection?: unknown,
      options?: unknown
    ) => {
      const isIdem =
        typeof filter === 'object' &&
        filter !== null &&
        'clientMutationId' in (filter as Record<string, unknown>);
      if (!isIdem) {
        return origFindOne(filter as never, projection as never, options as never);
      }
      const q = origFindOne(filter as never, projection as never, options as never);
      const execOrig = q.exec.bind(q);
      q.exec = async () => {
        const idx = ++lookupCount;
        if (idx === 3) {
          throw new Error('Simulated recovery socket timeout');
        }
        const doc = await execOrig();
        if (idx === 1) {
          await bothPrechecksDone;
        } else if (idx === 2) {
          releasePrechecks();
        }
        return doc;
      };
      return q;
    }) as typeof ExpenseModel.findOne);

    const racePayload = {
      title: 'Recovery Error Propagation',
      category: 'FOOD_DRINKS',
      amountPaisa: 50000,
      splitMethod: 'EQUAL',
      payments: [{ participantId: aarav, amountPaisa: 50000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'recovery-non-11000-err-001',
    };
    const [errR1, errR2] = await Promise.all([
      post('/expenses', racePayload),
      post('/expenses', racePayload),
    ]);
    vi.restoreAllMocks();

    const orderedErr = [errR1, errR2].sort((a, b) => a.status - b.status);
    expect(orderedErr[0].status).toBe(201);
    expect(orderedErr[1].status).toBeGreaterThanOrEqual(400);
    expect(orderedErr[1].status).not.toBe(409);
    expect(orderedErr[1].body.error.code).not.toBe('IDEMPOTENCY_KEY_REUSED');
  });

  // ---------------------------------------------------------------------------
  // 16. Priority 4: repeatable index migration from legacy sparse index to partial unique index
  // ---------------------------------------------------------------------------
  it('16. migrates legacy sparse index safely, audits duplicates before mutation, cleans null/empty keys, preserves unrelated indexes, and stays idempotent', async () => {
    const col = ExpenseModel.collection;

    // Reset collection indexes to simulate a pre-Task-4 production database
    await ExpenseModel.deleteMany({});
    try {
      await col.dropIndex(EXPENSE_MUTATION_ID_INDEX_NAME);
    } catch {
      // Ignore if absent
    }

    // Create an unrelated custom index to verify the migration preserves non-target indexes
    await col.createIndex({ title: 1 }, { name: 'custom_title_idx' });

    const fakeTripA = new mongoose.Types.ObjectId();
    const fakeParticipant = new mongoose.Types.ObjectId();
    const baseRawDoc = {
      tripId: fakeTripA,
      createdByParticipantId: fakeParticipant,
      title: 'Legacy Raw Expense',
      category: 'FOOD_DRINKS',
      amountPaisa: 10000,
      isEstimated: false,
      isPackage: false,
      splitMethod: 'EQUAL',
      paymentMethod: 'CASH',
      approvalStatus: 'APPROVED',
      incurredAt: new Date(),
      isDeleted: false,
    };

    // First verify duplicate-key audit aborts safely without changing indexes when duplicates exist
    await col.insertMany([
      { ...baseRawDoc, clientMutationId: 'dup-prod-key' },
      { ...baseRawDoc, clientMutationId: 'dup-prod-key' },
    ]);
    await expect(migrateExpenseMutationIndex(col)).rejects.toThrow(/duplicate/i);
    const indexesAfterAbort = await col.indexes();
    expect(indexesAfterAbort.some((i) => i.name === EXPENSE_MUTATION_ID_INDEX_NAME)).toBe(false);
    expect(indexesAfterAbort.some((i) => i.name === 'custom_title_idx')).toBe(true);

    // Clean duplicates and establish the old legacy sparse unique index + dirty null/empty values
    await col.deleteMany({});
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      { unique: true, sparse: true, name: 'tripId_1_clientMutationId_1' }
    );
    await col.insertMany([
      { ...baseRawDoc, clientMutationId: '' },
      { ...baseRawDoc, clientMutationId: '   ' },
      { ...baseRawDoc, clientMutationId: null },
      { ...baseRawDoc, clientMutationId: 'keep-valid-key-1' },
    ]);

    // Run migration first time
    const report1 = await migrateExpenseMutationIndex(col);
    expect(report1.cleanedEmptyOrNullCount).toBe(3);
    expect(report1.duplicatePairs).toEqual([]);
    expect(report1.createdNewIndex).toBe(true);
    expect(report1.verifiedNewIndexReady).toBe(true);
    expect(report1.droppedLegacyIndexNames).toContain('tripId_1_clientMutationId_1');

    const indexesAfterMigrate = await col.indexes();
    const partialIdx = indexesAfterMigrate.find((i) => i.name === EXPENSE_MUTATION_ID_INDEX_NAME);
    expect(partialIdx?.unique).toBe(true);
    expect(partialIdx?.partialFilterExpression).toEqual({
      clientMutationId: { $type: 'string', $gt: '' },
    });
    expect(indexesAfterMigrate.some((i) => i.name === 'tripId_1_clientMutationId_1')).toBe(false);
    expect(indexesAfterMigrate.some((i) => i.name === 'custom_title_idx')).toBe(true);
    expect(indexesAfterMigrate.some((i) => i.name === 'tripId_1_isDeleted_1_incurredAt_-1')).toBe(true);

    // Valid clientMutationId preserved; multiple omitted/null docs can now insert cleanly
    const keptDoc = await col.findOne({ clientMutationId: 'keep-valid-key-1' });
    expect(keptDoc).not.toBeNull();
    await col.insertMany([
      { ...baseRawDoc },
      { ...baseRawDoc, clientMutationId: null },
    ]);

    // Clean newly inserted null doc before checking repeat idempotency & count
    const report2 = await migrateExpenseMutationIndex(col);
    expect(report2.cleanedEmptyOrNullCount).toBe(1);
    expect(report2.duplicatePairs).toEqual([]);
    expect(report2.createdNewIndex).toBe(false);
    expect(report2.verifiedNewIndexReady).toBe(true);
    expect(report2.droppedLegacyIndexNames).toEqual([]);

    // Cleanup custom index so beforeEach schema state remains pristine
    await col.dropIndex('custom_title_idx');
  });

  // ---------------------------------------------------------------------------
  // 17. Legacy PWA-shaped PER_FAMILY and CUSTOM retries (with includedParticipantIds)
  // ---------------------------------------------------------------------------
  it('17. supports legacy PWA-shaped PER_FAMILY and CUSTOM retries carrying includedParticipantIds while rejecting genuine conflicts', async () => {
    const { aarav, bina, dipesh, esha } = fx.ids;
    const { sharma, thapa } = fx.famIds;
    const allActiveParticipantIds = [aarav, bina, dipesh, esha];

    // 17a. Legacy PER_FAMILY with all families + PWA includedParticipantIds (post-Task-2 splitConfig, !idempotencyHash)
    const pwaPerFamilyAll = {
      title: 'PWA Legacy Family Dinner',
      category: 'FOOD_DRINKS',
      amountPaisa: 120000,
      splitMethod: 'PER_FAMILY' as const,
      paymentMethod: 'CASH' as const,
      payments: [{ participantId: aarav, amountPaisa: 120000 }],
      includedParticipantIds: allActiveParticipantIds,
      includedFamilyIds: [sharma, thapa],
      clientMutationId: 'legacy-pwa-per-family-all',
    };
    const famAllCreated = await post('/expenses', pwaPerFamilyAll);
    expect(famAllCreated.status).toBe(201);
    const famAllId = famAllCreated.body.data.expense.id as string;

    await ExpenseModel.updateOne({ _id: famAllId }, { $unset: { idempotencyHash: 1 } });

    const famAllRetry = await post('/expenses', {
      ...pwaPerFamilyAll,
      includedParticipantIds: [esha, dipesh, bina, aarav],
      includedFamilyIds: [thapa, sharma],
    });
    expect(famAllRetry.status).toBe(200);
    expect(famAllRetry.body.data.deduplicated).toBe(true);
    expect(famAllRetry.body.data.expense.id).toBe(famAllId);

    const famConflictFamilies = await post('/expenses', {
      ...pwaPerFamilyAll,
      includedFamilyIds: [sharma],
    });
    expect(famConflictFamilies.status).toBe(409);
    expect(famConflictFamilies.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const famConflictParticipants = await post('/expenses', {
      ...pwaPerFamilyAll,
      includedParticipantIds: [aarav, dipesh],
    });
    expect(famConflictParticipants.status).toBe(409);
    expect(famConflictParticipants.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const famConflictAmount = await post('/expenses', {
      ...pwaPerFamilyAll,
      amountPaisa: 150000,
      payments: [{ participantId: aarav, amountPaisa: 150000 }],
    });
    expect(famConflictAmount.status).toBe(409);
    expect(famConflictAmount.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // 17b. Legacy PER_FAMILY targeting single family while PWA includes all active participants
    const pwaPerFamilySingle = {
      title: 'PWA Legacy Sharma Only',
      category: 'ACCOMMODATION',
      amountPaisa: 80000,
      splitMethod: 'PER_FAMILY' as const,
      paymentMethod: 'CASH' as const,
      payments: [{ participantId: aarav, amountPaisa: 80000 }],
      includedParticipantIds: allActiveParticipantIds,
      includedFamilyIds: [sharma],
      clientMutationId: 'legacy-pwa-per-family-sharma',
    };
    const famSingleCreated = await post('/expenses', pwaPerFamilySingle);
    expect(famSingleCreated.status).toBe(201);
    const famSingleId = famSingleCreated.body.data.expense.id as string;

    await ExpenseModel.updateOne({ _id: famSingleId }, { $unset: { idempotencyHash: 1 } });

    const famSingleRetry = await post('/expenses', pwaPerFamilySingle);
    expect(famSingleRetry.status).toBe(200);
    expect(famSingleRetry.body.data.deduplicated).toBe(true);
    expect(famSingleRetry.body.data.expense.id).toBe(famSingleId);

    const famSingleConflict = await post('/expenses', {
      ...pwaPerFamilySingle,
      includedParticipantIds: [aarav],
    });
    expect(famSingleConflict.status).toBe(409);
    expect(famSingleConflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // 17c. Legacy CUSTOM with PWA includedParticipantIds + customShares
    const pwaCustom = {
      title: 'PWA Legacy Custom Tea',
      category: 'SHOPPING',
      amountPaisa: 100000,
      splitMethod: 'CUSTOM' as const,
      paymentMethod: 'CASH' as const,
      payments: [{ participantId: aarav, amountPaisa: 100000 }],
      includedParticipantIds: allActiveParticipantIds,
      customShares: [
        { participantId: aarav, amountPaisa: 70000 },
        { participantId: bina, amountPaisa: 30000 },
      ],
      clientMutationId: 'legacy-pwa-custom-001',
    };
    const customCreated = await post('/expenses', pwaCustom);
    expect(customCreated.status).toBe(201);
    const customId = customCreated.body.data.expense.id as string;

    await ExpenseModel.updateOne({ _id: customId }, { $unset: { idempotencyHash: 1 } });

    const customRetry = await post('/expenses', {
      ...pwaCustom,
      includedParticipantIds: [esha, dipesh, bina, aarav],
      customShares: [
        { participantId: bina, amountPaisa: 30000 },
        { participantId: aarav, amountPaisa: 70000 },
      ],
    });
    expect(customRetry.status).toBe(200);
    expect(customRetry.body.data.deduplicated).toBe(true);
    expect(customRetry.body.data.expense.id).toBe(customId);

    const customConflictAmounts = await post('/expenses', {
      ...pwaCustom,
      customShares: [
        { participantId: aarav, amountPaisa: 60000 },
        { participantId: bina, amountPaisa: 40000 },
      ],
    });
    expect(customConflictAmounts.status).toBe(409);
    expect(customConflictAmounts.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const customConflictRecipients = await post('/expenses', {
      ...pwaCustom,
      customShares: [
        { participantId: aarav, amountPaisa: 70000 },
        { participantId: dipesh, amountPaisa: 30000 },
      ],
    });
    expect(customConflictRecipients.status).toBe(409);
    expect(customConflictRecipients.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const customConflictOmittedParticipant = await post('/expenses', {
      ...pwaCustom,
      includedParticipantIds: [aarav],
    });
    expect(customConflictOmittedParticipant.status).toBe(409);
    expect(customConflictOmittedParticipant.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(3);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(3);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(8);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(3);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 18. Preserving zero-paisa share rows in legacy comparison
  // ---------------------------------------------------------------------------
  it('18. distinguishes legacy zero-paisa share recipient sets instead of stripping sharePaisa === 0 rows', async () => {
    const { aarav, bina, dipesh, esha } = fx.ids;
    // Sort lexicographically so sorted[0] always wins the sole 1 paisa tie-break
    // while multiple other recipients receive sharePaisa === 0.
    const sorted = [aarav, bina, dipesh, esha].sort((a, b) => a.localeCompare(b));
    const [pWinner, pZero1, pZero2, pZero3] = sorted;

    const tinyPayload = {
      title: 'One Paisa Allocation',
      category: 'MISCELLANEOUS',
      amountPaisa: 1,
      splitMethod: 'SELECTIVE' as const,
      payments: [{ participantId: pWinner, amountPaisa: 1 }],
      includedParticipantIds: [pWinner, pZero1, pZero2],
      clientMutationId: 'legacy-zero-share-001',
    };

    const created = await post('/expenses', tinyPayload);
    expect(created.status).toBe(201);
    const expenseId = created.body.data.expense.id as string;

    const createdShares = created.body.data.expense.shares as Array<{
      participantId: string;
      sharePaisa: number;
    }>;
    expect(createdShares).toHaveLength(3);
    expect(createdShares.filter((s) => s.sharePaisa === 0)).toHaveLength(2);

    await ExpenseModel.updateOne({ _id: expenseId }, { $unset: { idempotencyHash: 1 } });

    // Exact retry with the same zero-paisa recipients deduplicates cleanly
    const validRetry = await post('/expenses', {
      ...tinyPayload,
      includedParticipantIds: [pZero2, pWinner, pZero1],
    });
    expect(validRetry.status).toBe(200);
    expect(validRetry.body.data.deduplicated).toBe(true);
    expect(validRetry.body.data.expense.id).toBe(expenseId);

    // Swapping one zero-paisa recipient (pZero2 -> pZero3) keeps the 1-paisa row identical
    // and must reject with 409 IDEMPOTENCY_KEY_REUSED
    const swappedZeroRetry = await post('/expenses', {
      ...tinyPayload,
      includedParticipantIds: [pWinner, pZero1, pZero3],
    });
    expect(swappedZeroRetry.status).toBe(409);
    expect(swappedZeroRetry.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Dropping one zero-paisa recipient must also reject with 409 IDEMPOTENCY_KEY_REUSED
    const droppedZeroRetry = await post('/expenses', {
      ...tinyPayload,
      includedParticipantIds: [pWinner, pZero1],
    });
    expect(droppedZeroRetry.status).toBe(409);
    expect(droppedZeroRetry.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(1);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(3);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(1);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 19. Legacy deactivation conflict normalization (409), deactivated actor auth block (403), & post-Task-4 resilience
  // ---------------------------------------------------------------------------
  it('19. normalizes legacy deactivated-participant failures to 409, blocks deactivated actors with 403, keeps post-Task-4 retries resilient, and keeps new validation at 400', async () => {
    const { aarav, bina, dipesh } = fx.ids;
    const { sharma } = fx.famIds;

    const legacySplitPayload = {
      title: 'Legacy Split With Bina',
      category: 'FOOD_DRINKS',
      amountPaisa: 40000,
      splitMethod: 'EQUAL' as const,
      payments: [{ participantId: aarav, amountPaisa: 40000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'legacy-deact-split-001',
    };
    const legacyPayerPayload = {
      title: 'Legacy Paid By Bina',
      category: 'TRANSPORTATION',
      amountPaisa: 50000,
      splitMethod: 'EQUAL' as const,
      payments: [{ participantId: bina, amountPaisa: 50000 }],
      includedParticipantIds: [aarav, bina],
      clientMutationId: 'legacy-deact-payer-001',
    };
    const postTask4Payload = {
      title: 'Post-Task-4 Resilient',
      category: 'FOOD_DRINKS',
      amountPaisa: 60000,
      splitMethod: 'EQUAL' as const,
      payments: [{ participantId: bina, amountPaisa: 60000 }],
      includedParticipantIds: [aarav, bina, dipesh],
      clientMutationId: 'post-task4-deact-001',
    };
    const contribOwnPayload = {
      title: 'Dipesh Before Deactivation',
      category: 'SNACKS_WATER',
      amountPaisa: 30000,
      splitMethod: 'EQUAL' as const,
      payments: [{ participantId: dipesh, amountPaisa: 30000 }],
      includedParticipantIds: [aarav, dipesh],
      clientMutationId: 'contrib-deact-auth-001',
    };

    const [r1, r2, r3, r4] = await Promise.all([
      post('/expenses', legacySplitPayload, orgToken),
      post('/expenses', legacyPayerPayload, orgToken),
      post('/expenses', postTask4Payload, orgToken),
      post('/expenses', contribOwnPayload, contribToken),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(201);
    expect(r4.status).toBe(201);

    // Strip idempotencyHash on the first two only to simulate legacy records
    await ExpenseModel.updateMany(
      { _id: { $in: [r1.body.data.expense.id, r2.body.data.expense.id] } },
      { $unset: { idempotencyHash: 1 } }
    );

    // Deactivate bina (payer/split participant) and dipesh (actor), and mutate trip roster by adding Chitra
    const deactBina = await request(app)
      .patch(`/api/v1/trips/${fx.tripId}/participants/${bina}`)
      .set(auth(orgToken))
      .send({ isActive: false });
    expect(deactBina.status).toBe(200);

    const deactDipesh = await request(app)
      .patch(`/api/v1/trips/${fx.tripId}/participants/${dipesh}`)
      .set(auth(orgToken))
      .send({ isActive: false });
    expect(deactDipesh.status).toBe(200);

    const addChitra = await request(app)
      .post(`/api/v1/trips/${fx.tripId}/participants`)
      .set(auth(orgToken))
      .send({ name: 'Chitra Roster', familyId: sharma, role: 'PARTICIPANT', memberType: 'ADULT' });
    expect(addChitra.status).toBe(201);

    // Legacy retry with deactivated split participant -> 409 IDEMPOTENCY_KEY_REUSED (not 400)
    const legacySplitRetry = await post('/expenses', legacySplitPayload, orgToken);
    expect(legacySplitRetry.status).toBe(409);
    expect(legacySplitRetry.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(legacySplitRetry.body.data).toBeUndefined();
    expect(String(legacySplitRetry.body.error.message)).not.toMatch(/not active|INVALID_REFERENCE/i);

    // Legacy retry with deactivated payer -> 409 IDEMPOTENCY_KEY_REUSED (not 400 REQUEST_ERROR)
    const legacyPayerRetry = await post('/expenses', legacyPayerPayload, orgToken);
    expect(legacyPayerRetry.status).toBe(409);
    expect(legacyPayerRetry.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(legacyPayerRetry.body.data).toBeUndefined();
    expect(String(legacyPayerRetry.body.error.message)).not.toMatch(/does not belong|not active/i);

    // Genuinely new expense referencing deactivated bina still returns 400 validation error
    const genuinelyNewInvalid = await post(
      '/expenses',
      {
        ...legacySplitPayload,
        clientMutationId: 'brand-new-using-inactive-bina',
      },
      orgToken
    );
    expect(genuinelyNewInvalid.status).toBe(400);
    expect(genuinelyNewInvalid.body.error.code).toBe('INVALID_REFERENCE');

    // Post-Task-4 record continues to deduplicate cleanly despite deactivated participants & added roster member
    const postTask4Retry = await post('/expenses', postTask4Payload, orgToken);
    expect(postTask4Retry.status).toBe(200);
    expect(postTask4Retry.body.data.deduplicated).toBe(true);
    expect(postTask4Retry.body.data.expense.id).toBe(r3.body.data.expense.id);

    // Deactivated actor dipesh is blocked by route authorization before idempotency lookup (403)
    const deactivatedActorRetry = await post('/expenses', contribOwnPayload, contribToken);
    expect(deactivatedActorRetry.status).toBe(403);
    expect(deactivatedActorRetry.body.error.code).toBe('FORBIDDEN_TRIP_ACCESS');
    expect(deactivatedActorRetry.body.data).toBeUndefined();

    expect(await ExpenseModel.countDocuments({ tripId: fx.tripId })).toBe(4);
    expect(await ExpensePaymentModel.countDocuments({ tripId: fx.tripId })).toBe(4);
    expect(await ExpenseShareModel.countDocuments({ tripId: fx.tripId })).toBe(9);
    expect(
      await ActivityLogModel.countDocuments({ tripId: fx.tripId, actionType: 'EXPENSE_ADDED' })
    ).toBe(4);
    await expectInvariants();
  });

  // ---------------------------------------------------------------------------
  // 20. Migration hardening: strict filter checks & unfamiliar/manual non-sparse indexes
  // ---------------------------------------------------------------------------
  it('20. aborts migration safely on unexpected partial filter keys or pre-existing manual non-sparse unique indexes and resumes crash-interrupted runs', async () => {
    const col = ExpenseModel.collection;

    const resetTargetIndex = async () => {
      try {
        await col.dropIndex(EXPENSE_MUTATION_ID_INDEX_NAME);
      } catch {
        // ignore if missing
      }
    };

    // 20a. Target index name with extra unexpected partialFilterExpression key must abort
    await resetTargetIndex();
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      {
        name: EXPENSE_MUTATION_ID_INDEX_NAME,
        unique: true,
        partialFilterExpression: {
          clientMutationId: { $type: 'string', $gt: '' },
          isDeleted: false,
        },
      }
    );
    await expect(migrateExpenseMutationIndex(col)).rejects.toThrow(/unexpected options/i);

    // Target index name with extra inner operator key ($lt) must also abort
    await resetTargetIndex();
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      {
        name: EXPENSE_MUTATION_ID_INDEX_NAME,
        unique: true,
        partialFilterExpression: {
          clientMutationId: { $type: 'string', $gt: '', $lt: 'z' },
        },
      }
    );
    await expect(migrateExpenseMutationIndex(col)).rejects.toThrow(/unexpected options/i);
    await resetTargetIndex();

    // 20b. Pre-existing manual non-sparse compound unique index must abort WITHOUT creating/dropping indexes
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      { unique: true, name: 'manual_non_sparse_unique' }
    );
    await expect(migrateExpenseMutationIndex(col)).rejects.toThrow(
      /manual inspection[\s\S]*manual_non_sparse_unique/i
    );
    const afterManualAbort = await col.indexes();
    expect(afterManualAbort.some((i) => i.name === 'manual_non_sparse_unique')).toBe(true);
    expect(afterManualAbort.some((i) => i.name === EXPENSE_MUTATION_ID_INDEX_NAME)).toBe(false);
    await col.dropIndex('manual_non_sparse_unique');

    // Non-sparse index even using default name tripId_1_clientMutationId_1 must also require manual intervention
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      { unique: true, name: 'tripId_1_clientMutationId_1' }
    );
    await expect(migrateExpenseMutationIndex(col)).rejects.toThrow(
      /manual inspection[\s\S]*tripId_1_clientMutationId_1/i
    );
    expect(
      (await col.indexes()).some((i) => i.name === 'tripId_1_clientMutationId_1')
    ).toBe(true);
    await col.dropIndex('tripId_1_clientMutationId_1');

    // 20c. Mid-migration crash-resume state (target partial index + legacy sparse index both present) completes cleanly
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      { unique: true, sparse: true, name: 'tripId_1_clientMutationId_1' }
    );
    await col.createIndex(
      { tripId: 1, clientMutationId: 1 },
      {
        name: EXPENSE_MUTATION_ID_INDEX_NAME,
        unique: true,
        partialFilterExpression: { clientMutationId: { $type: 'string', $gt: '' } },
      }
    );

    const resumed = await migrateExpenseMutationIndex(col);
    expect(resumed.createdNewIndex).toBe(false);
    expect(resumed.verifiedNewIndexReady).toBe(true);
    expect(resumed.droppedLegacyIndexNames).toEqual(['tripId_1_clientMutationId_1']);
    const finalIndexes = await col.indexes();
    expect(finalIndexes.some((i) => i.name === EXPENSE_MUTATION_ID_INDEX_NAME)).toBe(true);
    expect(finalIndexes.some((i) => i.name === 'tripId_1_clientMutationId_1')).toBe(false);
  });
});
