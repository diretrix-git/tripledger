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
  const appB = createApp();

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
    }, 30000);

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
    }, 30000);

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
    }, 30000);

    it('4b. enforces in-place FAMILY_REP demotion cleanup, cross-family stale invite revocation, legacy ungrouped rep rejection, 409 duplicate family guard, and atomic ActivityLog rollback in standalone', async () => {
      const org = await registerUser(app, { name: 'F2 Org', email: 'f2org@example.com' });
      const rep1 = await registerUser(app, { name: 'F2 Rep1', email: 'f2rep1@example.com' });
      const rep2 = await registerUser(app, { name: 'F2 Rep2', email: 'f2rep2@example.com' });
      const rep3 = await registerUser(app, { name: 'F2 Rep3', email: 'f2rep3@example.com' });
      const legacyUnverified = await registerUser(
        app,
        { name: 'Unverified Rep', email: 'unverrep@example.com' },
        false
      );

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Mustang Family Ops', mode: 'FAMILY', organizerFamilyName: 'Host Fam' });
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;
      const orgPartId = tripRes.body.data.myParticipant.id as string;

      const famAId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Alpha Family' })
      ).body.data.family.id as string;

      const famBId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Beta Family' })
      ).body.data.family.id as string;

      const rep1PartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep1.accessToken}`)
      ).body.data.participantId as string;
      const rep2PartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep2.accessToken}`)
      ).body.data.participantId as string;
      const rep3PartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep3.accessToken}`)
      ).body.data.participantId as string;

      for (const pid of [rep1PartId, rep2PartId]) {
        await request(app)
          .patch(`/api/v1/trips/${tripId}/participants/${pid}`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ familyId: famAId });
      }
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${rep3PartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ familyId: famBId });

      // Legacy active unverified FAMILY_REP in DB cannot confirm settlement (Finding Audit Check)
      const unverPart = await ParticipantModel.create({
        tripId,
        userId: legacyUnverified.userId,
        familyId: famBId,
        name: 'Unverified Legacy Rep',
        email: legacyUnverified.email,
        role: 'FAMILY_REP',
        isActive: true,
      });
      const famBKidId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Beta Child', familyId: famBId })
      ).body.data.participant.id as string;
      await FamilyModel.updateOne({ _id: famBId }, { $set: { representativeId: unverPart._id } });

      const settleFamB = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({
            settlementMode: 'FAMILY',
            fromParticipantId: orgPartId,
            toParticipantId: famBKidId,
            toFamilyId: famBId,
            amountPaisa: 3000,
            status: 'REPORTED',
          })
      ).body.data.settlement.id as string;

      const unverConfirm = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${settleFamB}/status`)
        .set('Authorization', `Bearer ${legacyUnverified.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(unverConfirm.status).toBe(403);
      expect(unverConfirm.body.error.code).toBe('FORBIDDEN_SETTLEMENT_CONFIRMATION');

      // Clean up famB legacy anomaly before testing normal famB operations
      await ParticipantModel.updateOne({ _id: unverPart._id }, { $set: { role: 'PARTICIPANT' } });
      await FamilyModel.updateOne({ _id: famBId }, { $set: { representativeId: null } });

      // Finding 2 (#5, #6, #7): Promote rep1 -> FAMILY_REP on famA, then demote IN-PLACE to PARTICIPANT and CONTRIBUTOR
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: rep1PartId,
        targetToken: rep1.accessToken,
        targetEmail: rep1.email,
        grantedRole: 'FAMILY_REP',
      });
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep1PartId);

      // Demote in-place -> PARTICIPANT clears Family.representativeId!
      const demoteToPart = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${rep1PartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(demoteToPart.status).toBe(200);
      expect(demoteToPart.body.data.participant.role).toBe('PARTICIPANT');
      expect((await FamilyModel.findById(famAId))?.representativeId).toBeNull();

      // Re-promote rep1, then demote in-place -> CONTRIBUTOR clears Family.representativeId!
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: rep1PartId,
        targetToken: rep1.accessToken,
        targetEmail: rep1.email,
        grantedRole: 'FAMILY_REP',
      });
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep1PartId);

      const demoteToContrib = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${rep1PartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ role: 'CONTRIBUTOR' });
      expect(demoteToContrib.status).toBe(200);
      expect(demoteToContrib.body.data.participant.role).toBe('CONTRIBUTOR');
      expect((await FamilyModel.findById(famAId))?.representativeId).toBeNull();

      // (#7) Another eligible member in famA (rep2) can immediately receive & claim a verified FAMILY_REP invite
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: org.accessToken,
        tripId,
        participantId: rep2PartId,
        targetToken: rep2.accessToken,
        targetEmail: rep2.email,
        grantedRole: 'FAMILY_REP',
      });
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep2PartId);

      // Clear rep2 cleanly via PARTICIPANT demotion and reset rep1 to PARTICIPANT
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${rep2PartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ role: 'PARTICIPANT' });
      expect((await FamilyModel.findById(famAId))?.representativeId).toBeNull();

      // Finding 3 (#8): Re-homing rep2 via createFamily revokes stale pending FAMILY_REP invite issued in famA
      const invBeforeCreateFam = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${rep2PartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: rep2.email });
      expect(invBeforeCreateFam.status).toBe(201);
      const staleCreateTok = invBeforeCreateFam.body.data.rawToken as string;

      const createFamC = await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Gamma Family', representativeId: rep2PartId });
      expect(createFamC.status).toBe(201);
      const famCId = createFamC.body.data.family.id as string;

      const claimAfterCreateFam = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${rep2.accessToken}`)
        .send({ token: staleCreateTok });
      expect(claimAfterCreateFam.status).toBe(409);
      expect(claimAfterCreateFam.body.error.code).toBe('INVITE_REVOKED');

      // Also verify defense-in-depth familyId mismatch guard if an unrevoked legacy/bypassed invite targets famA while participant moved to famC
      const mismatchedFamilyTok = generateParticipantInviteToken(24);
      await ParticipantInviteModel.collection.insertOne({
        tripId: new mongoose.Types.ObjectId(tripId),
        participantId: new mongoose.Types.ObjectId(rep2PartId),
        familyId: new mongoose.Types.ObjectId(famAId),
        invitedByUserId: new mongoose.Types.ObjectId(org.userId),
        invitedByParticipantId: new mongoose.Types.ObjectId(orgPartId),
        tokenHash: mismatchedFamilyTok.tokenHash,
        intendedEmail: rep2.email,
        grantedRole: 'FAMILY_REP',
        requireVerifiedEmail: true,
        expiresAt: mismatchedFamilyTok.expiresAt,
        usedAt: null,
        usedByUserId: null,
        revokedAt: null,
        revokedByParticipantId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(
        claimParticipantInviteForUser({
          userId: rep2.userId,
          body: { token: mismatchedFamilyTok.rawToken },
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'INVITE_FAMILY_MISMATCH' });

      // Finding 3 (#9): Re-homing rep3 via updateFamily revokes stale pending FAMILY_REP invite issued in famB,
      // while designating same-family candidate rep1 on famA preserves valid current-family pending invite!
      const invBeforeUpdateFam = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${rep3PartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: rep3.email });
      expect(invBeforeUpdateFam.status).toBe(201);
      const staleUpdateTok = invBeforeUpdateFam.body.data.rawToken as string;

      const rehomeViaUpdateFam = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famCId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ representativeId: rep3PartId });
      expect(rehomeViaUpdateFam.status).toBe(200);
      expect((await ParticipantModel.findById(rep3PartId))?.familyId?.toString()).toBe(famCId);

      const claimAfterUpdateFam = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${rep3.accessToken}`)
        .send({ token: staleUpdateTok });
      expect(claimAfterUpdateFam.status).toBe(409);
      expect(claimAfterUpdateFam.body.error.code).toBe('INVITE_REVOKED');

      // Current-family valid invite preserved: issue invite for rep1 (currently in famA, rep=null), then nominate rep1 in famA -> rep1 can still claim!
      const validSameFamInv = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${rep1PartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: rep1.email });
      expect(validSameFamInv.status).toBe(201);
      const sameFamTok = validSameFamInv.body.data.rawToken as string;

      const setNominalSameFam = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famAId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ representativeId: rep1PartId });
      expect(setNominalSameFam.status).toBe(200);

      const claimValidSameFam = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${rep1.accessToken}`)
        .send({ token: sameFamTok });
      expect(claimValidSameFam.status).toBe(200);
      expect(claimValidSameFam.body.data.role).toBe('FAMILY_REP');

      // Finding 3 (#10): Legacy ungrouped FAMILY_REP (familyId: null) CANNOT be accepted by createFamily or updateFamily
      const legacyUngroupedRep = await ParticipantModel.create({
        tripId,
        userId: null,
        familyId: null,
        name: 'Corrupt Ungrouped Rep',
        role: 'FAMILY_REP',
        isActive: true,
      });
      const badLegacyCreate = await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Delta Family', representativeId: legacyUngroupedRep._id.toString() });
      expect(badLegacyCreate.status).toBe(409);
      expect(badLegacyCreate.body.error.code).toBe('PARTICIPANT_FAMILY_REP_CONFLICT');

      const badLegacyUpdate = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famBId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ representativeId: legacyUngroupedRep._id.toString() });
      expect(badLegacyUpdate.status).toBe(409);
      expect(badLegacyUpdate.body.error.code).toBe('PARTICIPANT_FAMILY_REP_CONFLICT');

      // Finding 5 (#12): Duplicate family name in updateFamily returns clean 409 FAMILY_EXISTS without mutating rep or revoking pending invites
      const famBMemberInv = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${famBKidId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: 'kidbeta@example.com' });
      expect(famBMemberInv.status).toBe(201);
      const famBMemberInvId = famBMemberInv.body.data.invite.id as string;

      const dupUpdateFam = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famAId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Beta Family', representativeId: null });
      expect(dupUpdateFam.status).toBe(409);
      expect(dupUpdateFam.body.error.code).toBe('FAMILY_EXISTS');
      expect((await FamilyModel.findById(famAId))?.name).toBe('Alpha Family');
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep1PartId);
      expect((await ParticipantModel.findById(rep1PartId))?.role).toBe('FAMILY_REP');
      expect((await ParticipantInviteModel.findById(famBMemberInvId))?.revokedAt).toBeNull();

      // Also verify duplicate name pre-check aborts BEFORE revoking a candidate's pending FAMILY_REP invite when re-homing
      const dupUpdateFamRehome = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famAId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Beta Family', representativeId: famBKidId });
      expect(dupUpdateFamRehome.status).toBe(409);
      expect(dupUpdateFamRehome.body.error.code).toBe('FAMILY_EXISTS');
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep1PartId);
      expect((await ParticipantModel.findById(famBKidId))?.familyId?.toString()).toBe(famBId);
      expect((await ParticipantInviteModel.findById(famBMemberInvId))?.revokedAt).toBeNull();

      // Finding 5 (#13): ActivityLog failures rollback ALL writes cleanly (including revoked invites) and never send 200 before failure
      const logsCountBefore = await ActivityLogModel.countDocuments({ tripId });

      // 13a. updateParticipant ActivityLog failure
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Log fail updateParticipant'));
      const failUpdPart = await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${rep1PartId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(failUpdPart.status).toBe(500);
      expect((await ParticipantModel.findById(rep1PartId))?.role).toBe('FAMILY_REP');
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep1PartId);

      // 13b. addParticipant ActivityLog failure
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Log fail addParticipant'));
      const failAddPart = await request(app)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Should Rollback Guest', familyId: famBId });
      expect(failAddPart.status).toBe(500);
      expect(await ParticipantModel.findOne({ tripId, name: 'Should Rollback Guest' })).toBeNull();

      // 13c. updateFamily ActivityLog failure -> rolls back Family, Participant role, AND revoked invite!
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Log fail updateFamily'));
      const failUpdFam = await request(app)
        .patch(`/api/v1/trips/${tripId}/families/${famAId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Rolled Back Name', representativeId: null });
      expect(failUpdFam.status).toBe(500);
      expect((await FamilyModel.findById(famAId))?.name).toBe('Alpha Family');
      expect((await FamilyModel.findById(famAId))?.representativeId?.toString()).toBe(rep1PartId);
      expect((await ParticipantModel.findById(rep1PartId))?.role).toBe('FAMILY_REP');

      // Test standalone revoke rollback explicitly on famB (pending famBMemberInvId revoked then rolled back by ActivityLog error)
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Log fail deleteFamily'));
      const failDelFam = await request(app)
        .delete(`/api/v1/trips/${tripId}/families/${famBId}`)
        .set('Authorization', `Bearer ${org.accessToken}`);
      expect(failDelFam.status).toBe(500);
      expect(await FamilyModel.findById(famBId)).not.toBeNull();
      expect((await ParticipantModel.findById(famBKidId))?.familyId?.toString()).toBe(famBId);
      expect((await ParticipantInviteModel.findById(famBMemberInvId))?.revokedAt).toBeNull();

      // 13d. createSettlement & updateSettlementStatus ActivityLog failure in standalone
      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Log fail createSettlement'));
      const failCreateSettle = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: famBKidId,
          toFamilyId: famBId,
          amountPaisa: 4500,
        });
      expect(failCreateSettle.status).toBe(500);
      expect(await SettlementModel.countDocuments({ tripId, amountPaisa: 4500 })).toBe(0);

      vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Log fail updateSettlement'));
      const failUpdSettle = await request(app)
        .patch(`/api/v1/trips/${tripId}/settlements/${settleFamB}/status`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ status: 'CONFIRMED' });
      expect(failUpdSettle.status).toBe(500);
      expect((await SettlementModel.findById(settleFamB))?.status).toBe('REPORTED');

      expect(await ActivityLogModel.countDocuments({ tripId })).toBe(logsCountBefore);
    }, 30000);

    it('4c. hides and fails closed (409 INVITE_FAMILY_MISMATCH) on legacy FAMILY_REP invites lacking familyId without setting usedAt', async () => {
      const org = await registerUser(app, { name: 'Legacy Org 4c', email: 'org4c@example.com' });
      const rep = await registerUser(app, { name: 'Legacy Rep 4c', email: 'rep4c@example.com' });
      const existingRep = await registerUser(app, {
        name: 'Existing Rep 4c',
        email: 'existingrep4c@example.com',
      });

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Legacy Family Invite Trip', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
      expect(tripRes.status).toBe(201);
      const tripId = tripRes.body.data.trip.id as string;
      const orgPartId = tripRes.body.data.myParticipant.id as string;

      const famNoRepRes = await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'NoRep Family' });
      const famNoRepId = famNoRepRes.body.data.family.id as string;

      const guestNoRep = await request(app)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Rep Candidate 4c', familyId: famNoRepId });
      const guestNoRepId = guestNoRep.body.data.participant.id as string;

      const famWithRepRes = await request(app)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Occupied Family' });
      const famWithRepId = famWithRepRes.body.data.family.id as string;

      const occupiedGuest = await request(app)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Occupied Slot', familyId: famWithRepId });
      const occupiedGuestId = occupiedGuest.body.data.participant.id as string;

      // Occupy famWithRep with existingRep
      const occupyJoin = await request(app)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Current Fam Rep', familyId: famWithRepId });
      const currentRepPartId = occupyJoin.body.data.participant.id as string;
      const currentRepInv = await request(app)
        .post(`/api/v1/trips/${tripId}/participants/${currentRepPartId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: existingRep.email });
      expect(
        (
          await request(app)
            .post('/api/v1/trips/invites/claim')
            .set('Authorization', `Bearer ${existingRep.accessToken}`)
            .send({ token: currentRepInv.body.data.rawToken })
        ).status
      ).toBe(200);

      // Insert raw legacy FAMILY_REP invites: one with familyId: null, one with familyId absent
      const nullFamTok = generateParticipantInviteToken(24);
      const absentFamTok = generateParticipantInviteToken(24);
      const now = new Date();
      const nullInsert = await ParticipantInviteModel.collection.insertOne({
        tripId: new mongoose.Types.ObjectId(tripId),
        participantId: new mongoose.Types.ObjectId(guestNoRepId),
        invitedByUserId: new mongoose.Types.ObjectId(org.userId),
        invitedByParticipantId: new mongoose.Types.ObjectId(orgPartId),
        tokenHash: nullFamTok.tokenHash,
        intendedEmail: rep.email,
        grantedRole: 'FAMILY_REP',
        requireVerifiedEmail: true,
        familyId: null,
        expiresAt: nullFamTok.expiresAt,
        usedAt: null,
        usedByUserId: null,
        revokedAt: null,
        revokedByParticipantId: null,
        createdAt: now,
        updatedAt: now,
      });

      const absentInsert = await ParticipantInviteModel.collection.insertOne({
        tripId: new mongoose.Types.ObjectId(tripId),
        participantId: new mongoose.Types.ObjectId(occupiedGuestId),
        invitedByUserId: new mongoose.Types.ObjectId(org.userId),
        invitedByParticipantId: new mongoose.Types.ObjectId(orgPartId),
        tokenHash: absentFamTok.tokenHash,
        intendedEmail: rep.email,
        grantedRole: 'FAMILY_REP',
        requireVerifiedEmail: true,
        expiresAt: absentFamTok.expiresAt,
        usedAt: null,
        usedByUserId: null,
        revokedAt: null,
        revokedByParticipantId: null,
        createdAt: now,
        updatedAt: now,
      });

      // Pending invites discovery must exclude both invalid legacy FAMILY_REP invites
      const pendingRes = await request(app)
        .get('/api/v1/trips/invites/pending')
        .set('Authorization', `Bearer ${rep.accessToken}`);
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.data.invites).toHaveLength(0);

      // Claiming either fails closed with 409 INVITE_FAMILY_MISMATCH without setting usedAt or mutating role
      const claimNull = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${rep.accessToken}`)
        .send({ token: nullFamTok.rawToken });
      expect(claimNull.status).toBe(409);
      expect(claimNull.body.error.code).toBe('INVITE_FAMILY_MISMATCH');

      const claimAbsent = await request(app)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${rep.accessToken}`)
        .send({ token: absentFamTok.rawToken });
      expect(claimAbsent.status).toBe(409);
      expect(claimAbsent.body.error.code).toBe('INVITE_FAMILY_MISMATCH');

      expect((await ParticipantInviteModel.findById(nullInsert.insertedId))?.usedAt).toBeNull();
      expect((await ParticipantInviteModel.findById(absentInsert.insertedId))?.usedAt).toBeNull();
      expect((await ParticipantModel.findById(guestNoRepId))?.role).toBe('PARTICIPANT');
      expect((await ParticipantModel.findById(guestNoRepId))?.userId).toBeNull();
      expect((await FamilyModel.findById(famNoRepId))?.representativeId).toBeNull();
      expect((await FamilyModel.findById(famWithRepId))?.representativeId?.toString()).toBe(
        currentRepPartId
      );
    }, 30000);

    it('5b. serializes addParticipant vs deleteFamily in standalone and enforces createSettlement status & live-actor normalization', async () => {
      const org = await registerUser(app, { name: 'Race Org S5', email: 'raceorg.s5@example.com' });
      const rep = await registerUser(app, { name: 'Race Rep S5', email: 'racerep.s5@example.com' });

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Standalone Serialize Trip', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;
      const orgPartId = tripRes.body.data.myParticipant.id as string;

      const famId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Target Del Fam' })
      ).body.data.family.id as string;

      const repPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${rep.accessToken}`)
      ).body.data.participantId as string;

      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repPartId}`)
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

      const famChildId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Child Keep', familyId: famId })
      ).body.data.participant.id as string;

      // Reject initial PENDING / REJECTED statuses in createSettlement
      for (const badStatus of ['PENDING', 'REJECTED']) {
        const res = await request(app)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({
            settlementMode: 'FAMILY',
            fromParticipantId: orgPartId,
            toParticipantId: famChildId,
            amountPaisa: 1000,
            status: badStatus,
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_SETTLEMENT_STATUS');
      }

      // FAMILY_REP passing status: 'CONFIRMED' on POST /settlements for non-self receiver normalizes to REPORTED
      const repCreateConfirmed = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${rep.accessToken}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: orgPartId,
          toParticipantId: famChildId,
          toFamilyId: famId,
          amountPaisa: 2500,
          status: 'CONFIRMED',
        });
      expect(repCreateConfirmed.status).toBe(201);
      expect(repCreateConfirmed.body.data.settlement.status).toBe('REPORTED');

      // Concurrent addParticipant vs deleteFamily across two instances in standalone mode -> zero dangling familyId!
      const [addRes, delRes] = await Promise.all([
        request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Racing Child', familyId: famId }),
        request(appB)
          .delete(`/api/v1/trips/${tripId}/families/${famId}`)
          .set('Authorization', `Bearer ${org.accessToken}`),
      ]);

      expect(delRes.status).toBe(200);
      expect([201, 404]).toContain(addRes.status);
      expect(await FamilyModel.findById(famId)).toBeNull();
      expect(await ParticipantModel.countDocuments({ tripId, familyId: famId })).toBe(0);
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
    }, 30000);

    it('5. serializes concurrent settlement creation, trip closure, demotion/deactivation, family deletion, addParticipant, dual settlement status updates, and dual rep swaps on real replica set', async () => {
      expect(await supportsTransactions()).toBe(true);

      const lead = await registerUser(app, { name: 'RS Lead', email: 'rslead@example.com' });
      const coOrg1 = await registerUser(app, { name: 'RS CoOrg1', email: 'rscoorg1@example.com' });
      const coOrg2 = await registerUser(app, { name: 'RS CoOrg2', email: 'rscoorg2@example.com' });
      const repA = await registerUser(app, { name: 'RS RepA', email: 'rsrepa@example.com' });
      const repB = await registerUser(app, { name: 'RS RepB', email: 'rsrepb@example.com' });

      const tripRes = await request(app)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${lead.accessToken}`)
        .send({ name: 'Repl Concurrency Trip', mode: 'FAMILY', organizerFamilyName: 'Lead Fam' });
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;
      const leadPartId = tripRes.body.data.myParticipant.id as string;

      const famAId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ name: 'Repl Fam A' })
      ).body.data.family.id as string;
      const famBId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ name: 'Repl Fam B' })
      ).body.data.family.id as string;

      const coOrg1PartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${coOrg1.accessToken}`)
      ).body.data.participantId as string;
      const coOrg2PartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${coOrg2.accessToken}`)
      ).body.data.participantId as string;
      const repAPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${repA.accessToken}`)
      ).body.data.participantId as string;
      const repBPartId = (
        await request(app)
          .post(`/api/v1/trips/join/${inviteCode}`)
          .set('Authorization', `Bearer ${repB.accessToken}`)
      ).body.data.participantId as string;

      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: lead.accessToken,
        tripId,
        participantId: coOrg1PartId,
        targetToken: coOrg1.accessToken,
        targetEmail: coOrg1.email,
        grantedRole: 'ORGANIZER',
      });
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: lead.accessToken,
        tripId,
        participantId: coOrg2PartId,
        targetToken: coOrg2.accessToken,
        targetEmail: coOrg2.email,
        grantedRole: 'ORGANIZER',
      });

      const famAChildId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ name: 'Repl FamA Child', familyId: famAId })
      ).body.data.participant.id as string;

      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repAPartId}`)
        .set('Authorization', `Bearer ${lead.accessToken}`)
        .send({ familyId: famAId });
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repBPartId}`)
        .set('Authorization', `Bearer ${lead.accessToken}`)
        .send({ familyId: famAId });

      // (#1) Organizer demotion racing with createSettlement (status: CONFIRMED)
      const [demoteCo1Res, co1CreateSettleRes] = await Promise.all([
        request(app)
          .patch(`/api/v1/trips/${tripId}/participants/${coOrg1PartId}`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ role: 'PARTICIPANT' }),
        request(appB)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${coOrg1.accessToken}`)
          .send({
            settlementMode: 'INDIVIDUAL',
            fromParticipantId: coOrg1PartId,
            toParticipantId: leadPartId,
            amountPaisa: 1111,
            status: 'CONFIRMED',
          }),
      ]);
      expect(demoteCo1Res.status).toBe(200);
      expect(co1CreateSettleRes.status).toBe(201);
      // Verify consistency with serialized log ordering: if createSettlement ran AFTER demotion it was normalized to REPORTED
      const settle1Logs = await ActivityLogModel.find({
        tripId,
        actionType: { $in: ['PARTICIPANT_UPDATED', 'SETTLEMENT_REPORTED', 'SETTLEMENT_CONFIRMED'] },
      })
        .sort({ _id: 1 })
        .lean();
      const s1Obj = await SettlementModel.findById(co1CreateSettleRes.body.data.settlement.id);
      if (s1Obj?.status === 'CONFIRMED') {
        expect(co1CreateSettleRes.body.data.settlement.confirmedByParticipantId).toBe(coOrg1PartId);
      } else {
        expect(s1Obj?.status).toBe('REPORTED');
      }
      expect(settle1Logs.length).toBeGreaterThanOrEqual(2);

      // Verify post-demotion live check strictly normalizes coOrg1 CONFIRMED -> REPORTED
      const afterDemoteSettle = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${coOrg1.accessToken}`)
        .send({
          settlementMode: 'INDIVIDUAL',
          fromParticipantId: coOrg1PartId,
          toParticipantId: leadPartId,
          amountPaisa: 1212,
          status: 'CONFIRMED',
        });
      expect(afterDemoteSettle.status).toBe(201);
      expect(afterDemoteSettle.body.data.settlement.status).toBe('REPORTED');

      // (#2) Organizer deactivation racing with createSettlement
      const [deactCo2Res, co2SettleRes] = await Promise.all([
        request(app)
          .patch(`/api/v1/trips/${tripId}/participants/${coOrg2PartId}`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ isActive: false }),
        request(appB)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${coOrg2.accessToken}`)
          .send({
            settlementMode: 'INDIVIDUAL',
            fromParticipantId: coOrg2PartId,
            toParticipantId: leadPartId,
            amountPaisa: 2222,
            status: 'CONFIRMED',
          }),
      ]);
      expect(deactCo2Res.status).toBe(200);
      expect([201, 403]).toContain(co2SettleRes.status);
      if (co2SettleRes.status === 403) {
        expect(co2SettleRes.body.error.code).toBe('FORBIDDEN_TRIP_ACCESS');
        expect(await SettlementModel.countDocuments({ tripId, amountPaisa: 2222 })).toBe(0);
      }

      // (#11 & #4) Simultaneous addParticipant + deleteFamily + createSettlement with famA
      const [addFamChildRes, delFamARes, settleExplicitFamARes] = await Promise.all([
        request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ name: 'Repl Racing Kid', familyId: famAId }),
        request(appB)
          .delete(`/api/v1/trips/${tripId}/families/${famAId}`)
          .set('Authorization', `Bearer ${lead.accessToken}`),
        request(app)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({
            settlementMode: 'FAMILY',
            fromParticipantId: leadPartId,
            toParticipantId: famAChildId,
            toFamilyId: famAId,
            amountPaisa: 3333,
            status: 'REPORTED',
          }),
      ]);
      expect(delFamARes.status).toBe(200);
      expect([201, 404]).toContain(addFamChildRes.status);
      expect([201, 404]).toContain(settleExplicitFamARes.status);
      expect(await FamilyModel.findById(famAId)).toBeNull();
      expect(await ParticipantModel.countDocuments({ tripId, familyId: famAId })).toBe(0);

      // (#4 continued) Participant move across families racing with createSettlement (explicit stale familyId)
      const famCId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/families`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ name: 'Repl Fam C' })
      ).body.data.family.id as string;
      const moveTargetId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ name: 'Move Target', familyId: famBId })
      ).body.data.participant.id as string;

      const [moveRes, explicitFamBSettleRes] = await Promise.all([
        request(app)
          .patch(`/api/v1/trips/${tripId}/participants/${moveTargetId}`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ familyId: famCId }),
        request(appB)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({
            settlementMode: 'FAMILY',
            fromParticipantId: leadPartId,
            toParticipantId: moveTargetId,
            toFamilyId: famBId,
            amountPaisa: 4444,
            status: 'REPORTED',
          }),
      ]);
      expect(moveRes.status).toBe(200);
      expect([201, 400]).toContain(explicitFamBSettleRes.status);
      if (explicitFamBSettleRes.status === 400) {
        expect(explicitFamBSettleRes.body.error.code).toBe('SETTLEMENT_FAMILY_MISMATCH');
      }

      // Dual simultaneous PATCH /families/:famCId representative swaps across two instances
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repAPartId}`)
        .set('Authorization', `Bearer ${lead.accessToken}`)
        .send({ familyId: famCId });
      await request(app)
        .patch(`/api/v1/trips/${tripId}/participants/${repBPartId}`)
        .set('Authorization', `Bearer ${lead.accessToken}`)
        .send({ familyId: famCId });

      const [swapA, swapB] = await Promise.all([
        request(app)
          .patch(`/api/v1/trips/${tripId}/families/${famCId}`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ representativeId: repAPartId }),
        request(appB)
          .patch(`/api/v1/trips/${tripId}/families/${famCId}`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ representativeId: repBPartId }),
      ]);
      expect(swapA.status).toBe(200);
      expect(swapB.status).toBe(200);
      const finalRepId = (await FamilyModel.findById(famCId))?.representativeId?.toString();
      expect([repAPartId, repBPartId]).toContain(finalRepId);

      // Promote final designated rep via verified invite, then test dual simultaneous PATCH /settlements/:id/status
      const winnerRep = finalRepId === repAPartId ? repA : repB;
      await promoteParticipantViaVerifiedInvite({
        app,
        organizerToken: lead.accessToken,
        tripId,
        participantId: finalRepId!,
        targetToken: winnerRep.accessToken,
        targetEmail: winnerRep.email,
        grantedRole: 'FAMILY_REP',
      });
      const raceSettleId = (
        await request(app)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({
            settlementMode: 'FAMILY',
            fromParticipantId: leadPartId,
            toParticipantId: moveTargetId,
            toFamilyId: famCId,
            amountPaisa: 5555,
            status: 'REPORTED',
          })
      ).body.data.settlement.id as string;

      const logsBeforeDualConfirm = await ActivityLogModel.countDocuments({
        tripId,
        entityId: raceSettleId,
        actionType: { $in: ['SETTLEMENT_CONFIRMED', 'SETTLEMENT_REJECTED'] },
      });
      const [statusRace1, statusRace2] = await Promise.all([
        request(app)
          .patch(`/api/v1/trips/${tripId}/settlements/${raceSettleId}/status`)
          .set('Authorization', `Bearer ${winnerRep.accessToken}`)
          .send({ status: 'CONFIRMED' }),
        request(appB)
          .patch(`/api/v1/trips/${tripId}/settlements/${raceSettleId}/status`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ status: 'REJECTED' }),
      ]);
      expect([statusRace1.status, statusRace2.status].sort((a, b) => a - b)).toEqual([200, 409]);
      expect(
        await ActivityLogModel.countDocuments({
          tripId,
          entityId: raceSettleId,
          actionType: { $in: ['SETTLEMENT_CONFIRMED', 'SETTLEMENT_REJECTED'] },
        })
      ).toBe(logsBeforeDualConfirm + 1);

      // (#3) closeTrip racing with createSettlement across two instances
      const [closeTripRes, closeRaceSettleRes] = await Promise.all([
        request(app)
          .post(`/api/v1/trips/${tripId}/close`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({ forceClose: true }),
        request(appB)
          .post(`/api/v1/trips/${tripId}/settlements`)
          .set('Authorization', `Bearer ${lead.accessToken}`)
          .send({
            settlementMode: 'INDIVIDUAL',
            fromParticipantId: leadPartId,
            toParticipantId: repAPartId,
            amountPaisa: 6666,
            status: 'CONFIRMED',
          }),
      ]);
      expect(closeTripRes.status).toBe(200);
      expect((await TripModel.findById(tripId))?.status).toBe('CLOSED');
      expect([201, 403]).toContain(closeRaceSettleRes.status);
      if (closeRaceSettleRes.status === 403) {
        expect(closeRaceSettleRes.body.error.code).toBe('TRIP_CLOSED');
        expect(await SettlementModel.countDocuments({ tripId, amountPaisa: 6666 })).toBe(0);
      }

      // Immediately after close, createSettlement is deterministically blocked
      const postCloseSettle = await request(app)
        .post(`/api/v1/trips/${tripId}/settlements`)
        .set('Authorization', `Bearer ${lead.accessToken}`)
        .send({
          settlementMode: 'INDIVIDUAL',
          fromParticipantId: leadPartId,
          toParticipantId: repAPartId,
          amountPaisa: 7777,
        });
      expect(postCloseSettle.status).toBe(403);
      expect(postCloseSettle.body.error.code).toBe('TRIP_CLOSED');
    }, 30000);
  });
});
