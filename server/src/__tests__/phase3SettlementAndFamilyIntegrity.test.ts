import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import {
  ActivityLogModel,
  FamilyModel,
  ParticipantInviteModel,
  ParticipantModel,
  SettlementModel,
  TripModel,
} from '../models/index.js';
import { supportsTransactions } from '../services/atomicWrite.js';
import { clearTestEmailOutbox, getTestEmailOutbox } from '../services/emailService.js';
import { claimParticipantInviteForUser } from '../services/participantInviteService.js';
import { generateParticipantInviteToken } from '../utils/tokens.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_phase3_1_integrity';

function extractVerificationToken(urlString: string): string {
  const token = new URL(urlString).searchParams.get('token');
  if (!token) throw new Error('Missing verification token');
  return token;
}

async function registerUser(
  app: ReturnType<typeof createApp>,
  params: { name: string; email: string; password?: string },
  verify = true
) {
  clearTestEmailOutbox();
  const reg = await request(app).post('/api/v1/auth/register').send({
    name: params.name,
    email: params.email,
    password: params.password ?? 'Password123',
  });
  expect(reg.status).toBe(201);
  const accessToken = reg.body.data.accessToken as string;
  const userId = reg.body.data.user.id as string;

  if (verify) {
    const outbox = getTestEmailOutbox();
    const token = extractVerificationToken(outbox[outbox.length - 1]!.verificationUrl);
    const ver = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(ver.status).toBe(200);
  }

  return { userId, accessToken, email: params.email.toLowerCase() };
}

