import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES } from '@tripledger/shared';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_trips';

describe('Phase 3: Trip Management, Participants, Families & Forgotten Expense Protection', () => {
  const app = createApp();
  let organizerToken = '';

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    const reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Aarav Organizer',
      email: 'aarav@example.com',
      password: 'Password123',
    });
    organizerToken = reg.body.data.accessToken as string;
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await disconnectDatabase();
  });

  it('creates a Friends Mode trip, adds guest participants, and allows invite-code joining', async () => {
    const createRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Mustang Road Trip',
        description: '5-day bike & jeep trip to Upper Mustang',
        mode: 'FRIENDS',
        budgetPaisa: 10000000, // NPR 100,000
      });

    expect(createRes.status).toBe(201);
    const trip = createRes.body.data.trip;
    expect(trip.name).toBe('Mustang Road Trip');
    expect(trip.mode).toBe('FRIENDS');
    expect(trip.checklist).toHaveLength(FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES.length);

    // Add a guest participant without account (always restricted to PARTICIPANT role)
    const p1Res = await request(app)
      .post(`/api/v1/trips/${trip.id}/participants`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Bikash Gurung',
        role: 'PARTICIPANT',
      });
    expect(p1Res.status).toBe(201);
    expect(p1Res.body.data.participant.userId).toBeNull();
    expect(p1Res.body.data.participant.role).toBe('PARTICIPANT');

    // Guest creation rejects privileged and contributor roles cleanly
    for (const disallowedRole of ['ORGANIZER', 'FAMILY_REP', 'CONTRIBUTOR']) {
      const rejectedGuest = await request(app)
        .post(`/api/v1/trips/${trip.id}/participants`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ name: 'Blocked Guest', role: disallowedRole });
      expect(rejectedGuest.status).toBe(400);
    }

    // Register another user and join via invite code
    const user2Reg = await request(app).post('/api/v1/auth/register').send({
      name: 'Nisha KC',
      email: 'nisha@example.com',
      password: 'Password123',
    });
    const user2Token = user2Reg.body.data.accessToken as string;

    const joinRes = await request(app)
      .post(`/api/v1/trips/join/${trip.inviteCode}`)
      .set('Authorization', `Bearer ${user2Token}`);
    expect(joinRes.status).toBe(200);
    expect(joinRes.body.data.alreadyJoined).toBe(false);
    expect(joinRes.body.data.role).toBe('PARTICIPANT');

    // Fetch trip details as joined participant
    const detailRes = await request(app)
      .get(`/api/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${user2Token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.myParticipant.role).toBe('PARTICIPANT');
    expect(detailRes.body.data.participants).toHaveLength(3);
  });

  it('creates a Family Mode trip, manages family groups & representatives, and enforces Forgotten Expense Checklist before closing', async () => {
    const createRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Chitwan Family Safari',
        mode: 'FAMILY',
        organizerFamilyName: 'Sharma Family',
      });

    expect(createRes.status).toBe(201);
    const trip = createRes.body.data.trip;
    expect(createRes.body.data.families).toHaveLength(1);
    expect(createRes.body.data.families[0].name).toBe('Sharma Family');

    // Create second family group
    const fam2Res = await request(app)
      .post(`/api/v1/trips/${trip.id}/families`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Thapa Family',
        defaultWeight: 1,
      });
    expect(fam2Res.status).toBe(201);
    const thapaFamilyId = fam2Res.body.data.family.id as string;

    // Add adult and child guest participants to Thapa Family
    const repRes = await request(app)
      .post(`/api/v1/trips/${trip.id}/participants`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Dipesh Thapa',
        role: 'PARTICIPANT',
        memberType: 'ADULT',
        familyId: thapaFamilyId,
      });
    expect(repRes.status).toBe(201);

    const childRes = await request(app)
      .post(`/api/v1/trips/${trip.id}/participants`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Riya Thapa',
        role: 'PARTICIPANT',
        memberType: 'CHILD',
        familyId: thapaFamilyId,
        defaultWeight: 0.5,
      });
    expect(childRes.status).toBe(201);

    // Attempt to close trip before completing Forgotten Expense Protection checklist -> should fail with 400
    const prematureClose = await request(app)
      .post(`/api/v1/trips/${trip.id}/close`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({});
    expect(prematureClose.status).toBe(400);
    expect(prematureClose.body.error.code).toBe('CHECKLIST_INCOMPLETE');

    // Mark all checklist categories as checked or notApplicable
    for (const category of FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES) {
      const checkRes = await request(app)
        .patch(`/api/v1/trips/${trip.id}/checklist`)
        .set('Authorization', `Bearer ${organizerToken}`)
        .send({ category, checked: true });
      expect(checkRes.status).toBe(200);
    }

    // Now closing the trip succeeds
    const closeRes = await request(app)
      .post(`/api/v1/trips/${trip.id}/close`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({});
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.data.trip.status).toBe('CLOSED');
  });
});
