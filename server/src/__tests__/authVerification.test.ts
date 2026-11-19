import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { buildEnvConfig } from '../config/env.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js';
import { ParticipantModel, TripModel, UserModel } from '../models/index.js';
import {
  clearTestEmailOutbox,
  EmailDeliveryService,
  getTestEmailOutbox,
} from '../services/emailService.js';
import { sendSuccess } from '../utils/http.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_auth_verification';

function extractTokenFromOutboxUrl(verificationUrl: string): string {
  const url = new URL(verificationUrl);
  const token = url.searchParams.get('token');
  if (!token) {
    throw new Error('Verification token missing in outbox URL');
  }
  return token;
}

describe('Phase 2 Commit 2: Email verification lifecycle, live DB checks & multi-instance rate limiting', () => {
  const app = createApp();

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
    await Promise.all([UserModel.createIndexes()]);
  }, 30000);

  beforeEach(async () => {
    clearTestEmailOutbox();
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await UserModel.createIndexes();
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

  it('registers unverified user, delivers hashed-token link without exposing raw tokens, verifies atomically once, and never modifies Participants', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Create an unrelated guest participant with the same email (must NOT be touched by verify-email)
    const guestId = new mongoose.Types.ObjectId();
    const trip = await TripModel.create({
      name: 'Separation Check Trip',
      mode: 'FRIENDS',
      createdBy: new mongoose.Types.ObjectId(),
      inviteCode: 'SEP00001',
      shareToken: 'share-sep-00001',
    });
    const untouchedGuest = await ParticipantModel.create({
      _id: guestId,
      tripId: trip._id,
      userId: null,
      name: 'Verified Sep Guest',
      email: 'alice.verify@example.com',
      role: 'ORGANIZER',
    });

    // Simulate clean user registration with email matching untouchedGuest (without testing register auto-link)
    await ParticipantModel.updateOne({ _id: untouchedGuest._id }, { $set: { email: 'separate@example.com' } });

    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Alice Verify',
      email: 'alice.verify@example.com',
      password: 'Password123',
    });

    expect(regRes.status).toBe(201);
    expect(regRes.body.data.accessToken).toBeDefined();
    expect(regRes.body.data.refreshToken).toBeDefined();
    expect(regRes.body.data.emailVerificationSent).toBe(true);
    expect(regRes.body.data.user.emailVerified).toBe(false);
    expect(regRes.body.data.user.emailVerifiedAt).toBeNull();
    expect(regRes.body.data.verificationToken).toBeUndefined();
    expect(regRes.body.data.user.emailVerificationTokenHash).toBeUndefined();

    const outbox = getTestEmailOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe('alice.verify@example.com');
    const rawToken = extractTokenFromOutboxUrl(outbox[0].verificationUrl);

    // Ensure raw token is never exposed in response JSON or console logs
    expect(JSON.stringify(regRes.body)).not.toContain(rawToken);
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain(rawToken);
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain(rawToken);

    const dbUser = await UserModel.findById(regRes.body.data.user.id).select(
      '+emailVerificationTokenHash +emailVerificationExpiresAt'
    );
    expect(dbUser?.emailVerified).toBe(false);
    expect(dbUser?.emailVerificationTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(dbUser?.emailVerificationTokenHash).not.toBe(rawToken);
    expect(dbUser?.emailVerificationExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    // Now place matching email on guest to verify /verify-email alone NEVER touches Participants
    await ParticipantModel.updateOne(
      { _id: untouchedGuest._id },
      { $set: { email: 'alice.verify@example.com', userId: null } }
    );

    // Concurrent single-use check: two simultaneous calls -> strictly one succeeds
    const [v1, v2] = await Promise.all([
      request(app).post('/api/v1/auth/verify-email').send({ token: rawToken }),
      request(app).post('/api/v1/auth/verify-email').send({ token: rawToken }),
    ]);

    const statuses = [v1.status, v2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 400]);

    const winner = v1.status === 200 ? v1 : v2;
    const loser = v1.status === 200 ? v2 : v1;
    expect(winner.body.data.verified).toBe(true);
    expect(winner.body.data.userId).toBe(regRes.body.data.user.id);
    expect(winner.body.data.emailVerified).toBe(true);
    expect(winner.body.data.accessToken).toBeUndefined();
    expect(loser.body.error.code).toBe('INVALID_OR_EXPIRED_VERIFICATION_TOKEN');

    // Replay after redemption fails
    const replay = await request(app).post('/api/v1/auth/verify-email').send({ token: rawToken });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_OR_EXPIRED_VERIFICATION_TOKEN');

    const verifiedDbUser = await UserModel.findById(regRes.body.data.user.id).select(
      '+emailVerificationTokenHash +emailVerificationExpiresAt'
    );
    expect(verifiedDbUser?.emailVerified).toBe(true);
    expect(verifiedDbUser?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(verifiedDbUser?.emailVerificationTokenHash).toBeNull();
    expect(verifiedDbUser?.emailVerificationExpiresAt).toBeNull();

    // Critical: verify-email NEVER linked or modified the guest Participant
    const guestAfterVerify = await ParticipantModel.findById(untouchedGuest._id);
    expect(guestAfterVerify?.userId).toBeNull();

    // Resend on already-verified account does not send an email
    clearTestEmailOutbox();
    const resendAfterVerify = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${regRes.body.data.accessToken}`);
    expect(resendAfterVerify.status).toBe(200);
    expect(resendAfterVerify.body.data).toEqual({
      sent: false,
      alreadyVerified: true,
      emailVerified: true,
    });
    expect(getTestEmailOutbox()).toHaveLength(0);
  });

  it('completes registration with 201 and emailVerificationSent: false on email delivery failure, preserving unverified status, tokens, contributor invite claiming, and resend recovery', async () => {
    const failingService = new EmailDeliveryService(
      buildEnvConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'DISABLED' })
    );
    const appWithFailingMail = createApp({ emailDeliveryService: failingService });

    const regFailRes = await request(appWithFailingMail).post('/api/v1/auth/register').send({
      name: 'Recoverable User',
      email: 'recover@example.com',
      password: 'Password123',
    });

    expect(regFailRes.status).toBe(201);
    expect(regFailRes.body.success).toBe(true);
    expect(regFailRes.body.data.emailVerificationSent).toBe(false);
    expect(regFailRes.body.data.accessToken).toEqual(expect.any(String));
    expect(regFailRes.body.data.refreshToken).toEqual(expect.any(String));
    expect(regFailRes.body.data.user.emailVerified).toBe(false);
    expect(regFailRes.body.data.user.emailVerifiedAt).toBeNull();
    expect(regFailRes.body.data.verificationToken).toBeUndefined();
    expect(regFailRes.body.data.rawToken).toBeUndefined();
    expect(regFailRes.body.data.user.emailVerificationTokenHash).toBeUndefined();

    // Account stays unverified with hashed, expiring verification token intact and no resend cooldown penalty
    const persisted = await UserModel.findOne({ email: 'recover@example.com' }).select(
      '+emailVerificationTokenHash +emailVerificationExpiresAt +emailVerificationLastSentAt'
    );
    expect(persisted).not.toBeNull();
    expect(persisted?.emailVerified).toBe(false);
    expect(persisted?.emailVerificationTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.emailVerificationExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(persisted?.emailVerificationLastSentAt).toBeNull();
    const originalHash = persisted!.emailVerificationTokenHash!;
    expect(JSON.stringify(regFailRes.body)).not.toContain(originalHash);

    // Returned accessToken from registration is immediately usable for authenticated sessions
    const initialAccessToken = regFailRes.body.data.accessToken as string;
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${initialAccessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.emailVerified).toBe(false);

    // Unverified user can claim an email-less CONTRIBUTOR invitation, while privileged/email-bound invitations require verified email
    const organizerRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Trip Organizer',
      email: 'organizer.invite@example.com',
      password: 'Password123',
    });
    const organizerToken = organizerRes.body.data.accessToken as string;
    clearTestEmailOutbox();

    const tripCreateRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Closed Group MVP Trip', mode: 'FRIENDS' });
    expect(tripCreateRes.status).toBe(201);
    const tripId = tripCreateRes.body.data.trip.id as string;

    const contribPartRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Recoverable Contributor', role: 'PARTICIPANT' });
    expect(contribPartRes.status).toBe(201);
    const contribParticipantId = contribPartRes.body.data.participant.id as string;

    const coOrgPartRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Privileged Co-Organizer', role: 'PARTICIPANT' });
    expect(coOrgPartRes.status).toBe(201);
    const coOrgParticipantId = coOrgPartRes.body.data.participant.id as string;

    const emailBoundPartRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Email Bound Contributor',
        email: 'recover@example.com',
        role: 'PARTICIPANT',
      });
    expect(emailBoundPartRes.status).toBe(201);
    const emailBoundParticipantId = emailBoundPartRes.body.data.participant.id as string;

    const contribInviteRes = await request(appWithFailingMail)
      .post(`/api/v1/trips/${tripId}/participants/${contribParticipantId}/invites`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ grantedRole: 'CONTRIBUTOR' });
    expect(contribInviteRes.status).toBe(201);
    const contribInviteToken = contribInviteRes.body.data.rawToken as string;

    const coOrgInviteRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants/${coOrgParticipantId}/invites`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ grantedRole: 'ORGANIZER', intendedEmail: 'recover@example.com' });
    expect(coOrgInviteRes.status).toBe(201);
    const coOrgInviteToken = coOrgInviteRes.body.data.rawToken as string;

    const emailBoundInviteRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants/${emailBoundParticipantId}/invites`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ grantedRole: 'CONTRIBUTOR', intendedEmail: 'recover@example.com' });
    expect(emailBoundInviteRes.status).toBe(201);
    const emailBoundInviteToken = emailBoundInviteRes.body.data.rawToken as string;
    clearTestEmailOutbox();

    // Privileged ORGANIZER invite is blocked for unverified user (403 EMAIL_NOT_VERIFIED)
    const claimCoOrg = await request(app)
      .post('/api/v1/trips/invites/claim')
      .set('Authorization', `Bearer ${initialAccessToken}`)
      .send({ token: coOrgInviteToken });
    expect(claimCoOrg.status).toBe(403);
    expect(claimCoOrg.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    // Email-bound invite is blocked for unverified user (403 EMAIL_NOT_VERIFIED)
    const claimEmailBound = await request(app)
      .post('/api/v1/trips/invites/claim')
      .set('Authorization', `Bearer ${initialAccessToken}`)
      .send({ token: emailBoundInviteToken });
    expect(claimEmailBound.status).toBe(403);
    expect(claimEmailBound.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    // Email-less CONTRIBUTOR invite succeeds for unverified user (200)
    const claimContrib = await request(app)
      .post('/api/v1/trips/invites/claim')
      .set('Authorization', `Bearer ${initialAccessToken}`)
      .send({ token: contribInviteToken });
    expect(claimContrib.status).toBe(200);
    expect(claimContrib.body.data.role).toBe('CONTRIBUTOR');
    const claimedParticipant = await ParticipantModel.findById(contribParticipantId);
    expect(claimedParticipant?.userId?.toString()).toBe(persisted!._id.toString());
    expect(claimedParticipant?.role).toBe('CONTRIBUTOR');

    // Database creation failures still fail appropriately and never return 201
    const createSpy = vi
      .spyOn(UserModel, 'create')
      .mockRejectedValueOnce(new Error('Simulated MongoDB write failure'));
    const dbFailRes = await request(appWithFailingMail).post('/api/v1/auth/register').send({
      name: 'DB Error User',
      email: 'dberror@example.com',
      password: 'Password123',
    });
    expect(dbFailRes.status).toBe(500);
    expect(dbFailRes.body.success).toBe(false);
    createSpy.mockRestore();

    // User can also log in with password while unverified to recover
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'recover@example.com',
      password: 'Password123',
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.user.emailVerified).toBe(false);
    const accessToken = loginRes.body.data.accessToken as string;

    // Resend requires authentication (unauthenticated -> 401)
    const unauthResend = await request(app).post('/api/v1/auth/resend-verification');
    expect(unauthResend.status).toBe(401);

    // Failing resend restores previous hash cleanly
    const failResend = await request(appWithFailingMail)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(failResend.status).toBe(503);
    expect(failResend.body.error.code).toBe('EMAIL_DELIVERY_FAILED');

    const afterFailResend = await UserModel.findById(persisted!._id).select(
      '+emailVerificationTokenHash'
    );
    expect(afterFailResend?.emailVerified).toBe(false);
    expect(afterFailResend?.emailVerificationTokenHash).toBe(originalHash);

    // Succeeding resend mints a new token and permanently invalidates the previous one
    const resendOk = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(resendOk.status).toBe(200);
    expect(resendOk.body.data).toEqual({
      sent: true,
      alreadyVerified: false,
      emailVerified: false,
    });

    const outbox = getTestEmailOutbox();
    expect(outbox).toHaveLength(1);
    const newToken = extractTokenFromOutboxUrl(outbox[0].verificationUrl);
    expect(JSON.stringify(resendOk.body)).not.toContain(newToken);

    const verifyNew = await request(app).post('/api/v1/auth/verify-email').send({
      token: newToken,
    });
    expect(verifyNew.status).toBe(200);
    expect(verifyNew.body.data.emailVerified).toBe(true);
  });

  it('invalidates previous token on resend, rejects expired tokens identically to invalid tokens, and keeps email immutable on /me', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Token Rotator',
      email: 'rotate@example.com',
      password: 'Password123',
    });
    const accessToken = reg.body.data.accessToken as string;
    const firstToken = extractTokenFromOutboxUrl(getTestEmailOutbox()[0].verificationUrl);

    // Immediate resend right after registration is gated by the 60s cooldown
    const tooEarlyResend = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(tooEarlyResend.status).toBe(429);
    expect(tooEarlyResend.body.error.code).toBe('VERIFICATION_RESEND_COOLDOWN');
    expect(Number(tooEarlyResend.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // Advance past 60s cooldown -> resend rotates and invalidates firstToken
    await UserModel.updateOne(
      { _id: reg.body.data.user.id },
      { $set: { emailVerificationLastSentAt: new Date(Date.now() - 61_000) } }
    );
    const resend = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(resend.status).toBe(200);
    const secondToken = extractTokenFromOutboxUrl(getTestEmailOutbox()[1].verificationUrl);
    expect(secondToken).not.toBe(firstToken);

    const tryFirst = await request(app).post('/api/v1/auth/verify-email').send({ token: firstToken });
    expect(tryFirst.status).toBe(400);
    expect(tryFirst.body.error.code).toBe('INVALID_OR_EXPIRED_VERIFICATION_TOKEN');

    // Expire secondToken in DB -> uniform 400 error
    await UserModel.updateOne(
      { _id: reg.body.data.user.id },
      { $set: { emailVerificationExpiresAt: new Date(Date.now() - 1000) } }
    );
    const tryExpired = await request(app).post('/api/v1/auth/verify-email').send({
      token: secondToken,
    });
    expect(tryExpired.status).toBe(400);
    expect(tryExpired.body.error.code).toBe('INVALID_OR_EXPIRED_VERIFICATION_TOKEN');

    // PATCH /auth/me rejects attempts to alter email
    const patchEmail = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Renamed', email: 'hijack@example.com' });
    expect(patchEmail.status).toBe(400);
    expect(patchEmail.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requireVerifiedEmail checks the live database instead of trusting JWT claims', async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/api/v1/test-verified', requireAuth, requireVerifiedEmail, (req, res) => {
      sendSuccess(res, { verifiedUser: req.verifiedUser });
    });
    testApp.use(app);
    testApp.use(errorHandler);

    const reg = await request(testApp).post('/api/v1/auth/register').send({
      name: 'Live DB Gate',
      email: 'livedb@example.com',
      password: 'Password123',
    });
    const staleJwtIssueTime = reg.body.data.accessToken as string;

    const blockedBefore = await request(testApp)
      .get('/api/v1/test-verified')
      .set('Authorization', `Bearer ${staleJwtIssueTime}`);
    expect(blockedBefore.status).toBe(403);
    expect(blockedBefore.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    // Redeem verification token — SAME access token issued before verification now succeeds cleanly
    const rawToken = extractTokenFromOutboxUrl(getTestEmailOutbox()[0].verificationUrl);
    await request(testApp).post('/api/v1/auth/verify-email').send({ token: rawToken });

    const allowedAfter = await request(testApp)
      .get('/api/v1/test-verified')
      .set('Authorization', `Bearer ${staleJwtIssueTime}`);
    expect(allowedAfter.status).toBe(200);
    expect(allowedAfter.body.data.verifiedUser.emailVerified).toBe(true);

    // If DB flag is revoked, the exact same valid JWT immediately loses access
    await UserModel.updateOne({ _id: reg.body.data.user.id }, { $set: { emailVerified: false } });
    const blockedAfterRevoke = await request(testApp)
      .get('/api/v1/test-verified')
      .set('Authorization', `Bearer ${staleJwtIssueTime}`);
    expect(blockedAfterRevoke.status).toBe(403);
    expect(blockedAfterRevoke.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('enforces shared MongoDB rate limiting across multiple server instances and returns 409 EMAIL_EXISTS on duplicate register', async () => {
    // Two independent Express app instances simulating horizontal multi-instance deployment
    const appInstanceA = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      authRateLimitMaxOverrides: {
        login: 2,
        register: 2,
        verifyEmail: 2,
        resendVerification: 2,
      },
    });
    const appInstanceB = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      authRateLimitMaxOverrides: {
        login: 2,
        register: 2,
        verifyEmail: 2,
        resendVerification: 2,
      },
    });

    // Register user via instance A (hit 1/2), duplicate register via instance B -> 409 EMAIL_EXISTS (hit 2/2)
    const r1 = await request(appInstanceA).post('/api/v1/auth/register').send({
      name: 'Cluster User',
      email: 'cluster@example.com',
      password: 'Password123',
    });
    expect(r1.status).toBe(201);

    const r2 = await request(appInstanceB).post('/api/v1/auth/register').send({
      name: 'Cluster User',
      email: 'cluster@example.com',
      password: 'Password123',
    });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('EMAIL_EXISTS');

    // 3rd register across instances hits shared Mongo rate-limit store -> 429 RATE_LIMITED
    const r3 = await request(appInstanceA).post('/api/v1/auth/register').send({
      name: 'Another User',
      email: 'other.cluster@example.com',
      password: 'Password123',
    });
    expect(r3.status).toBe(429);
    expect(r3.body.error.code).toBe('RATE_LIMITED');

    // Login rate-limit shared across A and B (hit 1 on A, hit 2 on B, 3rd blocked on A)
    const l1 = await request(appInstanceA).post('/api/v1/auth/login').send({
      email: 'cluster@example.com',
      password: 'WrongPassword',
    });
    expect(l1.status).toBe(401);

    const l2 = await request(appInstanceB).post('/api/v1/auth/login').send({
      email: 'cluster@example.com',
      password: 'WrongPassword',
    });
    expect(l2.status).toBe(401);

    const l3 = await request(appInstanceA).post('/api/v1/auth/login').send({
      email: 'cluster@example.com',
      password: 'Password123',
    });
    expect(l3.status).toBe(429);
    expect(l3.body.error.code).toBe('RATE_LIMITED');
  });

  it('M-03: enforces atomic 60s resend cooldown at exact boundary, serializes concurrent resends, preserves rollback vs newer resend, and excludes 503 failures from quota', async () => {
    let clockMs = 1_700_000_000_000;
    const nowFn = () => clockMs;

    const appA = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      now: nowFn,
    });
    const appB = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      now: nowFn,
    });

    const reg = await request(appA).post('/api/v1/auth/register').send({
      name: 'Cooldown Tester',
      email: 'cooldown@example.com',
      password: 'Password123',
    });
    expect(reg.status).toBe(201);
    const accessToken = reg.body.data.accessToken as string;
    const userId = reg.body.data.user.id as string;

    // 1. Immediate repeat request blocked across instances with 429 & Retry-After
    const immediate = await request(appB)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(immediate.status).toBe(429);
    expect(immediate.body.error.code).toBe('VERIFICATION_RESEND_COOLDOWN');
    expect(immediate.headers['retry-after']).toBe('60');

    // 2. Exact boundary checks: 59,999ms -> 429 (Retry-After: 1); 60,000ms -> 200
    clockMs += 59_999;
    const at59999 = await request(appB)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(at59999.status).toBe(429);
    expect(at59999.body.error.code).toBe('VERIFICATION_RESEND_COOLDOWN');
    expect(at59999.headers['retry-after']).toBe('1');
    expect(getTestEmailOutbox()).toHaveLength(1);

    clockMs += 1; // Exactly 60,000ms elapsed
    const at60000 = await request(appB)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(at60000.status).toBe(200);
    expect(at60000.body.data.sent).toBe(true);
    expect(getTestEmailOutbox()).toHaveLength(2);

    // 3. Concurrent bursts after cooldown: strictly 1 winner rotates token, 4 losers get 429 with Retry-After
    clockMs += 60_000;
    const beforeConcurrentOutboxCount = getTestEmailOutbox().length;
    const burst = await Promise.all([
      request(appA).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${accessToken}`),
      request(appB).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${accessToken}`),
      request(appA).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${accessToken}`),
      request(appB).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${accessToken}`),
      request(appA).post('/api/v1/auth/resend-verification').set('Authorization', `Bearer ${accessToken}`),
    ]);
    const burstStatuses = burst.map((r) => r.status).sort((a, b) => a - b);
    expect(burstStatuses).toEqual([200, 429, 429, 429, 429]);
    for (const r of burst.filter((x) => x.status === 429)) {
      expect(r.body.error.code).toBe('VERIFICATION_RESEND_COOLDOWN');
      expect(Number(r.headers['retry-after'])).toBe(60);
    }
    expect(getTestEmailOutbox()).toHaveLength(beforeConcurrentOutboxCount + 1);
    const dbAfterBurst = await UserModel.findById(userId).select('+emailVerificationResendCount');
    expect(dbAfterBurst?.emailVerificationResendCount).toBe(2);

    // 4. Slow delivery failure rollback racing with a newer successful resend NEVER overwrites newer token or cooldown
    let rejectSlowDelivery!: (err: Error) => void;
    let slowStartedResolve!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      slowStartedResolve = resolve;
    });
    const slowFailingDelivery = {
      sendVerificationEmail: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectSlowDelivery = reject;
            slowStartedResolve();
          })
      ),
    } as unknown as EmailDeliveryService;

    const appSlowFail = createApp({
      emailDeliveryService: slowFailingDelivery,
      now: nowFn,
    });

    clockMs += 60_000;
    const slowPromise = request(appSlowFail)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`)
      .then((res) => res);
    await slowStarted;

    // While slow request A is still in flight, advance past 60s and let newer resend B succeed
    clockMs += 60_000;
    const newerSuccess = await request(appA)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(newerSuccess.status).toBe(200);
    const newerToken = extractTokenFromOutboxUrl(
      getTestEmailOutbox()[getTestEmailOutbox().length - 1].verificationUrl
    );
    const userAfterNewer = await UserModel.findById(userId).select(
      '+emailVerificationTokenHash +emailVerificationLastSentAt'
    );
    const newerHash = userAfterNewer!.emailVerificationTokenHash!;
    const newerSentAtMs = userAfterNewer!.emailVerificationLastSentAt!.getTime();

    // Now older slow delivery rejects -> rollback must match 0 docs and keep newerHash + newerSentAtMs intact
    rejectSlowDelivery(
      new (await import('../utils/http.js')).AppError(
        'SMTP timeout',
        503,
        'EMAIL_DELIVERY_FAILED'
      )
    );
    const slowRes = await slowPromise;
    expect(slowRes.status).toBe(503);

    const userAfterLateRollback = await UserModel.findById(userId).select(
      '+emailVerificationTokenHash +emailVerificationLastSentAt'
    );
    expect(userAfterLateRollback?.emailVerificationTokenHash).toBe(newerHash);
    expect(userAfterLateRollback?.emailVerificationLastSentAt?.getTime()).toBe(newerSentAtMs);

    // 5. Provider 503 failures do not penalize 60s cooldown or 5-per-15m quota
    const failingMailer = new EmailDeliveryService(
      buildEnvConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'DISABLED' })
    );
    const appFailQuota = createApp({
      enableRateLimitInTest: true,
      rateLimitStoreOverride: 'mongo',
      emailDeliveryService: failingMailer,
      now: nowFn,
    });

    const regQuota = await request(appA).post('/api/v1/auth/register').send({
      name: 'Quota User',
      email: 'quota@example.com',
      password: 'Password123',
    });
    const quotaToken = regQuota.body.data.accessToken as string;

    // Advance 61s after registration, then fail 6 consecutive times with 503
    clockMs += 61_000;
    for (let i = 0; i < 6; i++) {
      const failAttempt = await request(appFailQuota)
        .post('/api/v1/auth/resend-verification')
        .set('Authorization', `Bearer ${quotaToken}`);
      expect(failAttempt.status).toBe(503);
      expect(failAttempt.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
    }

    // Immediate next 5 successful deliveries (spaced 60s apart inside same 15-min window) ALL succeed!
    for (let i = 0; i < 5; i++) {
      const okAttempt = await request(appA)
        .post('/api/v1/auth/resend-verification')
        .set('Authorization', `Bearer ${quotaToken}`);
      expect(okAttempt.status).toBe(200);
      clockMs += 60_000;
    }

    // 6th successful send in the same 15-minute window is blocked with 429 RATE_LIMITED + Retry-After
    const sixthSend = await request(appA)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', `Bearer ${quotaToken}`);
    expect(sixthSend.status).toBe(429);
    expect(sixthSend.body.error.code).toBe('RATE_LIMITED');
    expect(Number(sixthSend.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // Newer token from race scenario remains valid and verifies account cleanly
    const verifyNewer = await request(appA)
      .post('/api/v1/auth/verify-email')
      .send({ token: newerToken });
    expect(verifyNewer.status).toBe(200);
  });
});