async function promoteParticipantViaVerifiedInvite(params: {
  app: ReturnType<typeof createApp>;
  organizerToken: string;
  tripId: string;
  participantId: string;
  targetToken: string;
  targetEmail: string;
  grantedRole: 'ORGANIZER' | 'FAMILY_REP' | 'CONTRIBUTOR' | 'PARTICIPANT';
}) {
  const invRes = await request(params.app)
    .post(`/api/v1/trips/${params.tripId}/participants/${params.participantId}/invites`)
    .set('Authorization', `Bearer ${params.organizerToken}`)
    .send({ grantedRole: params.grantedRole, intendedEmail: params.targetEmail });
  expect(invRes.status).toBe(201);

  const claimRes = await request(params.app)
    .post('/api/v1/trips/invites/claim')
    .set('Authorization', `Bearer ${params.targetToken}`)
    .send({ token: invRes.body.data.rawToken as string });
  expect(claimRes.status).toBe(200);
  return claimRes;
}

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
  if (envMongod && isExecutableFile(envMongod)) return envMongod;

  const names =
    process.platform === 'win32' ? ['mongod.exe', 'mongod.cmd', 'mongod'] : ['mongod'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const c = path.join(dir, name);
      if (isExecutableFile(c)) return c;
    }
  }
  for (const fallback of [
    'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe',
    'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe',
    'C:\\Program Files\\MongoDB\\Server\\6.0\\bin\\mongod.exe',
    '/usr/bin/mongod',
    '/usr/local/bin/mongod',
  ]) {
    if (isExecutableFile(fallback)) return fallback;
  }
  throw new Error('mongod executable required for Phase 3.1 replica-set tests.');
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function startReplicaSet(): Promise<{ cleanup: () => Promise<void> }> {
  const mongodPath = resolveMongodExecutable();
  const port = await allocateEphemeralPort();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripledger-replset-p31-'));
  let proc: ChildProcess | null = null;
  let stderr = '';

  const cleanup = async () => {
    await disconnectDatabase();
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        proc?.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        proc?.kill();
      });
    }
    proc = null;
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // ignore delayed Windows file unlock
    }
  };

  try {
    await disconnectDatabase();
    proc = spawn(
      mongodPath,
      ['--replSet', 'rs0', '--port', String(port), '--bind_ip', '127.0.0.1', '--dbpath', dbDir],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });

    const uri = `mongodb://127.0.0.1:${port}/tripledger_test_p31_replset?directConnection=true`;
    let connected = false;
    for (let i = 0; i < 40; i++) {
      if (proc.exitCode !== null) {
        throw new Error(`mongod exited early (${proc.exitCode}): ${stderr}`);
      }
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 });
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!connected) throw new Error('Timed out connecting to replica set');

    await mongoose.connection.db!.admin().command({
      replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
    });

    for (let i = 0; i < 40; i++) {
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      if (hello.isWritablePrimary || hello.ismaster) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!(await supportsTransactions())) {
      throw new Error('Replica set does not support multi-document transactions');
    }

    return { cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

describe('Phase 3.1: FAMILY_REP Settlement Authorization & Family Integrity (H-01 / L-02)', () => {
  const app = createApp();

  describe('Standalone MongoDB suite', () => {
    beforeAll(async () => {
      await connectDatabase(TEST_DB_URI);
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        FamilyModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
        SettlementModel.createIndexes(),
      ]);
    }, 30000);

    beforeEach(async () => {
      clearTestEmailOutbox();
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        FamilyModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
        SettlementModel.createIndexes(),
      ]);
    });

    afterEach(() => {
      clearTestEmailOutbox();
      vi.restoreAllMocks();
      delete process.env.NODE_ENV;
    });

    afterAll(async () => {
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await disconnectDatabase();
    });

    it('1. authorizes only the active designated FAMILY_REP on REPORTED FAMILY settlements, rejects rogue/INDIVIDUAL/terminal/closed/cross-trip attempts, and preserves organizer flows', async () => {
      const org = await registerUser(app, { name: 'Trip Org', email: 'org.s1@example.com' });
      const repA = await registerUser(app, { name: 'Rep A', email: 'repa.s1@example.com' });
      const memberA = await registerUser(app, { name: 'Member A', email: 'mema.s1@example.com' });
      const repB = await registerUser(app, { name: 'Rep B', email: 'repb.s1@example.com' });

      // Trip 1 (FAMILY)
      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Poon Hill Family', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
      expect(tripRes.status).toBe(201);
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;
      const orgPartId = tripRes.body.data.myParticipant.id as string;

      // Trip 2 (foreign isolation check)
      const trip2Res = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Foreign Trip', mode: 'FAMILY', organizerFamilyName: 'Foreign Fam' });
      const trip2Id = trip2Res.body.data.trip.id as string;
      const trip2OrgPartId = trip2Res.body.data.myParticipant.id as string;
      const foreignGuestRes = await request(app)
        .post(`/api/v1/trips/${trip2Id}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Foreign Payee' });
      const foreignPayeeId = foreignGuestRes.body.data.participant.id as string;

      // Create Family A and Family B in Trip 1
      const famARes = await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Family A' });
      const famAId = famARes.body.data.family.id as string;

      const famBRes = await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Family B' });
      const famBId = famBRes.body.data.family.id as string;

      // Join repA, memberA into Family A; join repB into Family B
      const repAJoin = await request(app)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${repA.accessToken}`);
      const repAPartId = repAJoin.body.data.participantId as string;

      const memAJoin = await request(app)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      const memAPartId = memAJoin.body.data.participantId as string;

      const repBJoin = await request(app)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${repB.accessToken}`);
      const repBPartId = repBJoin.body.data.participantId as string;

      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repAPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famAId });
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${memAPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famAId });
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repBPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famBId });

      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repAPartId,
        targetToken: repA.accessToken,
        targetEmail: repA.email,
        grantedRole: 'FAMILY_REP',
      });
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repBPartId,
        targetToken: repB.accessToken,
        targetEmail: repB.email,
        grantedRole: 'FAMILY_REP',
      });

      // Inject a rogue second participant with role=FAMILY_REP in Family A (simulating legacy/raw anomaly)
      await ParticipantModel.updateOne({ _id: memAPartId }, { $set: { role: 'FAMILY_REP' } });

      // Add an expense so balances exist
      await request(app)
        .post(`/api/v1/trips/${tripId}/expenses`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          title: 'Family Stay',
          category: 'ACCOMMODATION',
          amountPaisa: 100000,
          splitMethod: 'EQUAL',
          paymentMethod: 'CASH',
          payments: [{ participantId: memAPartId, amountPaisa: 100000 }],
        });

      // Helper to report FAMILY settlement to memA (Family A)
      const s1Res = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${repB.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: repBPartId,
          toParticipantId: memAPartId,
          toFamilyId: famAId,
          amountPaisa: 25000,
          paymentMethod: 'CASH',
        });
      expect(s1Res.status).toBe(201);
      const s1Id = s1Res.body.data.settlement.id as string;

      // Another FAMILY_REP in same family (memA is receiver here? Let's create one where orgPart pays a third Fam A member, or check rogue rep!)
      const childFamAGuest = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Fam A Dependent', familyId: famAId })
      ).body.data.participant.id as string;

      const famSettleToChild = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: childFamAGuest,
          toFamilyId: famAId,
          amountPaisa: 15000,
          status: 'REPORTED',
        });
      expect(famSettleToChild.status).toBe(201);
      const famSettleId = famSettleToChild.body.data.settlement.id as string;

      // 1a. Non-designated FAMILY_REP in SAME family (memA has role=FAMILY_REP & familyId=famAId, but repId=repA) CANNOT confirm or reject
      const rogueConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(rogueConfirm.status).toBe(403);
      expect(rogueConfirm.body.error.code).toBe('FORBIDDEN_SETTLEMENT_CONFIRMATION');

      const rogueReject = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ status: 'REJECTED' });
      expect(rogueReject.status).toBe(403);
      expect(rogueReject.body.error.code).toBe('FORBIDDEN_SETTLEMENT_CONFIRMATION');

      // 1b. Cross-family FAMILY_REP (repB of famB) CANNOT confirm famA settlement
      const crossFamConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${repB.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(crossFamConfirm.status).toBe(403);

      // Clean up rogue test override before continuing cleanly
      await ParticipantModel.updateOne({ _id: memAPartId }, { $set: { role: 'PARTICIPANT' } });

      // 1c. Designated FAMILY_REP (repA) CAN confirm a valid REPORTED FAMILY settlement to Fam A
      const repAConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${repA.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(repAConfirm.status).toBe(200);
      expect(repAConfirm.body.data.settlement.status).toBe('CONFIRMED');
      expect(repAConfirm.body.data.ledger.totalConfirmedSettlementPaisa).toBe(15000);

      // 1d. Neither FAMILY_REP nor Organizer can reverse an already CONFIRMED settlement
      const repAReverse = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${repA.accessToken}`)
        .send({ status: 'REJECTED' });
      expect(repAReverse.status).toBe(409);
      expect(repAReverse.body.error.code).toBe('INVALID_SETTLEMENT_TRANSITION');

      const orgReverse = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ status: 'REJECTED' });
      expect(orgReverse.status).toBe(409);
      expect(orgReverse.body.error.code).toBe('INVALID_SETTLEMENT_TRANSITION');

      // 1e. Designated FAMILY_REP CAN reject another REPORTED FAMILY settlement and cannot un-reject it
      const famSettle2 = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: childFamAGuest,
          amountPaisa: 5000,
          status: 'REPORTED',
        });
      const famSettle2Id = famSettle2.body.data.settlement.id as string;
      const repAReject = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettle2Id}/status`)
        .set('Authorization', `Bearer ${repA.accessToken}`)
        .send({ status: 'REJECTED' });
      expect(repAReject.status).toBe(200);
      expect(repAReject.body.data.settlement.status).toBe('REJECTED');
      expect(repAReject.body.data.ledger.totalConfirmedSettlementPaisa).toBe(15000);

      const unrejectAttempt = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettle2Id}/status`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(unrejectAttempt.status).toBe(409);

      // 1f. FAMILY_REP CANNOT confirm or reject an INDIVIDUAL settlement for another member of their family
      const badIndivWithFam = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'INDIVIDUAL',
          fromParticipantId: orgPartId,
          toParticipantId: childFamAGuest,
          toFamilyId: famAId,
          amountPaisa: 8000,
          status: 'REPORTED',
        });
      expect(badIndivWithFam.status).toBe(400);

      const indivSettleRes = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'INDIVIDUAL',
          fromParticipantId: orgPartId,
          toParticipantId: childFamAGuest,
          amountPaisa: 8000,
          status: 'REPORTED',
        });
      expect(indivSettleRes.status).toBe(201);
      expect(indivSettleRes.body.data.settlement.toFamilyId).toBeNull();
      const indivSettleId = indivSettleRes.body.data.settlement.id as string;

      const repIndivConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${indivSettleId}/status`)
        .set('Authorization', `Bearer ${repA.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(repIndivConfirm.status).toBe(403);
      expect(repIndivConfirm.body.error.code).toBe('FORBIDDEN_SETTLEMENT_CONFIRMATION');

      // Organizer CAN confirm INDIVIDUAL reported settlement
      const orgIndivConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${indivSettleId}/status`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(orgIndivConfirm.status).toBe(200);

      // 1g. Cross-trip settlement ID rejected
      const trip2Settle = await request(app)
        .post(`/api/v1/trips/${trip2Id}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: trip2OrgPartId,
          toParticipantId: foreignPayeeId,
          amountPaisa: 5000,
          status: 'REPORTED',
        });
      const foreignSettleId = trip2Settle.body.data.settlement.id as string;

      const crossTripAttempt = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${foreignSettleId}/status`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(crossTripAttempt.status).toBe(404);
      expect(crossTripAttempt.body.error.code).toBe('SETTLEMENT_NOT_FOUND');

      // 1g-bis. Designated FAMILY_REP cannot confirm settlement whose receiver is no longer active
      const ghostPayeeRes = await request(app)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Ghost Fam A Child', familyId: famAId });
      expect(ghostPayeeRes.status).toBe(201);
      const ghostPayeeId = ghostPayeeRes.body.data.participant.id as string;

      const ghostSettleRes = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: ghostPayeeId,
          toFamilyId: famAId,
          amountPaisa: 2000,
          status: 'REPORTED',
        });
      expect(ghostSettleRes.status).toBe(201);
      const ghostSettleId = ghostSettleRes.body.data.settlement.id as string;

      const deactivateGhost = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${ghostPayeeId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: false });
      expect(deactivateGhost.status).toBe(200);

      const repConfirmInactiveRecv = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${ghostSettleId}/status`)
        .set('Authorization', `Bearer ${repA.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(repConfirmInactiveRecv.status).toBe(403);
      expect(repConfirmInactiveRecv.body.error.code).toBe('FORBIDDEN_SETTLEMENT_CONFIRMATION');

      // 1h. Closed trip blocks BOTH new settlement creation AND status updates for FAMILY_REP and Organizer
      const famSettlePending = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: childFamAGuest,
          amountPaisa: 4000,
          status: 'REPORTED',
        });
      const famSettlePendingId = famSettlePending.body.data.settlement.id as string;

      const closeRes = await request(app)
        .post(`/api/v1/trips/${tripId}/close`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ forceClose: true });
      expect(closeRes.status).toBe(200);

      const postOnClosed = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: childFamAGuest,
          amountPaisa: 4000,
        });
      expect(postOnClosed.status).toBe(403);
      expect(postOnClosed.body.error.code).toBe('TRIP_CLOSED');

      const repConfirmOnClosed = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettlePendingId}/status`)
        .set('Authorization', `Bearer ${repA.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(repConfirmOnClosed.status).toBe(403);
      expect(repConfirmOnClosed.body.error.code).toBe('TRIP_CLOSED');

      const orgConfirmOnClosed = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettlePendingId}/status`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(orgConfirmOnClosed.status).toBe(403);
      expect(orgConfirmOnClosed.body.error.code).toBe('TRIP_CLOSED');
      expect((await SettlementModel.findById(s1Id))?.status).toBe('REPORTED');
    });

    it('2. revokes stale FAMILY_REP authority when representative is replaced or moved across families and blocks invalid FAMILY_REP assignments/promotions', async () => {
      const org = await registerUser(app, { name: 'Fam Org', email: 'famorg.s2@example.com' });
      const repOld = await registerUser(app, { name: 'Rep Old', email: 'repold.s2@example.com' });
      const repNew = await registerUser(app, { name: 'Rep New', email: 'repnew.s2@example.com' });

      // Friends Mode trip blocks createFamily & FAMILY_REP invitations
      const friendsTrip = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Friends Only', mode: 'FRIENDS' });
      const friendsTripId = friendsTrip.body.data.trip.id as string;
      const friendsJoin = await request(app)
        .post(`/api/v1/trips/join/${friendsTrip.body.data.trip.inviteCode as string}`)
        .set('Authorization', `Bearer ${repOld.accessToken}`);
      const friendsPartId = friendsJoin.body.data.participantId as string;

      const badCreateFamOnFriends = await request(app)
        .post(`/api/v1/trips/${friendsTripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Should Fail Family' });
      expect(badCreateFamOnFriends.status).toBe(400);
      expect(badCreateFamOnFriends.body.error.code).toBe('FAMILY_MODE_ONLY');

      const badInviteOnFriends = await request(app)
        .post(`/api/v1/trips/${friendsTripId}/participants/${friendsPartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repOld.email });
      expect(badInviteOnFriends.status).toBe(400);
      expect(badInviteOnFriends.body.error.code).toBe('FAMILY_MODE_ONLY');

      // Family Mode trip
      const famTripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Kaski Family Trip', mode: 'FAMILY', organizerFamilyName: 'Host Fam' });
      const tripId = famTripRes.body.data.trip.id as string;
      const inviteCode = famTripRes.body.data.trip.inviteCode as string;
      const orgPartId = famTripRes.body.data.myParticipant.id as string;

      const fam1Id = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Gurung Family' })
      ).body.data.family.id as string;

      const fam2Id = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Magar Family' })
      ).body.data.family.id as string;

      const repOldPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${repOld.accessToken}`)
      ).body.data.participantId as string;

      const repNewPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${repNew.accessToken}`)
      ).body.data.participantId as string;

      const payeeGuestId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Gurung Kid', familyId: fam1Id })
      ).body.data.participant.id as string;

      // Issuing FAMILY_REP invite WITHOUT a family assigned rejects cleanly
      const ungroupedRepInvite = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${repOldPartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repOld.email });
      expect(ungroupedRepInvite.status).toBe(400);
      expect(ungroupedRepInvite.body.error.code).toBe('FAMILY_REQUIRED_FOR_REP');

      // Direct PATCH cannot promote to FAMILY_REP
      const directPatchRep = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repOldPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: fam1Id, role: 'FAMILY_REP' });
      expect(directPatchRep.status).toBe(400);
      expect(directPatchRep.body.error.code).toBe('PRIVILEGED_ROLE_REQUIRES_INVITE');

      // Assign both repOld and repNew into fam1 and invite repOld to FAMILY_REP
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repOldPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: fam1Id });
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repNewPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: fam1Id });

      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repOldPartId,
        targetToken: repOld.accessToken,
        targetEmail: repOld.email,
        grantedRole: 'FAMILY_REP',
      });

      expect((await FamilyModel.findById(fam1Id))?.representativeId?.toString()).toBe(repOldPartId);

      // Cannot invite second member in fam1 as FAMILY_REP while repOld is designated
      const secondRepConflict = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${repNewPartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repNew.email });
      expect(secondRepConflict.status).toBe(409);
      expect(secondRepConflict.body.error.code).toBe('FAMILY_ALREADY_HAS_REPRESENTATIVE');

      // Cannot steal repOld into fam2 as representative while repOld represents fam1
      const crossFamSteal = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${fam2Id}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ representativeId: repOldPartId });
      expect(crossFamSteal.status).toBe(409);
      expect(crossFamSteal.body.error.code).toBe('PARTICIPANT_ALREADY_FAMILY_REP');

      // Report a FAMILY settlement to fam1
      const famSettleId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({
            settlementMode: 'FAMILY',
            fromParticipantId: orgPartId,
            toParticipantId: payeeGuestId,
            toFamilyId: fam1Id,
            amountPaisa: 10000,
          })
      ).body.data.settlement.id as string;

      // Replace fam1 representative via PATCH /families/:fam1Id -> repNew
      // Rule 4 & 8: repOld loses FAMILY_REP role; repNew stays PARTICIPANT until verified invite
      const replaceRepRes = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${fam1Id}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ representativeId: repNewPartId });
      expect(replaceRepRes.status).toBe(200);
      expect(replaceRepRes.body.data.family.representativeId).toBe(repNewPartId);
      expect((await ParticipantModel.findById(repOldPartId))?.role).toBe('PARTICIPANT');
      expect((await ParticipantModel.findById(repNewPartId))?.role).toBe('PARTICIPANT');

      // Neither former repOld NOR not-yet-invited repNew can confirm famSettleId yet
      const oldRepConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${repOld.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(oldRepConfirm.status).toBe(403);

      const uninvitedNewRepConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${repNew.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(uninvitedNewRepConfirm.status).toBe(403);

      // Invite & claim verified FAMILY_REP invite for repNew -> succeeds!
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repNewPartId,
        targetToken: repNew.accessToken,
        targetEmail: repNew.email,
        grantedRole: 'FAMILY_REP',
      });

      // Now move repNew to fam2 via PATCH /participants/:id -> clears fam1.representativeId & demotes repNew!
      const moveWithRepRejected = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repNewPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: fam2Id, role: 'FAMILY_REP' });
      expect(moveWithRepRejected.status).toBe(400);
      expect(moveWithRepRejected.body.error.code).toBe('PRIVILEGED_ROLE_REQUIRES_INVITE');

      const moveRes = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repNewPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: fam2Id });
      expect(moveRes.status).toBe(200);
      expect(moveRes.body.data.participant.role).toBe('PARTICIPANT');
      expect((await FamilyModel.findById(fam1Id))?.representativeId).toBeNull();

      // Moved repNew can NO LONGER confirm settlements for old fam1 or new fam2
      const movedRepActOnOldFam = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${famSettleId}/status`)
        .set('Authorization', `Bearer ${repNew.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(movedRepActOnOldFam.status).toBe(403);

      // Service-level guard blocks raw bypassed FAMILY_REP invite redemption on FRIENDS trip or missing familyId
      const { rawToken, tokenHash, expiresAt } = generateParticipantInviteToken(24);
      await ParticipantInviteModel.collection.insertOne({
        tripId: new mongoose.Types.ObjectId(friendsTripId),
        participantId: new mongoose.Types.ObjectId(friendsPartId),
        invitedByUserId: new mongoose.Types.ObjectId(org.userId),
        invitedByParticipantId: new mongoose.Types.ObjectId(friendsTrip.body.data.myParticipant.id),
        tokenHash,
        intendedEmail: repOld.email,
        grantedRole: 'FAMILY_REP',
        requireVerifiedEmail: true,
        expiresAt,
        usedAt: null,
        usedByUserId: null,
        revokedAt: null,
        revokedByParticipantId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(
        claimParticipantInviteForUser({ userId: repOld.userId, body: { token: rawToken } })
      ).rejects.toMatchObject({ statusCode: 400, code: 'FAMILY_MODE_ONLY' });

      // Removing a participant from their family (familyId: null) revokes pending FAMILY_REP invites
      const pendingBeforeUnassign = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${repNewPartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repNew.email });
      expect(pendingBeforeUnassign.status).toBe(201);
      const unassignRawToken = pendingBeforeUnassign.body.data.rawToken as string;

      const removeFromFamRes = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repNewPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: null });
      expect(removeFromFamRes.status).toBe(200);
      expect(removeFromFamRes.body.data.participant.familyId).toBeNull();

      const revokedOnUnassignClaim = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${repNew.accessToken}`)
        .send({ token: unassignRawToken });
      expect(revokedOnUnassignClaim.status).toBe(409);
      expect(revokedOnUnassignClaim.body.error.code).toBe('INVITE_REVOKED');

      // Service-level guard blocks raw bypassed FAMILY_REP invite redemption when participant has no familyId
      const missingFamTok = generateParticipantInviteToken(24);
      await ParticipantInviteModel.collection.insertOne({
        tripId: new mongoose.Types.ObjectId(tripId),
        participantId: new mongoose.Types.ObjectId(repNewPartId),
        invitedByUserId: new mongoose.Types.ObjectId(org.userId),
        invitedByParticipantId: new mongoose.Types.ObjectId(orgPartId),
        tokenHash: missingFamTok.tokenHash,
        intendedEmail: repNew.email,
        grantedRole: 'FAMILY_REP',
        requireVerifiedEmail: true,
        expiresAt: missingFamTok.expiresAt,
        usedAt: null,
        usedByUserId: null,
        revokedAt: null,
        revokedByParticipantId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(
        claimParticipantInviteForUser({ userId: repNew.userId, body: { token: missingFamTok.rawToken } })
      ).rejects.toMatchObject({ statusCode: 400, code: 'FAMILY_REQUIRED_FOR_REP' });

      // Re-assign repNewPartId to fam2, issue pending FAMILY_REP invite, then delete fam2 -> clears familyId & revokes invite
      const reassignFam2 = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repNewPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: fam2Id });
      expect(reassignFam2.status).toBe(200);

      const pendingBeforeDeleteFam = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${repNewPartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repNew.email });
      expect(pendingBeforeDeleteFam.status).toBe(201);
      const deleteFamRawToken = pendingBeforeDeleteFam.body.data.rawToken as string;

      // Deleting fam2 clears remaining member familyIds and revokes any pending FAMILY_REP invites
      const deleteFam2 = await request(app)
        .delete(`/api/v1/trips/${tripId}/families/${fam2Id}`)
        .set('Authorization', `Bearer ${org.accessToken}`);
      expect(deleteFam2.status).toBe(200);
      expect((await ParticipantModel.findById(repNewPartId))?.familyId).toBeNull();

      const revokedOnDeleteFamClaim = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${repNew.accessToken}`)
        .send({ token: deleteFamRawToken });
      expect(revokedOnDeleteFamClaim.status).toBe(409);
      expect(revokedOnDeleteFamClaim.body.error.code).toBe('INVITE_REVOKED');
    });

    it('3. enforces deactivation/reactivation and deletion invariants on privileged roles without bypassing verified invitations, and fails closed in production standalone', async () => {
      const org = await registerUser(app, { name: 'Main Org', email: 'mainorg.s3@example.com' });
      const coOrg = await registerUser(app, { name: 'Co Org', email: 'coorg.s3@example.com' });
      const rep = await registerUser(app, { name: 'Rep User', email: 'rep.s3@example.com' });
      const unverified = await registerUser(
        app,
        { name: 'Unverified Legacy', email: 'unver.s3@example.com' },
        false
      );

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Dolpa Family Trek', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;

      const famId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Lama Family' })
      ).body.data.family.id as string;

      const coPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${coOrg.accessToken}`)
      ).body.data.participantId as string;
      const repPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep.accessToken}`)
      ).body.data.participantId as string;

      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famId });

      // Promote coOrg -> ORGANIZER, rep -> FAMILY_REP via verified invites
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: coPartId,
        targetToken: coOrg.accessToken,
        targetEmail: coOrg.email,
        grantedRole: 'ORGANIZER',
      });
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repPartId,
        targetToken: rep.accessToken,
        targetEmail: rep.email,
        grantedRole: 'FAMILY_REP',
      });
      expect((await FamilyModel.findById(famId))?.representativeId?.toString()).toBe(repPartId);

      // Deactivating FAMILY_REP strips FAMILY_REP -> PARTICIPANT, clears Family.representativeId, and revokes pending invites
      const deactRep = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: false });
      expect(deactRep.status).toBe(200);
      expect(deactRep.body.data.participant.isActive).toBe(false);
      expect(deactRep.body.data.participant.role).toBe('PARTICIPANT');
      expect((await FamilyModel.findById(famId))?.representativeId).toBeNull();

      // Reactivating rep restores PARTICIPANT only (never FAMILY_REP)
      const reactRep = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: true });
      expect(reactRep.status).toBe(200);
      expect(reactRep.body.data.participant.isActive).toBe(true);
      expect(reactRep.body.data.participant.role).toBe('PARTICIPANT');

      // Re-promote rep cleanly, then remove participant -> clears Family.representativeId without dangling ref
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repPartId,
        targetToken: rep.accessToken,
        targetEmail: rep.email,
        grantedRole: 'FAMILY_REP',
      });
      expect((await FamilyModel.findById(famId))?.representativeId?.toString()).toBe(repPartId);
      const delRep = await request(app)
        .delete(`/api/v1/trips/${tripId}/participants/${repPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`);
      expect(delRep.status).toBe(200);
      expect((await FamilyModel.findById(famId))?.representativeId).toBeNull();

      // Deactivating co-ORGANIZER strips ORGANIZER -> PARTICIPANT so reactivation does not bypass invite policy
      const deactCoOrg = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${coPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: false });
      expect(deactCoOrg.status).toBe(200);
      expect(deactCoOrg.body.data.participant.role).toBe('PARTICIPANT');

      // Legacy pre-hardening inactive privileged rows (unverified user or unlinked guest) CANNOT be reactivated via PATCH { isActive: true }
      const legacyInactiveUnverified = await ParticipantModel.create({
        tripId,
        userId: unverified.userId,
        familyId: famId,
        name: 'Legacy Inactive Rep',
        email: unverified.email,
        role: 'FAMILY_REP',
        isActive: false,
      });
      const legacyInactiveGuest = await ParticipantModel.create({
        tripId,
        userId: null,
        name: 'Legacy Inactive Guest Org',
        role: 'ORGANIZER',
        isActive: false,
      });

      const badReactUnverified = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${legacyInactiveUnverified._id.toString()}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: true });
      expect(badReactUnverified.status).toBe(400);
      expect(badReactUnverified.body.error.code).toBe('PRIVILEGED_ROLE_REQUIRES_INVITE');

      const badReactGuest = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${legacyInactiveGuest._id.toString()}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: true });
      expect(badReactGuest.status).toBe(400);
      expect(badReactGuest.body.error.code).toBe('GUEST_ROLE_RESTRICTED');

      // Reactivating explicitly downgraded to PARTICIPANT succeeds cleanly without bypassing invites
      const safeReact = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${legacyInactiveUnverified._id.toString()}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ isActive: true, role: 'PARTICIPANT' });
      expect(safeReact.status).toBe(200);
      expect(safeReact.body.data.participant.role).toBe('PARTICIPANT');

      // Production standalone fails closed with 503 TRANSACTIONS_UNAVAILABLE
      process.env.NODE_ENV = 'production';
      const prodUpdateFam = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ representativeId: safeReact.body.data.participant.id });
      expect(prodUpdateFam.status).toBe(503);
      expect(prodUpdateFam.body.error.code).toBe('TRANSACTIONS_UNAVAILABLE');
    });
  });

  describe('Real MongoDB Replica Set ACID atomicity for settlements and family rep updates', () => {
    let cleanupRepl: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      const started = await startReplicaSet();
      cleanupRepl = started.cleanup;
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        FamilyModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
        SettlementModel.createIndexes(),
      ]);
    }, 60000);

    beforeEach(async () => {
      clearTestEmailOutbox();
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await Promise.all([
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        FamilyModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
        SettlementModel.createIndexes(),
      ]);
    });

    afterEach(() => {
      clearTestEmailOutbox();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (cleanupRepl) {
        await cleanupRepl();
      }
    }, 30000);

    it('4. aborts settlement status update atomically on mid-transaction ActivityLog failure and serializes settlement confirmation against concurrent representative replacement', async () => {
      expect(await supportsTransactions()).toBe(true);

      const org = await registerUser(app, { name: 'Repl Org', email: 'replorg.31@example.com' });
      const rep = await registerUser(app, { name: 'Repl Rep', email: 'replrep.31@example.com' });
      const rep2 = await registerUser(app, { name: 'Repl Rep2', email: 'replrep2.31@example.com' });

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Acid Family Trip', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;
      const orgPartId = tripRes.body.data.myParticipant.id as string;

      const famId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Acid Family' })
      ).body.data.family.id as string;

      const repPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep.accessToken}`)
      ).body.data.participantId as string;
      const rep2PartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep2.accessToken}`)
      ).body.data.participantId as string;
      const childId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Acid Child', familyId: famId })
      ).body.data.participant.id as string;

      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repPartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famId });
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${rep2PartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famId });

      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: repPartId,
        targetToken: rep.accessToken,
        targetEmail: rep.email,
        grantedRole: 'FAMILY_REP',
      });

      const sRes = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: childId,
          toFamilyId: famId,
          amountPaisa: 12000,
          status: 'REPORTED',
        });
      const settlementId = sRes.body.data.settlement.id as string;

      // Simulated ActivityLog failure rolls back Settlement.status cleanly inside replica-set TX
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(
        new Error('Simulated ActivityLog failure during settlement confirm')
      );
      const abortedRes = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${settlementId}/status`)
        .set('Authorization', `Bearer ${rep.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(abortedRes.status).toBe(500);
      vi.restoreAllMocks();
      expect((await SettlementModel.findById(settlementId))?.status).toBe('REPORTED');

      // Concurrent representative replacement vs settlement confirmation on real replica set
      const [replaceRes, confirmRes] = await Promise.all([
        request(app)
          .patch(`/api/v1/trips/${tripId}/families/${famId}`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ representativeId: rep2PartId }),
        request(app)
          .patch(`/api/v1/trips/${tripId}/settlements/${settlementId}/status`)
          .set('Authorization', `Bearer ${rep.accessToken}`)
          .send({ status: 'CONFIRMED' }),
      ]);

      expect(replaceRes.status).toBe(200);
      expect((await ParticipantModel.findById(repPartId))?.role).toBe('PARTICIPANT');
      expect((await FamilyModel.findById(famId))?.representativeId?.toString()).toBe(rep2PartId);
      expect([200, 403]).toContain(confirmRes.status);
    });
  });
});
