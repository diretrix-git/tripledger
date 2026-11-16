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
  TripModel,
  UserModel,
} from '../models/index.js';
import { supportsTransactions } from '../services/atomicWrite.js';
import {
  clearTestEmailOutbox,
  EmailDeliveryService,
  getTestEmailOutbox,
} from '../services/emailService.js';
import { hashToken } from '../utils/tokens.js';
import { AppError } from '../utils/http.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_phase3_invites';

function extractVerificationToken(urlString: string): string {
  const token = new URL(urlString).searchParams.get('token');
  if (!token) throw new Error('Missing verification token');
  return token;
}

async function registerAndVerifyUser(
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
    expect(ver.body.data.verified).toBe(true);
  }

  return { userId, accessToken, email: params.email.toLowerCase() };
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
  throw new Error('mongod executable required for replica-set Phase 3 tests.');
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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripledger-replset-p3-'));
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
      // ignore delayed Windows unlock
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

    const uri = `mongodb://127.0.0.1:${port}/tripledger_test_p3_replset?directConnection=true`;
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

describe('Phase 3: Verified Invitation-Based Role Promotion (SEC-01)', () => {
  const appInstanceA = createApp();
  const appInstanceB = createApp();

  describe('Standalone MongoDB suite', () => {
    beforeAll(async () => {
      await connectDatabase(TEST_DB_URI);
      await Promise.all([
        UserModel.createIndexes(),
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
      ]);
    }, 30000);

    beforeEach(async () => {
      clearTestEmailOutbox();
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await Promise.all([
        UserModel.createIndexes(),
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
      ]);
    });

    afterEach(() => {
      clearTestEmailOutbox();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await disconnectDatabase();
    });

    it('1. restricts guest creation strictly to PARTICIPANT, blocks direct PATCH promotion to privileged roles, and keeps open invite join at PARTICIPANT', async () => {
      const org = await registerAndVerifyUser(appInstanceA, {
        name: 'Lead Organizer',
        email: 'lead.p3@example.com',
      });
      const member = await registerAndVerifyUser(appInstanceA, {
        name: 'Verified Member',
        email: 'member.p3@example.com',
      });

      const tripRes = await request(appInstanceA)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Manaslu Trek', mode: 'FAMILY', organizerFamilyName: 'Lead Fam' });
      expect(tripRes.status).toBe(201);
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;

      // Guest creation rejects ORGANIZER, FAMILY_REP, and CONTRIBUTOR
      for (const disallowedRole of ['ORGANIZER', 'FAMILY_REP', 'CONTRIBUTOR']) {
        const badGuest = await request(appInstanceA)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({
            name: `Bad ${disallowedRole}`,
            email: `${disallowedRole.toLowerCase()}@example.com`,
            role: disallowedRole,
          });
        expect(badGuest.status).toBe(400);
      }

      // Valid guest defaults/accepts PARTICIPANT only (userId: null)
      const guestRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Guest Trekker', role: 'PARTICIPANT' });
      expect(guestRes.status).toBe(201);
      expect(guestRes.body.data.participant.role).toBe('PARTICIPANT');
      expect(guestRes.body.data.participant.userId).toBeNull();
      const guestId = guestRes.body.data.participant.id as string;

      // Guest cannot be promoted via PATCH to ORGANIZER, FAMILY_REP, or CONTRIBUTOR
      for (const role of ['ORGANIZER', 'FAMILY_REP']) {
        const res = await request(appInstanceA)
          .patch(`/api/v1/trips/${tripId}/participants/${guestId}`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ role });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('PRIVILEGED_ROLE_REQUIRES_INVITE');
      }
      const guestContribRes = await request(appInstanceA)
        .patch(`/api/v1/trips/${tripId}/participants/${guestId}`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ role: 'CONTRIBUTOR' });
      expect(guestContribRes.status).toBe(400);
      expect(guestContribRes.body.error.code).toBe('GUEST_ROLE_RESTRICTED');

      // Open invite join always assigns PARTICIPANT (even for verified accounts)
      const joinRes = await request(appInstanceA)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${member.accessToken}`);
      expect(joinRes.status).toBe(200);
      expect(joinRes.body.data.role).toBe('PARTICIPANT');
      const memberPartId = joinRes.body.data.participantId as string;

      // Even linked verified participant cannot be directly promoted to ORGANIZER/FAMILY_REP via PATCH
      for (const privRole of ['ORGANIZER', 'FAMILY_REP']) {
        const directPromo = await request(appInstanceA)
          .patch(`/api/v1/trips/${tripId}/participants/${memberPartId}`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ role: privRole });
        expect(directPromo.status).toBe(400);
        expect(directPromo.body.error.code).toBe('PRIVILEGED_ROLE_REQUIRES_INVITE');
      }
      expect((await ParticipantModel.findById(memberPartId))?.role).toBe('PARTICIPANT');
    });

    it('2. blocks unauthenticated users, unverified accounts, legacy unverified accounts, and wrong verified emails without burning invites', async () => {
      const org = await registerAndVerifyUser(appInstanceA, {
        name: 'Trip Lead',
        email: 'lead2.p3@example.com',
      });
      const unverifiedTarget = await registerAndVerifyUser(
        appInstanceA,
        { name: 'Unverified Target', email: 'intended.p3@example.com' },
        false
      );
      const unverifiedTargetVerifyToken = extractVerificationToken(
        getTestEmailOutbox()[getTestEmailOutbox().length - 1]!.verificationUrl
      );
      const wrongVerified = await registerAndVerifyUser(appInstanceA, {
        name: 'Wrong Verified',
        email: 'wrong.verified@example.com',
      });

      const tripRes = await request(appInstanceA)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Langtang Trip', mode: 'FRIENDS' });
      const tripId = tripRes.body.data.trip.id as string;

      const guestRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Intended Co-Organizer' });
      const guestId = guestRes.body.data.participant.id as string;

      // Privileged invite without intendedEmail is rejected cleanly
      const badInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${guestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER' });
      expect(badInvite.status).toBe(400);

      // Valid ORGANIZER email-bound invite issues SHA-256 hash in DB & dispatches invite email
      clearTestEmailOutbox();
      const inviteRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${guestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: 'intended.p3@example.com' });
      expect(inviteRes.status).toBe(201);
      const rawToken = inviteRes.body.data.rawToken as string;
      const inviteId = inviteRes.body.data.invite.id as string;
      expect(inviteRes.body.data.emailDelivery.sent).toBe(true);
      expect(rawToken.length).toBeGreaterThanOrEqual(32);

      const dbInvite = await ParticipantInviteModel.findById(inviteId).select('+tokenHash');
      expect(dbInvite?.tokenHash).toBe(hashToken(rawToken));
      expect(dbInvite?.tokenHash).not.toBe(rawToken);
      const outbox = getTestEmailOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.inviteUrl).toContain(`/invites/claim?token=${rawToken}`);

      // a. Unauthenticated user cannot redeem or list pending invites
      const unauthClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .send({ token: rawToken });
      expect(unauthClaim.status).toBe(401);

      const unauthPending = await request(appInstanceA).get('/api/v1/trips/invites/pending');
      expect(unauthPending.status).toBe(401);

      // b. Unverified intended user cannot redeem or inspect pending invites (and legacy account stays unverified)
      const unverifiedPending = await request(appInstanceA)
        .get('/api/v1/trips/invites/pending')
        .set('Authorization', `Bearer ${unverifiedTarget.accessToken}`);
      expect(unverifiedPending.status).toBe(403);
      expect(unverifiedPending.body.error.code).toBe('EMAIL_NOT_VERIFIED');

      const unverifiedClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${unverifiedTarget.accessToken}`)
        .send({ token: rawToken });
      expect(unverifiedClaim.status).toBe(403);
      expect(unverifiedClaim.body.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect((await UserModel.findById(unverifiedTarget.userId))?.emailVerified).toBe(false);

      // c. Wrong verified email holding valid rawToken fails 403 INVITE_EMAIL_MISMATCH and DOES NOT burn invite
      const wrongClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${wrongVerified.accessToken}`)
        .send({ token: rawToken });
      expect(wrongClaim.status).toBe(403);
      expect(wrongClaim.body.error.code).toBe('INVITE_EMAIL_MISMATCH');
      expect(wrongClaim.body.error.message).not.toContain('intended.p3@example.com');
      expect((await ParticipantInviteModel.findById(inviteId))?.usedAt).toBeNull();

      // d. Once intended user verifies exact email, pending shows metadata (no token) and claim succeeds
      const verifyTargetRes = await request(appInstanceA)
        .post('/api/v1/auth/verify-email')
        .send({ token: unverifiedTargetVerifyToken });
      expect(verifyTargetRes.status).toBe(200);

      const pendingRes = await request(appInstanceA)
        .get('/api/v1/trips/invites/pending')
        .set('Authorization', `Bearer ${unverifiedTarget.accessToken}`);
      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.data.invites).toHaveLength(1);
      expect(JSON.stringify(pendingRes.body)).not.toContain(rawToken);

      const claimRes = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${unverifiedTarget.accessToken}`)
        .send({ token: rawToken });
      expect(claimRes.status).toBe(200);
      expect(claimRes.body.data.role).toBe('ORGANIZER');
      expect(claimRes.body.data.participant.userId).toBe(unverifiedTarget.userId);

      // e. Reusing redeemed invite cannot re-grant or replay
      const replayRes = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${unverifiedTarget.accessToken}`)
        .send({ token: rawToken });
      expect(replayRes.status).toBe(409);
      expect(replayRes.body.error.code).toBe('INVITE_ALREADY_USED');

      // f. Redeemed invite cannot be revoked either
      const revokeUsed = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/invites/${inviteId}/revoke`)
        .set('Authorization', `Bearer ${org.accessToken}`);
      expect(revokeUsed.status).toBe(409);
      expect(revokeUsed.body.error.code).toBe('INVITE_ALREADY_USED');

      // g. Activity logs must never contain rawToken or tokenHash
      const logs = await ActivityLogModel.find({ tripId }).lean();
      const serializedLogs = JSON.stringify(logs);
      expect(serializedLogs).not.toContain(rawToken);
      expect(serializedLogs).not.toContain(hashToken(rawToken));
    }, 15000);

    it('3. enforces expiry, revocation, superseding duplicate invites, existing-account safety, organizer invariant, and organizer-only credential visibility', async () => {
      const org = await registerAndVerifyUser(appInstanceA, {
        name: 'Primary Org',
        email: 'primary.org3@example.com',
      });
      const repCandidate = await registerAndVerifyUser(appInstanceA, {
        name: 'Rep Candidate',
        email: 'rep.cand@example.com',
      });
      const regularMember = await registerAndVerifyUser(appInstanceA, {
        name: 'Regular Member',
        email: 'regular.p3@example.com',
      });
      const outsider = await registerAndVerifyUser(appInstanceA, {
        name: 'Outsider',
        email: 'outsider.p3@example.com',
      });

      const tripRes = await request(appInstanceA)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Annapurna Family Loop', mode: 'FAMILY', organizerFamilyName: 'Org Family' });
      const tripId = tripRes.body.data.trip.id as string;
      const inviteCode = tripRes.body.data.trip.inviteCode as string;
      const orgParticipantId = tripRes.body.data.myParticipant.id as string;

      const fam2Res = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/families`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Karki Family' });
      const fam2Id = fam2Res.body.data.family.id as string;

      // Regular member joins via open invite code -> inviteCode MUST NOT be visible to non-organizers
      const joinRegular = await request(appInstanceA)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${regularMember.accessToken}`);
      expect(joinRegular.status).toBe(200);
      expect(joinRegular.body.data.trip.inviteCode).toBeUndefined();
      const regularParticipantId = joinRegular.body.data.participantId as string;

      const memberGetTrip = await request(appInstanceA)
        .get(`/api/v1/trips/${tripId}`)
        .set('Authorization', `Bearer ${regularMember.accessToken}`);
      expect(memberGetTrip.status).toBe(200);
      expect(memberGetTrip.body.data.trip.inviteCode).toBeUndefined();

      const memberListTrips = await request(appInstanceA)
        .get('/api/v1/trips')
        .set('Authorization', `Bearer ${regularMember.accessToken}`);
      expect(memberListTrips.body.data.trips[0].inviteCode).toBeUndefined();

      const memberDash = await request(appInstanceA)
        .get('/api/v1/dashboard/summary')
        .set('Authorization', `Bearer ${regularMember.accessToken}`);
      expect(memberDash.body.data.trips[0].inviteCode).toBeUndefined();

      // Non-organizers and outsiders cannot view or manage invites
      for (const token of [regularMember.accessToken, outsider.accessToken]) {
        const expectedStatus = 403;
        const listInv = await request(appInstanceA)
          .get(`/api/v1/trips/${tripId}/invites`)
          .set('Authorization', `Bearer ${token}`);
        expect(listInv.status).toBe(expectedStatus);

        const issueInv = await request(appInstanceA)
          .post(`/api/v1/trips/${tripId}/participants/${regularParticipantId}/invites`)
          .set('Authorization', `Bearer ${token}`)
          .send({ grantedRole: 'ORGANIZER', intendedEmail: regularMember.email });
        expect(issueInv.status).toBe(expectedStatus);
      }

      // Organizer DOES see inviteCode and invite list (with zero tokenHash/rawToken exposure)
      const orgGetTrip = await request(appInstanceA)
        .get(`/api/v1/trips/${tripId}`)
        .set('Authorization', `Bearer ${org.accessToken}`);
      expect(orgGetTrip.body.data.trip.inviteCode).toBe(inviteCode);

      // Issue first invite on a guest in Karki Family, then supersede by issuing a second invite
      const repGuest = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Hari Karki', familyId: fam2Id });
      const repGuestId = repGuest.body.data.participant.id as string;

      const firstInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${repGuestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repCandidate.email });
      expect(firstInvite.status).toBe(201);
      const firstRawToken = firstInvite.body.data.rawToken as string;

      const secondInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${repGuestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repCandidate.email });
      expect(secondInvite.status).toBe(201);
      const secondRawToken = secondInvite.body.data.rawToken as string;
      const secondInviteId = secondInvite.body.data.invite.id as string;

      // Old superseded invite token fails with INVITE_REVOKED
      const supersededClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${repCandidate.accessToken}`)
        .send({ token: firstRawToken });
      expect(supersededClaim.status).toBe(409);
      expect(supersededClaim.body.error.code).toBe('INVITE_REVOKED');

      // Explicitly revoke second invite -> fails on redemption
      const revokeRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/invites/${secondInviteId}/revoke`)
        .set('Authorization', `Bearer ${org.accessToken}`);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.data.invite.revokedAt).toBeTruthy();

      const revokedClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${repCandidate.accessToken}`)
        .send({ token: secondRawToken });
      expect(revokedClaim.status).toBe(409);
      expect(revokedClaim.body.error.code).toBe('INVITE_REVOKED');

      // Expired invite cannot be redeemed
      const expInviteRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${repGuestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repCandidate.email });
      const expRawToken = expInviteRes.body.data.rawToken as string;
      await ParticipantInviteModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(expInviteRes.body.data.invite.id as string) },
        { $set: { expiresAt: new Date(Date.now() - 60_000) } }
      );
      const expiredClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${repCandidate.accessToken}`)
        .send({ token: expRawToken });
      expect(expiredClaim.status).toBe(400);
      expect(expiredClaim.body.error.code).toBe('INVITE_EXPIRED');

      // Valid FAMILY_REP invite links repCandidate and populates empty Family.representativeId
      const validRepInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${repGuestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'FAMILY_REP', intendedEmail: repCandidate.email });
      const validRepToken = validRepInvite.body.data.rawToken as string;

      const claimRep = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${repCandidate.accessToken}`)
        .send({ token: validRepToken });
      expect(claimRep.status).toBe(200);
      expect(claimRep.body.data.role).toBe('FAMILY_REP');
      expect(claimRep.body.data.trip.inviteCode).toBeUndefined();
      expect((await FamilyModel.findById(fam2Id))?.representativeId?.toString()).toBe(repGuestId);

      // Existing linked user cannot be reassigned or replaced: issuing invite with different email on linked slot -> 409
      const wrongEmailForLinked = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${repGuestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: regularMember.email });
      expect(wrongEmailForLinked.status).toBe(409);
      expect(wrongEmailForLinked.body.error.code).toBe('PARTICIPANT_ALREADY_LINKED');

      // Second guest invite targeting regularMember (already linked in another slot in same trip) is rejected -> 409
      const spareGuest = (
        await request(appInstanceA)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Duplicate Slot' })
      ).body.data.participant.id as string;
      const dupSlotInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${spareGuest}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: regularMember.email });
      expect(dupSlotInvite.status).toBe(409);
      expect(dupSlotInvite.body.error.code).toBe('ALREADY_TRIP_MEMBER');

      // Even if a guest invite existed BEFORE regularMember joined via open invite code, claim rejects ALREADY_TRIP_MEMBER
      const outsiderGuest = (
        await request(appInstanceA)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Pre-Joined Target' })
      ).body.data.participant.id as string;
      const preJoinInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${outsiderGuest}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: outsider.email });
      const preJoinRaw = preJoinInvite.body.data.rawToken as string;
      // Outsider joins via open invite code first -> creates PARTICIPANT slot
      await request(appInstanceA)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${outsider.accessToken}`);
      const conflictClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({ token: preJoinRaw });
      expect(conflictClaim.status).toBe(409);
      expect(conflictClaim.body.error.code).toBe('ALREADY_TRIP_MEMBER');

      // Sole linked organizer invariant holds across invite redemption:
      // Demoting sole organizer via low-role invite fails with SOLE_ORGANIZER
      const selfDemoteInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${orgParticipantId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'PARTICIPANT', intendedEmail: org.email });
      const selfDemoteClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ token: selfDemoteInvite.body.data.rawToken as string });
      expect(selfDemoteClaim.status).toBe(400);
      expect(selfDemoteClaim.body.error.code).toBe('SOLE_ORGANIZER');

      // Promote regularMember's OWN linked participant record to ORGANIZER via verified invite -> succeeds & now org can demote self
      const coInvite = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${regularParticipantId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: regularMember.email });
      expect(coInvite.status).toBe(201);
      const coClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${regularMember.accessToken}`)
        .send({ token: coInvite.body.data.rawToken as string });
      expect(coClaim.status).toBe(200);
      expect(coClaim.body.data.trip.inviteCode).toBe(inviteCode);

      const demoteOrgNowValid = await request(appInstanceA)
        .patch(`/api/v1/trips/${tripId}/participants/${orgParticipantId}`)
        .set('Authorization', `Bearer ${regularMember.accessToken}`)
        .send({ role: 'PARTICIPANT' });
      expect(demoteOrgNowValid.status).toBe(200);

      // Organizer invite listing returns metadata ONLY without raw tokens or hashes
      const orgInvList = await request(appInstanceA)
        .get(`/api/v1/trips/${tripId}/invites`)
        .set('Authorization', `Bearer ${regularMember.accessToken}`);
      expect(orgInvList.status).toBe(200);
      expect(orgInvList.body.data.invites.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(orgInvList.body)).not.toContain(coInvite.body.data.rawToken as string);
      expect(JSON.stringify(orgInvList.body)).not.toContain('tokenHash');
    }, 30000);

    it('4. fails closed and revokes newly created privileged invite when EmailDeliveryService delivery fails', async () => {
      const failingEmailApp = createApp({
        emailDeliveryService: {
          sendVerificationEmail: vi.fn(async () => ({ provider: 'MEMORY' as const })),
          sendParticipantInviteEmail: vi.fn(async () => {
            throw new AppError(
              'Unable to deliver invitation email.',
              503,
              'EMAIL_DELIVERY_FAILED'
            );
          }),
        } as unknown as EmailDeliveryService,
      });

      const org = await registerAndVerifyUser(appInstanceA, {
        name: 'Outage Lead',
        email: 'outage.org@example.com',
      });

      const tripRes = await request(failingEmailApp)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'SMTP Outage Trip', mode: 'FRIENDS' });
      const tripId = tripRes.body.data.trip.id as string;

      const guestRes = await request(failingEmailApp)
        .post(`/api/v1/trips/${tripId}/participants`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Target CoOrg' });
      const guestId = guestRes.body.data.participant.id as string;

      const res = await request(failingEmailApp)
        .post(`/api/v1/trips/${tripId}/participants/${guestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: 'victim@example.com' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_DELIVERY_FAILED');

      // Must leave zero active pending unrevoked invites for that guest
      const activeInvites = await ParticipantInviteModel.countDocuments({
        tripId,
        participantId: guestId,
        usedAt: null,
        revokedAt: null,
      });
      expect(activeInvites).toBe(0);
    });

    it('5. serializes concurrent redemption across two app instances in standalone mode so a token grants at most one promotion', async () => {
      const org = await registerAndVerifyUser(appInstanceA, {
        name: 'Race Lead',
        email: 'racelead@example.com',
      });
      const candidate = await registerAndVerifyUser(appInstanceA, {
        name: 'Race Candidate',
        email: 'racecand@example.com',
      });

      const tripRes = await request(appInstanceA)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Race Trip', mode: 'FRIENDS' });
      const tripId = tripRes.body.data.trip.id as string;

      const guestId = (
        await request(appInstanceA)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'CoOrg Candidate' })
      ).body.data.participant.id as string;

      const inviteRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${guestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: candidate.email });
      const rawToken = inviteRes.body.data.rawToken as string;

      // Two concurrent redemptions across separate instances on same bearer token
      const [claimA, claimB] = await Promise.all([
        request(appInstanceA)
          .post('/api/v1/trips/invites/claim')
          .set('Authorization', `Bearer ${candidate.accessToken}`)
          .send({ token: rawToken }),
        request(appInstanceB)
          .post('/api/v1/trips/invites/claim')
          .set('Authorization', `Bearer ${candidate.accessToken}`)
          .send({ token: rawToken }),
      ]);

      expect([claimA.status, claimB.status].sort((a, b) => a - b)).toEqual([200, 409]);
      expect(await ParticipantModel.countDocuments({ tripId, userId: candidate.userId })).toBe(1);
    });
  });

  describe('Real MongoDB Replica Set ACID concurrent redemption & rollback', () => {
    let cleanupRepl: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      const started = await startReplicaSet();
      cleanupRepl = started.cleanup;
      await Promise.all([
        UserModel.createIndexes(),
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
      ]);
    }, 60000);

    beforeEach(async () => {
      clearTestEmailOutbox();
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
      }
      await Promise.all([
        UserModel.createIndexes(),
        TripModel.createIndexes(),
        ParticipantModel.createIndexes(),
        ParticipantInviteModel.createIndexes(),
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

    it('6. handles concurrent invite claim vs revoke and rolls back usedAt atomically on persistence failure inside replica-set TX', async () => {
      expect(await supportsTransactions()).toBe(true);

      const org = await registerAndVerifyUser(appInstanceA, {
        name: 'Repl Lead',
        email: 'repl.lead@example.com',
      });
      const candidate = await registerAndVerifyUser(appInstanceA, {
        name: 'Repl Candidate',
        email: 'repl.cand@example.com',
      });

      const tripRes = await request(appInstanceA)
        .post('/api/v1/trips')
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ name: 'Replica Set Phase 3 Trip', mode: 'FRIENDS' });
      const tripId = tripRes.body.data.trip.id as string;

      const guestId = (
        await request(appInstanceA)
          .post(`/api/v1/trips/${tripId}/participants`)
          .set('Authorization', `Bearer ${org.accessToken}`)
          .send({ name: 'Repl Guest' })
      ).body.data.participant.id as string;

      // Test ACID rollback if participant.save({ session }) fails inside transaction
      const abortInviteRes = await request(appInstanceA)
        .post(`/api/v1/trips/${tripId}/participants/${guestId}/invites`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ grantedRole: 'ORGANIZER', intendedEmail: candidate.email });
      const abortRawToken = abortInviteRes.body.data.rawToken as string;
      const abortInviteId = abortInviteRes.body.data.invite.id as string;

      vi.spyOn(ParticipantModel.prototype, 'save').mockRejectedValueOnce(
        new Error('Simulated persistence failure during participant promotion')
      );
      const abortedClaim = await request(appInstanceA)
        .post('/api/v1/trips/invites/claim')
        .set('Authorization', `Bearer ${candidate.accessToken}`)
        .send({ token: abortRawToken });
      expect(abortedClaim.status).toBe(500);
      vi.restoreAllMocks();

      // In ACID transaction mode, usedAt AND participant linking MUST both roll back cleanly
      const inviteAfterAbort = await ParticipantInviteModel.findById(abortInviteId);
      expect(inviteAfterAbort?.usedAt).toBeNull();
      const guestAfterAbort = await ParticipantModel.findById(guestId);
      expect(guestAfterAbort?.userId).toBeNull();
      expect(guestAfterAbort?.role).toBe('PARTICIPANT');

      // Concurrent claim vs revoke across two app instances on real replica set: mutually exclusive outcomes
      const [raceClaim, raceRevoke] = await Promise.all([
        request(appInstanceA)
          .post('/api/v1/trips/invites/claim')
          .set('Authorization', `Bearer ${candidate.accessToken}`)
          .send({ token: abortRawToken }),
        request(appInstanceB)
          .post(`/api/v1/trips/${tripId}/invites/${abortInviteId}/revoke`)
          .set('Authorization', `Bearer ${org.accessToken}`),
      ]);

      const finalInvite = await ParticipantInviteModel.findById(abortInviteId);
      const finalParticipant = await ParticipantModel.findById(guestId);

      // Invite can never be both used and revoked
      expect(Boolean(finalInvite?.usedAt) && Boolean(finalInvite?.revokedAt)).toBe(false);
      if (raceClaim.status === 200) {
        expect(raceRevoke.status).toBe(409);
        expect(finalInvite?.usedAt).toBeTruthy();
        expect(finalParticipant?.role).toBe('ORGANIZER');
        expect(finalParticipant?.userId?.toString()).toBe(candidate.userId);
      } else {
        expect(raceClaim.status).toBe(409);
        expect(raceRevoke.status).toBe(200);
        expect(finalInvite?.revokedAt).toBeTruthy();
        expect(finalParticipant?.role).toBe('PARTICIPANT');
        expect(finalParticipant?.userId).toBeNull();
      }
    }, 30000);
  });
});
