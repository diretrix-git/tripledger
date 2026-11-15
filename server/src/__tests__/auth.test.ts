import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { ParticipantModel, TripModel } from '../models/index.js';
import { requireAuth, requireTripRole } from '../middleware/auth.js';
import { sendSuccess } from '../utils/http.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_auth';

describe('Phase 2: Authentication, Token Rotation, Guest Linking & RBAC', () => {
  const app = express();
  const baseApp = createApp();
  app.use(express.json());
  // Add a test-only RBAC route before mounting baseApp & errorHandler
  app.post(
    '/api/v1/test-rbac/:tripId/organizer-only',
    requireAuth,
    requireTripRole(['ORGANIZER']),
    (_req, res) => {
      sendSuccess(res, { allowed: true });
    }
  );
  app.use(baseApp);
  app.use(errorHandler);

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await disconnectDatabase();
  });

  it('registers a user, hashes password, issues tokens, and retrieves profile', async () => {
    const regRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Krish Adhikari',
      email: 'krish@example.com',
      password: 'Password123',
      phone: '9841000000',
    });

    expect(regRes.status).toBe(201);
    expect(regRes.body.success).toBe(true);
    expect(regRes.body.data.accessToken).toBeDefined();
    expect(regRes.body.data.user.email).toBe('krish@example.com');
    expect(regRes.body.data.user.passwordHash).toBeUndefined();

    const token = regRes.body.data.accessToken as string;
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.name).toBe('Krish Adhikari');
  });

  it('logs in, rotates refresh tokens, and rejects invalid credentials', async () => {
    await request(app).post('/api/v1/auth/register').send({
      name: 'Sita Poudel',
      email: 'sita@example.com',
      password: 'Password123',
    });

    const badLogin = await request(app).post('/api/v1/auth/login').send({
      email: 'sita@example.com',
      password: 'WrongPassword99',
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await request(app).post('/api/v1/auth/login').send({
      email: 'sita@example.com',
      password: 'Password123',
    });
    expect(goodLogin.status).toBe(200);
    const refreshToken = goodLogin.body.data.refreshToken as string;

    const refreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.data.accessToken).toBeDefined();

    // Old refresh token should now be revoked due to rotation
    const reuseOldRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(reuseOldRefresh.status).toBe(401);
  });

  it('auto-links existing guest participant records when a user registers with matching email and enforces RBAC', async () => {
    // 1. Register Organizer
    const orgRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Organizer User',
      email: 'org@example.com',
      password: 'Password123',
    });
    const orgId = orgRes.body.data.user.id as string;
    const orgToken = orgRes.body.data.accessToken as string;

    // 2. Create a Trip and a Guest Participant with email "guest@example.com" and role PARTICIPANT
    const trip = await TripModel.create({
      name: 'Pokhara Trip',
      mode: 'FRIENDS',
      createdBy: orgId,
      inviteCode: 'PKR12345',
      shareToken: 'share-pkr-12345',
    });

    await ParticipantModel.create({
      tripId: trip._id,
      userId: orgId,
      name: 'Organizer User',
      email: 'org@example.com',
      role: 'ORGANIZER',
    });

    const guestParticipant = await ParticipantModel.create({
      tripId: trip._id,
      userId: null,
      name: 'Ramesh Guest',
      email: 'guest@example.com',
      role: 'PARTICIPANT',
    });

    expect(guestParticipant.userId).toBeNull();

    // 3. Register Ramesh with email "guest@example.com"
    const guestReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Ramesh Guest',
      email: 'guest@example.com',
      password: 'Password123',
    });
    const guestToken = guestReg.body.data.accessToken as string;
    const guestUserId = guestReg.body.data.user.id as string;

    // Verify Guest Participant record is now linked to Ramesh's new userId
    const updatedGuest = await ParticipantModel.findById(guestParticipant._id);
    expect(updatedGuest?.userId?.toString()).toBe(guestUserId);

    // 4. Verify RBAC: Organizer is allowed on organizer-only endpoint, Participant is rejected with 403
    const orgCheck = await request(app)
      .post(`/api/v1/test-rbac/${trip._id.toString()}/organizer-only`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(orgCheck.status).toBe(200);

    const participantCheck = await request(app)
      .post(`/api/v1/test-rbac/${trip._id.toString()}/organizer-only`)
      .set('Authorization', `Bearer ${guestToken}`);
    expect(participantCheck.status).toBe(403);
    expect(participantCheck.body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});
