import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { buildEnvConfig } from '../config/env.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js';
import { FamilyModel, ParticipantModel, SettlementModel, TripModel, UserModel } from '../models/index.js';
import {
  clearTestEmailOutbox,
  EmailDeliveryService,
  getTestEmailOutbox,
} from '../services/emailService.js';
import { sendSuccess } from '../utils/http.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_phase2_security';

function extractVerificationToken(verificationUrl: string): string {
  const parsed = new URL(verificationUrl);
  const token = parsed.searchParams.get('token');
  if (!token) throw new Error('Missing verification token in captured URL');
  return token;
}

describe('Phase 2 Full Security Regression Suite (SEC-01 Auth & Membership Hardening)', () => {
  const app = createApp();

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
    await Promise.all([
      UserModel.createIndexes(),
      ParticipantModel.createIndexes(),
      TripModel.createIndexes(),
    ]);
  }, 30000);

  beforeEach(async () => {
    clearTestEmailOutbox();
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await Promise.all([
      UserModel.createIndexes(),
      ParticipantModel.createIndexes(),
      TripModel.createIndexes(),
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

  it('prevents unverified and verified email-matching users from claiming pre-existing ORGANIZER or FAMILY_REP guests across every endpoint', async () => {
    // 1. Legitimate organizer creates trip and unlinked guest slots with emails (ORGANIZER + FAMILY_REP + CONTRIBUTOR)
    const creatorReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Legit Creator',
      email: 'creator@example.com',
      password: 'Password123',
    });
    const creatorToken = creatorReg.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ name: 'Family Vacation', mode: 'FAMILY', organizerFamilyName: 'Creator Family' });
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;

    const fam2Res = await request(app)
      .post(`/api/v1/trips/${tripId}/families`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ name: 'Target Family' });
    const fam2Id = fam2Res.body.data.family.id as string;

    // Pre-register a verified user BEFORE addParticipant to prove even verified users are NEVER auto-linked by addParticipant
    clearTestEmailOutbox();
    const preVerifiedReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Already Verified User',
      email: 'already.verified@example.com',
      password: 'Password123',
    });
    const preVerifiedToken = extractVerificationToken(getTestEmailOutbox()[0].verificationUrl);
    await request(app).post('/api/v1/auth/verify-email').send({ token: preVerifiedToken });
    const preVerifiedAccess = preVerifiedReg.body.data.accessToken as string;

    // Guest creation rejects privileged roles via HTTP; also verify historical DB guests cannot auto-link
    const blockedPrivGuest = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        name: 'Blocked Guest Org',
        email: 'already.verified@example.com',
        role: 'ORGANIZER',
      });
    expect(blockedPrivGuest.status).toBe(400);

    const privOrgGuest = await ParticipantModel.create({
      tripId,
      userId: null,
      name: 'Pre-Existing Verified Target',
      email: 'already.verified@example.com',
      role: 'ORGANIZER',
    });
    const privOrgGuestId = privOrgGuest._id.toString();

    const repGuest = await ParticipantModel.create({
      tripId,
      userId: null,
      name: 'Waiting Family Rep',
      email: 'rep.victim@example.com',
      familyId: fam2Id,
      role: 'FAMILY_REP',
    });
    const repGuestId = repGuest._id.toString();

    // 2. Attacker registers with matching email `rep.victim@example.com`, logs in, verifies email, reads dashboard & trips
    clearTestEmailOutbox();
    const attackerReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Attacker',
      email: 'rep.victim@example.com',
      password: 'Password123',
    });
    const attackerAccess = attackerReg.body.data.accessToken as string;

    await request(app).post('/api/v1/auth/login').send({
      email: 'rep.victim@example.com',
      password: 'Password123',
    });
    const attackerVerifyTok = extractVerificationToken(getTestEmailOutbox()[0].verificationUrl);
    await request(app).post('/api/v1/auth/verify-email').send({ token: attackerVerifyTok });

    // Capture exact participant timestamps before read operations
    const beforePriv = await ParticipantModel.findById(privOrgGuestId).lean();
    const beforeRep = await ParticipantModel.findById(repGuestId).lean();

    // Dashboard summary, listTrips, and trip read routes must NOT mutate or link participants
    const dashRes = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${attackerAccess}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.data.trips).toHaveLength(0);

    const listRes = await request(app)
      .get('/api/v1/trips')
      .set('Authorization', `Bearer ${attackerAccess}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.trips).toHaveLength(0);

    const getTripBlocked = await request(app)
      .get(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${attackerAccess}`);
    expect(getTripBlocked.status).toBe(403);
    expect(getTripBlocked.body.error.code).toBe('FORBIDDEN_TRIP_ACCESS');

    const getTripPreVerified = await request(app)
      .get(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${preVerifiedAccess}`);
    expect(getTripPreVerified.status).toBe(403);
    expect(getTripPreVerified.body.error.code).toBe('FORBIDDEN_TRIP_ACCESS');

    const afterPriv = await ParticipantModel.findById(privOrgGuestId).lean();
    const afterRep = await ParticipantModel.findById(repGuestId).lean();
    expect(afterPriv?.userId).toBeNull();
    expect(afterRep?.userId).toBeNull();
    expect(afterPriv?.updatedAt.getTime()).toBe(beforePriv?.updatedAt.getTime());
    expect(afterRep?.updatedAt.getTime()).toBe(beforeRep?.updatedAt.getTime());

    // 3. Passing guestParticipantId to join/:inviteCode fails strictly (400), and plain join yields PARTICIPANT (not ORGANIZER/FAMILY_REP/CONTRIBUTOR)
    const takeoverAttempt = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${attackerAccess}`)
      .send({ guestParticipantId: repGuestId });
    expect(takeoverAttempt.status).toBe(400);
    expect(takeoverAttempt.body.error.code).toBe('VALIDATION_ERROR');

    const legitimateOpenJoin = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${attackerAccess}`);
    expect(legitimateOpenJoin.status).toBe(200);
    expect(legitimateOpenJoin.body.data.role).toBe('PARTICIPANT');
    expect((await ParticipantModel.findById(repGuestId))?.userId).toBeNull();

    // Open invite-code PARTICIPANT cannot submit expenses (requires CONTRIBUTOR/FAMILY_REP/ORGANIZER)
    const submitExpenseAttempt = await request(app)
      .post(`/api/v1/trips/${tripId}/expenses`)
      .set('Authorization', `Bearer ${attackerAccess}`)
      .send({
        title: 'Unauthorized Expense',
        category: 'FOOD_DRINKS',
        amountPaisa: 10000,
        splitMethod: 'EQUAL',
        payments: [
          {
            participantId: legitimateOpenJoin.body.data.participantId as string,
            amountPaisa: 10000,
          },
        ],
      });
    expect(submitExpenseAttempt.status).toBe(403);
    expect(submitExpenseAttempt.body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('prevents deactivated participants from regaining access or roles via invite code or auto-linking, and guards updateParticipant', async () => {
    const orgReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Trip Organizer',
      email: 'org2@example.com',
      password: 'Password123',
    });
    const orgToken = orgReg.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Restricted Trip', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;
    const orgParticipantId = tripRes.body.data.myParticipant.id as string;

    const foreignTripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Other Trip', mode: 'FAMILY', organizerFamilyName: 'Foreign Fam' });
    const foreignFamilyId = foreignTripRes.body.data.families[0].id as string;

    // Co-member joins and gets promoted to ORGANIZER temporarily, then deactivated
    const coReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Former CoOrg',
      email: 'former.coorg@example.com',
      password: 'Password123',
    });
    const coToken = coReg.body.data.accessToken as string;

    const joinRes = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${coToken}`);
    const coParticipantId = joinRes.body.data.participantId as string;

    // Verify Former CoOrg email and promote to ORGANIZER via verified ParticipantInvite, then deactivate
    const verifyCoTok = extractVerificationToken(
      getTestEmailOutbox()[getTestEmailOutbox().length - 1].verificationUrl
    );
    await request(app).post('/api/v1/auth/verify-email').send({ token: verifyCoTok });

    const coInviteRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants/${coParticipantId}/invites`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ grantedRole: 'ORGANIZER', intendedEmail: 'former.coorg@example.com' });
    expect(coInviteRes.status).toBe(201);

    const coClaimRes = await request(app)
      .post('/api/v1/trips/invites/claim')
      .set('Authorization', `Bearer ${coToken}`)
      .send({ token: coInviteRes.body.data.rawToken as string });
    expect(coClaimRes.status).toBe(200);
    expect(coClaimRes.body.data.role).toBe('ORGANIZER');

    // Linked participant's email cannot be reassigned to another email
    const changeLinkedEmail = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${coParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ email: 'different@example.com' });
    expect(changeLinkedEmail.status).toBe(409);
    expect(changeLinkedEmail.body.error.code).toBe('PARTICIPANT_EMAIL_IMMUTABLE_WHILE_LINKED');

    // Cross-trip familyId is rejected
    const badFamilyPatch = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${coParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ familyId: foreignFamilyId });
    expect(badFamilyPatch.status).toBe(404);
    expect(badFamilyPatch.body.error.code).toBe('FAMILY_NOT_FOUND');

    // Organizer deactivates Former CoOrg
    const deactRes = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${coParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ isActive: false });
    expect(deactRes.status).toBe(200);
    expect(deactRes.body.data.participant.isActive).toBe(false);

    // Remaining sole active ORGANIZER cannot demote or deactivate themselves
    const selfDemote = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${orgParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ role: 'PARTICIPANT' });
    expect(selfDemote.status).toBe(400);
    expect(selfDemote.body.error.code).toBe('SOLE_ORGANIZER');

    const selfDeactivate = await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${orgParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ isActive: false });
    expect(selfDeactivate.status).toBe(400);
    expect(selfDeactivate.body.error.code).toBe('SOLE_ORGANIZER');

    // Deactivated member CANNOT reactivate themselves via /trips/join/:inviteCode
    const rejoinRes = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${coToken}`);
    expect(rejoinRes.status).toBe(403);
    expect(rejoinRes.body.error.code).toBe('PARTICIPANT_DEACTIVATED');
    expect((await ParticipantModel.findById(coParticipantId))?.isActive).toBe(false);

    // Deactivated member remains blocked from dashboard, trips list, and trip endpoints
    const coDash = await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${coToken}`);
    expect(coDash.body.data.trips).toHaveLength(0);

    const coTripGet = await request(app)
      .get(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${coToken}`);
    expect(coTripGet.status).toBe(403);

    // Unlinked deactivated guest with matching email stays blocked and never auto-links
    const inactiveGuest = await ParticipantModel.create({
      tripId,
      userId: null,
      name: 'Deactivated Guest Slot',
      email: 'deact.guest@example.com',
      role: 'CONTRIBUTOR',
      isActive: false,
    });
    const guestUserReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Deact Guest User',
      email: 'deact.guest@example.com',
      password: 'Password123',
    });
    await request(app)
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${guestUserReg.body.data.accessToken}`);
    expect((await ParticipantModel.findById(inactiveGuest._id))?.userId).toBeNull();
  });

  it('enforces inviteEnabled / inviteExpiresAt controls and handles concurrent join without E11000 errors', async () => {
    const orgReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Control Organizer',
      email: 'ctrl.org@example.com',
      password: 'Password123',
    });
    const orgToken = orgReg.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Controlled Join Trip', mode: 'FRIENDS' });
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;

    const friendReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Friend User',
      email: 'friend.ctrl@example.com',
      password: 'Password123',
    });
    const friendToken = friendReg.body.data.accessToken as string;

    // Disable open invite joining via PATCH /trips/:tripId
    const disableRes = await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ inviteEnabled: false });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.data.trip.inviteEnabled).toBe(false);

    const joinWhileDisabled = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${friendToken}`);
    expect(joinWhileDisabled.status).toBe(403);
    expect(joinWhileDisabled.body.error.code).toBe('INVITE_DISABLED');

    // Re-enable with expired inviteExpiresAt
    const expireRes = await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ inviteEnabled: true, inviteExpiresAt: '2020-01-01T00:00:00.000Z' });
    expect(expireRes.status).toBe(200);

    const joinWhileExpired = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${friendToken}`);
    expect(joinWhileExpired.status).toBe(403);
    expect(joinWhileExpired.body.error.code).toBe('INVITE_EXPIRED');

    // Clear expiration and send concurrent joins -> both return 200 cleanly without E11000 failure
    await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ inviteExpiresAt: null });

    const [j1, j2] = await Promise.all([
      request(app)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${friendToken}`),
      request(app)
        .post(`/api/v1/trips/join/${inviteCode}`)
        .set('Authorization', `Bearer ${friendToken}`),
    ]);
    expect(j1.status).toBe(200);
    expect(j2.status).toBe(200);
    expect(j1.body.data.participantId).toBe(j2.body.data.participantId);
  });

  it('preserves existing linked accounts without retroactively verifying legacy users, while allowing legacy verification recovery', async () => {
    const bcrypt = await import('bcryptjs');
    const knownHash = await bcrypt.default.hash('Password123', 10);

    // Seed a pre-Phase-2 legacy linked account (emailVerified: false)
    const legacyUser = await UserModel.create({
      name: 'Legacy Linked User',
      email: 'legacy.linked@example.com',
      passwordHash: knownHash,
      emailVerified: false,
      emailVerifiedAt: null,
    });
    const trip = await TripModel.create({
      name: 'Legacy Trip',
      mode: 'FRIENDS',
      createdBy: legacyUser._id,
      inviteCode: 'LEGY1234',
      shareToken: 'share-legy-1234',
    });
    const linkedPart = await ParticipantModel.create({
      tripId: trip._id,
      userId: legacyUser._id,
      name: 'Legacy Linked User',
      email: 'legacy.linked@example.com',
      role: 'ORGANIZER',
    });

    // Legacy user can sign in and access their existing linked trip cleanly, while remaining emailVerified: false
    const validLogin = await request(app).post('/api/v1/auth/login').send({
      email: 'legacy.linked@example.com',
      password: 'Password123',
    });
    expect(validLogin.status).toBe(200);
    expect(validLogin.body.data.user.emailVerified).toBe(false);
    const legacyToken = validLogin.body.data.accessToken as string;

    const tripAccess = await request(app)
      .get(`/api/v1/trips/${trip._id.toString()}`)
      .set('Authorization', `Bearer ${legacyToken}`);
    expect(tripAccess.status).toBe(200);
    expect(tripAccess.body.data.myParticipant.id).toBe(linkedPart._id.toString());

    // Verify legacy user was NOT auto-verified across login, refresh, or trip access
    const legacyRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: validLogin.body.data.refreshToken });
    expect(legacyRefresh.status).toBe(200);
    expect(legacyRefresh.body.data.user.emailVerified).toBe(false);

    // Legacy user can verify via resend-verification -> verify-email without altering Participant links
    const resend = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${legacyToken}`);
    expect(resend.status).toBe(200);
    expect(resend.body.data.sent).toBe(true);

    const tok = extractVerificationToken(getTestEmailOutbox()[0].verificationUrl);
    const verify = await request(app).post('/api/v1/auth/verify-email').send({ token: tok });
    expect(verify.status).toBe(200);
    expect(verify.body.data.emailVerified).toBe(true);

    const meAfter = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${legacyToken}`);
    expect(meAfter.body.data.user.emailVerified).toBe(true);
    expect((await ParticipantModel.findById(linkedPart._id))?.userId?.toString()).toBe(
      legacyUser._id.toString()
    );
  });

  it('end-to-end 503 EMAIL_DELIVERY_FAILED recovery preserves token state and requireVerifiedEmail blocks unverified sessions', async () => {
    const failingMailer = new EmailDeliveryService(
      buildEnvConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'DISABLED' })
    );
    const outboxApp = createApp();
    const failApp = createApp({ emailDeliveryService: failingMailer });

    const testServer = express();
    testServer.use(express.json());
    testServer.get('/api/v1/verified-only', requireAuth, requireVerifiedEmail, (_req, res) => {
      sendSuccess(res, { ok: true });
    });
    testServer.use(outboxApp);
    testServer.use(errorHandler);

    const failedReg = await request(failApp).post('/api/v1/auth/register').send({
      name: 'Outage Signup',
      email: 'outage@example.com',
      password: 'Password123',
    });
    expect(failedReg.status).toBe(503);
    expect(failedReg.body.error.code).toBe('EMAIL_DELIVERY_FAILED');

    const recoveredLogin = await request(testServer).post('/api/v1/auth/login').send({
      email: 'outage@example.com',
      password: 'Password123',
    });
    expect(recoveredLogin.status).toBe(200);
    expect(recoveredLogin.body.data.user.emailVerified).toBe(false);
    const access = recoveredLogin.body.data.accessToken as string;

    const blockedVerifiedRoute = await request(testServer)
      .get('/api/v1/verified-only')
      .set('Authorization', `Bearer ${access}`);
    expect(blockedVerifiedRoute.status).toBe(403);
    expect(blockedVerifiedRoute.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const resend = await request(testServer)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${access}`);
    expect(resend.status).toBe(200);
    const tok = extractVerificationToken(getTestEmailOutbox()[0].verificationUrl);
    await request(testServer).post('/api/v1/auth/verify-email').send({ token: tok });

    const allowedVerifiedRoute = await request(testServer)
      .get('/api/v1/verified-only')
      .set('Authorization', `Bearer ${access}`);
    expect(allowedVerifiedRoute.status).toBe(200);
  });

  it('M-01: validates family representativeId and settlement family references against active trip-scoped entities', async () => {
    const orgReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Fam Org',
      email: 'fam.org@example.com',
      password: 'Password123',
    });
    const orgToken = orgReg.body.data.accessToken as string;

    const tripARes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Trip A', mode: 'FAMILY', organizerFamilyName: 'Org Fam' });
    const tripAId = tripARes.body.data.trip.id as string;
    const orgParticipantId = tripARes.body.data.myParticipant.id as string;
    const orgFamilyId = tripARes.body.data.families[0].id as string;

    const tripBRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Trip B', mode: 'FAMILY', organizerFamilyName: 'Foreign Fam' });
    const foreignParticipantId = tripBRes.body.data.myParticipant.id as string;
    const foreignFamilyId = tripBRes.body.data.families[0].id as string;

    const activeGuestRes = await request(app)
      .post(`/api/v1/trips/${tripAId}/participants`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Active Rep Candidate', role: 'PARTICIPANT' });
    const activeGuestId = activeGuestRes.body.data.participant.id as string;

    const inactiveGuestRes = await request(app)
      .post(`/api/v1/trips/${tripAId}/participants`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Inactive Candidate', role: 'PARTICIPANT' });
    const inactiveGuestId = inactiveGuestRes.body.data.participant.id as string;
    await request(app)
      .patch(`/api/v1/trips/${tripAId}/participants/${inactiveGuestId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ isActive: false });

    const nonexistentParticipantId = new mongoose.Types.ObjectId().toString();
    const nonexistentFamilyId = new mongoose.Types.ObjectId().toString();

    // 1. createFamily rejections (malformed, nonexistent, cross-trip, inactive)
    const badCreateCases = [
      {
        name: 'Malformed Rep',
        representativeId: 'not-an-objectid',
        expectedStatus: 400,
        expectedCode: 'INVALID_ID',
      },
      {
        name: 'Nonexistent Rep',
        representativeId: nonexistentParticipantId,
        expectedStatus: 404,
        expectedCode: 'PARTICIPANT_NOT_FOUND',
      },
      {
        name: 'Cross-Trip Rep',
        representativeId: foreignParticipantId,
        expectedStatus: 404,
        expectedCode: 'PARTICIPANT_NOT_FOUND',
      },
      {
        name: 'Inactive Rep',
        representativeId: inactiveGuestId,
        expectedStatus: 400,
        expectedCode: 'PARTICIPANT_INACTIVE',
      },
    ];

    for (const tc of badCreateCases) {
      const res = await request(app)
        .post(`/api/v1/trips/${tripAId}/families`)
        .set('Authorization', `Bearer ${orgToken}`)
        .send({ name: tc.name, representativeId: tc.representativeId });
      expect(res.status).toBe(tc.expectedStatus);
      expect(res.body.error.code).toBe(tc.expectedCode);
    }
    expect(await FamilyModel.countDocuments({ tripId: tripAId })).toBe(1);

    // Valid active rep succeeds on createFamily
    const validCreate = await request(app)
      .post(`/api/v1/trips/${tripAId}/families`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Second Family', representativeId: activeGuestId });
    expect(validCreate.status).toBe(201);
    const secondFamilyId = validCreate.body.data.family.id as string;
    expect(validCreate.body.data.family.representativeId).toBe(activeGuestId);
    expect((await ParticipantModel.findById(activeGuestId))?.familyId?.toString()).toBe(
      secondFamilyId
    );

    // 2. updateFamily rejections preserve original representativeId
    for (const tc of badCreateCases) {
      const res = await request(app)
        .patch(`/api/v1/trips/${tripAId}/families/${secondFamilyId}`)
        .set('Authorization', `Bearer ${orgToken}`)
        .send({ representativeId: tc.representativeId });
      expect(res.status).toBe(tc.expectedStatus);
      expect(res.body.error.code).toBe(tc.expectedCode);
      expect((await FamilyModel.findById(secondFamilyId))?.representativeId?.toString()).toBe(
        activeGuestId
      );
    }

    // Valid updateFamily to unassign and reassign succeeds
    const unassignRes = await request(app)
      .patch(`/api/v1/trips/${tripAId}/families/${secondFamilyId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ representativeId: null });
    expect(unassignRes.status).toBe(200);
    expect(unassignRes.body.data.family.representativeId).toBeNull();

    // 3. Settlement fromFamilyId / toFamilyId cross-trip & forged family rejection
    const rep2Reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Second Fam Rep',
      email: 'fam2rep@example.com',
      password: 'Password123',
    });
    const rep2Token = rep2Reg.body.data.accessToken as string;
    const inviteCodeA = tripARes.body.data.trip.inviteCode as string;
    const rep2Join = await request(app)
      .post(`/api/v1/trips/join/${inviteCodeA}`)
      .set('Authorization', `Bearer ${rep2Token}`);
    const rep2ParticipantId = rep2Join.body.data.participantId as string;

    const verifyRep2Tok = extractVerificationToken(
      getTestEmailOutbox()[getTestEmailOutbox().length - 1].verificationUrl
    );
    await request(app).post('/api/v1/auth/verify-email').send({ token: verifyRep2Tok });

    await request(app)
      .patch(`/api/v1/trips/${tripAId}/participants/${rep2ParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ familyId: secondFamilyId });

    const rep2Invite = await request(app)
      .post(`/api/v1/trips/${tripAId}/participants/${rep2ParticipantId}/invites`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ grantedRole: 'FAMILY_REP', intendedEmail: 'fam2rep@example.com' });
    expect(rep2Invite.status).toBe(201);
    const rep2Claim = await request(app)
      .post('/api/v1/trips/invites/claim')
      .set('Authorization', `Bearer ${rep2Token}`)
      .send({ token: rep2Invite.body.data.rawToken as string });
    expect(rep2Claim.status).toBe(200);
    expect(rep2Claim.body.data.role).toBe('FAMILY_REP');

    // Cross-trip, nonexistent, malformed, and mismatched toFamilyId rejected cleanly
    const badSettlements = [
      { toFamilyId: 'bad-fam-id', expectedStatus: 400, expectedCode: 'INVALID_ID' },
      { toFamilyId: nonexistentFamilyId, expectedStatus: 404, expectedCode: 'FAMILY_NOT_FOUND' },
      { toFamilyId: foreignFamilyId, expectedStatus: 404, expectedCode: 'FAMILY_NOT_FOUND' },
      {
        toFamilyId: secondFamilyId, // Receiver belongs to orgFamilyId, not secondFamilyId
        expectedStatus: 400,
        expectedCode: 'SETTLEMENT_FAMILY_MISMATCH',
      },
    ];

    for (const bs of badSettlements) {
      const res = await request(app)
        .post(`/api/v1/trips/${tripAId}/settlements`)
        .set('Authorization', `Bearer ${rep2Token}`)
        .send({
          settlementMode: 'FAMILY',
          fromParticipantId: rep2ParticipantId,
          toParticipantId: orgParticipantId,
          toFamilyId: bs.toFamilyId,
          amountPaisa: 50000,
          paymentMethod: 'CASH',
        });
      expect(res.status).toBe(bs.expectedStatus);
      expect(res.body.error.code).toBe(bs.expectedCode);
    }
    expect(await SettlementModel.countDocuments({ tripId: tripAId })).toBe(0);

    // Even if a pre-existing DB row had a forged/mismatched toFamilyId, FAMILY_REP of that unrelated family cannot confirm it
    const forgedSettlement = await SettlementModel.create({
      tripId: tripAId,
      settlementMode: 'FAMILY',
      fromParticipantId: activeGuestId,
      toParticipantId: orgParticipantId,
      fromFamilyId: orgFamilyId,
      toFamilyId: secondFamilyId, // Receiver orgParticipantId is NOT in secondFamilyId
      amountPaisa: 25000,
      paymentMethod: 'CASH',
      status: 'REPORTED',
      reportedByParticipantId: activeGuestId,
    });

    const forgedConfirmAttempt = await request(app)
      .patch(`/api/v1/trips/${tripAId}/settlements/${forgedSettlement._id.toString()}/status`)
      .set('Authorization', `Bearer ${rep2Token}`)
      .send({ status: 'CONFIRMED' });
    expect(forgedConfirmAttempt.status).toBe(403);
    expect(forgedConfirmAttempt.body.error.code).toBe('FORBIDDEN_SETTLEMENT_CONFIRMATION');

    // Legitimate settlement to secondFamilyId CAN be confirmed by rep2 (FAMILY_REP of secondFamilyId)
    const validSettlementRes = await request(app)
      .post(`/api/v1/trips/${tripAId}/settlements`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        settlementMode: 'FAMILY',
        fromParticipantId: orgParticipantId,
        toParticipantId: activeGuestId,
        toFamilyId: secondFamilyId,
        amountPaisa: 10000,
        paymentMethod: 'CASH',
        status: 'REPORTED',
      });
    expect(validSettlementRes.status).toBe(201);
    const validSettlementId = validSettlementRes.body.data.settlement.id as string;

    const validRepConfirm = await request(app)
      .patch(`/api/v1/trips/${tripAId}/settlements/${validSettlementId}/status`)
      .set('Authorization', `Bearer ${rep2Token}`)
      .send({ status: 'CONFIRMED' });
    expect(validRepConfirm.status).toBe(200);
    expect(validRepConfirm.body.data.settlement.status).toBe('CONFIRMED');
  });

  it('M-02: disables invites on trip closure, blocks joining CLOSED trips, preserves reopening, and enforces strict Mongo join rate limiting', async () => {
    const orgReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Close Organizer',
      email: 'close.org@example.com',
      password: 'Password123',
    });
    const orgToken = orgReg.body.data.accessToken as string;

    const u1Reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Joiner One',
      email: 'join1@example.com',
      password: 'Password123',
    });
    const u1Token = u1Reg.body.data.accessToken as string;

    const u2Reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Joiner Two',
      email: 'join2@example.com',
      password: 'Password123',
    });
    const u2Token = u2Reg.body.data.accessToken as string;

    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ name: 'Closable Trip', mode: 'FRIENDS' });
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;

    // 1. Blank/whitespace and unknown invite codes share identical 404 TRIP_NOT_FOUND response
    const blankJoin = await request(app)
      .post('/api/v1/trips/join/%20%20')
      .set('Authorization', `Bearer ${u1Token}`);
    const unknownJoin = await request(app)
      .post('/api/v1/trips/join/ZZZZ9999')
      .set('Authorization', `Bearer ${u1Token}`);
    expect(blankJoin.status).toBe(404);
    expect(unknownJoin.status).toBe(404);
    expect(blankJoin.body.error).toEqual(unknownJoin.body.error);

    // 2. Closing trip via POST /close disables open invitations and blocks joining
    const closeRes = await request(app)
      .post(`/api/v1/trips/${tripId}/close`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ forceClose: true });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.data.trip.status).toBe('CLOSED');
    expect(closeRes.body.data.trip.inviteEnabled).toBe(false);

    const joinClosedRes = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${u1Token}`);
    expect(joinClosedRes.status).toBe(403);
    expect(joinClosedRes.body.error.code).toBe('TRIP_CLOSED');
    expect(JSON.stringify(joinClosedRes.body)).not.toContain('Closable Trip');

    // Concurrent joins on a CLOSED trip all fail with 403 TRIP_CLOSED without enrolling participants
    const [cj1, cj2] = await Promise.all([
      request(app).post(`/api/v1/trips/join/${inviteCode}`).set('Authorization', `Bearer ${u1Token}`),
      request(app).post(`/api/v1/trips/join/${inviteCode}`).set('Authorization', `Bearer ${u2Token}`),
    ]);
    expect(cj1.status).toBe(403);
    expect(cj2.status).toBe(403);
    expect(await ParticipantModel.countDocuments({ tripId })).toBe(1);

    // Cannot re-enable inviteEnabled while trip stays CLOSED
    const enableWhileClosed = await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ inviteEnabled: true });
    expect(enableWhileClosed.status).toBe(400);
    expect(enableWhileClosed.body.error.code).toBe('INVITE_NOT_ALLOWED_ON_CLOSED_TRIP');

    // 3. Reopening preserves inviteEnabled: false until organizer explicitly enables it
    const reopenRes = await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ status: 'ACTIVE' });
    expect(reopenRes.status).toBe(200);
    expect(reopenRes.body.data.trip.status).toBe('ACTIVE');
    expect(reopenRes.body.data.trip.closedAt).toBeNull();
    expect(reopenRes.body.data.trip.inviteEnabled).toBe(false);

    const joinAfterReopenBeforeEnable = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${u1Token}`);
    expect(joinAfterReopenBeforeEnable.status).toBe(403);
    expect(joinAfterReopenBeforeEnable.body.error.code).toBe('INVITE_DISABLED');

    // Closing via PATCH /trips/:tripId { status: 'CLOSED' } also disables open invites
    await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ inviteEnabled: true });
    const patchCloseRes = await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ status: 'CLOSED' });
    expect(patchCloseRes.status).toBe(200);
    expect(patchCloseRes.body.data.trip.inviteEnabled).toBe(false);

    // Explicitly reopen with inviteEnabled: true
    const reopenWithInvites = await request(app)
      .patch(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ status: 'ACTIVE', inviteEnabled: true });
    expect(reopenWithInvites.status).toBe(200);
    expect(reopenWithInvites.body.data.trip.inviteEnabled).toBe(true);

    const joinAfterEnable = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${u1Token}`);
    expect(joinAfterEnable.status).toBe(200);
    expect(joinAfterEnable.body.data.role).toBe('PARTICIPANT');

    // 4. Dedicated strict Mongo-backed rate limiter across instances on POST /trips/join/:inviteCode
    const appA = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      apiRateLimitMaxOverride: 100,
      authRateLimitMaxOverrides: { tripJoin: 2 },
    });
    const appB = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      apiRateLimitMaxOverride: 100,
      authRateLimitMaxOverrides: { tripJoin: 2 },
    });

    const rl1 = await request(appA)
      .post('/api/v1/trips/join/MISS0001')
      .set('Authorization', `Bearer ${u2Token}`);
    expect(rl1.status).toBe(404);

    const rl2 = await request(appB)
      .post('/api/v1/trips/join/MISS0002')
      .set('Authorization', `Bearer ${u2Token}`);
    expect(rl2.status).toBe(404);

    // 3rd attempt (even against valid invite code) is blocked uniformly with 429 RATE_LIMITED
    const rl3 = await request(appA)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${u2Token}`);
    expect(rl3.status).toBe(429);
    expect(rl3.body.error.code).toBe('RATE_LIMITED');
  });
});
