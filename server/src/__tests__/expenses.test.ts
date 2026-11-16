import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { verifyLedgerInvariants } from '@tripledger/shared';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_expenses';

describe('Phase 4 & 5: Expense Engine, Multiple Payers, Family Mode, Packages & Offline Idempotency', () => {
  const app = createApp();
  let orgToken = '';
  let contributorToken = '';

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }

    const orgReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Aarav Sharma',
      email: 'aarav@example.com',
      password: 'Password123',
    });
    orgToken = orgReg.body.data.accessToken as string;

    const contribReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Dipesh Thapa',
      email: 'dipesh@example.com',
      password: 'Password123',
    });
    contributorToken = contribReg.body.data.accessToken as string;
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await disconnectDatabase();
  });

  it('handles Family Mode fixed packages, multiple payers, per-family splitting, contributor submission & approval, and idempotency', async () => {
    // 1. Create Family Mode trip with Sharma Family
    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        name: 'Nagarkot Family Retreat',
        mode: 'FAMILY',
        organizerFamilyName: 'Sharma Family',
      });
    expect(tripRes.status).toBe(201);
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;
    const sharmaFamilyId = tripRes.body.data.families[0].id as string;
    const aaravParticipantId = tripRes.body.data.myParticipant.id as string;

    // 2. Add second member to Sharma Family
    const binaRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        name: 'Bina Sharma',
        familyId: sharmaFamilyId,
        role: 'PARTICIPANT',
        memberType: 'ADULT',
      });
    const binaParticipantId = binaRes.body.data.participant.id as string;

    // 3. Create Thapa Family, have Dipesh join via open invite code, and organizer assigns family & CONTRIBUTOR role
    const thapaFamRes = await request(app)
      .post(`/api/v1/trips/${tripId}/families`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        name: 'Thapa Family',
      });
    const thapaFamilyId = thapaFamRes.body.data.family.id as string;

    const dipeshJoinRes = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${contributorToken}`);
    expect(dipeshJoinRes.status).toBe(200);
    const dipeshParticipantId = dipeshJoinRes.body.data.participantId as string;

    await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${dipeshParticipantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        familyId: thapaFamilyId,
        role: 'CONTRIBUTOR',
        memberType: 'ADULT',
      });

    const eshaRes = await request(app)
      .post(`/api/v1/trips/${tripId}/participants`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        name: 'Esha Thapa',
        familyId: thapaFamilyId,
        role: 'PARTICIPANT',
        memberType: 'ADULT',
      });
    const eshaParticipantId = eshaRes.body.data.participant.id as string;

    // 4. Create Fixed Package Expense: Resort Package NPR 3,000 per person * 4 = NPR 12,000 (1,200,000 paisa)
    // Paid by Aarav (NPR 8,000) and Dipesh (NPR 4,000) — Multiple payers!
    const pkgRes = await request(app)
      .post(`/api/v1/trips/${tripId}/expenses`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        title: 'Resort Stay Package',
        category: 'PACKAGE',
        amountPaisa: 1200000,
        isPackage: true,
        packageRatePerPersonPaisa: 300000,
        splitMethod: 'PACKAGE',
        paymentMethod: 'BANK_TRANSFER',
        payments: [
          { participantId: aaravParticipantId, amountPaisa: 800000 },
          { participantId: dipeshParticipantId, amountPaisa: 400000 },
        ],
        includedParticipantIds: [
          aaravParticipantId,
          binaParticipantId,
          dipeshParticipantId,
          eshaParticipantId,
        ],
        clientMutationId: 'offline-uuid-pkg-001',
      });
    expect(pkgRes.status).toBe(201);
    expect(pkgRes.body.data.expense.isPackage).toBe(true);
    expect(pkgRes.body.data.deduplicated).toBe(false);

    // 5. Verify Offline Queue Idempotency: re-sending the exact same clientMutationId returns 200 without duplicating
    const retryPkgRes = await request(app)
      .post(`/api/v1/trips/${tripId}/expenses`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        title: 'Resort Stay Package',
        category: 'PACKAGE',
        amountPaisa: 1200000,
        isPackage: true,
        packageRatePerPersonPaisa: 300000,
        splitMethod: 'PACKAGE',
        paymentMethod: 'BANK_TRANSFER',
        payments: [
          { participantId: aaravParticipantId, amountPaisa: 800000 },
          { participantId: dipeshParticipantId, amountPaisa: 400000 },
        ],
        clientMutationId: 'offline-uuid-pkg-001',
      });
    expect(retryPkgRes.status).toBe(200);
    expect(retryPkgRes.body.data.deduplicated).toBe(true);
    expect(retryPkgRes.body.data.ledger.totalApprovedExpensePaisa).toBe(1200000);

    // 6. Contributor (Dipesh) submits an expense in Family Mode -> starts as PENDING_APPROVAL
    // Highway Snacks NPR 2,000 (200,000 paisa) split PER_FAMILY
    const contribExpRes = await request(app)
      .post(`/api/v1/trips/${tripId}/expenses`)
      .set('Authorization', `Bearer ${contributorToken}`)
      .send({
        title: 'Highway Snacks & Drinks',
        category: 'SNACKS_WATER',
        amountPaisa: 200000,
        splitMethod: 'PER_FAMILY',
        paymentMethod: 'ESEWA',
        payments: [{ participantId: dipeshParticipantId, amountPaisa: 200000 }],
      });
    expect(contribExpRes.status).toBe(201);
    const submittedExpenseId = contribExpRes.body.data.expense.id as string;
    expect(contribExpRes.body.data.expense.approvalStatus).toBe('PENDING_APPROVAL');
    // Confirmed ledger should still only count the approved NPR 12,000 package
    expect(contribExpRes.body.data.ledger.totalApprovedExpensePaisa).toBe(1200000);
    expect(contribExpRes.body.data.ledger.totalPendingExpensePaisa).toBe(200000);

    // 7. Organizer approves Dipesh's submitted expense
    const approveRes = await request(app)
      .post(`/api/v1/trips/${tripId}/expenses/${submittedExpenseId}/approve`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ approvalStatus: 'APPROVED' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.expense.approvalStatus).toBe('APPROVED');
    expect(approveRes.body.data.ledger.totalApprovedExpensePaisa).toBe(1400000);
    expect(approveRes.body.data.ledger.totalPackageExpensePaisa).toBe(1200000);
    expect(approveRes.body.data.ledger.totalAdditionalExpensePaisa).toBe(200000);

    // 8. Contributor attempts to edit finalized (approved) expense -> rejected with 403
    const forbiddenEdit = await request(app)
      .patch(`/api/v1/trips/${tripId}/expenses/${submittedExpenseId}`)
      .set('Authorization', `Bearer ${contributorToken}`)
      .send({ title: 'Unauthorized Edit' });
    expect(forbiddenEdit.status).toBe(403);

    // 9. Verify all financial invariants hold on the persisted trip data
    const tripState = await request(app)
      .get(`/api/v1/trips/${tripId}`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(tripState.status).toBe(200);

    const invariantResult = verifyLedgerInvariants(
      tripState.body.data.participants,
      tripState.body.data.families,
      tripState.body.data.expenses,
      tripState.body.data.settlements
    );
    expect(invariantResult.valid).toBe(true);
    expect(invariantResult.violations).toHaveLength(0);
  });
});
