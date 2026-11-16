import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { verifyLedgerInvariants } from '@tripledger/shared';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_settlements';

describe('Phase 6 & 7: Settlements Workflow, Partial Settlements, Reports & Sanitized Public Sharing', () => {
  const app = createApp();
  let orgToken = '';
  let debtorToken = '';

  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }

    const orgReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Sagar Organizer',
      email: 'sagar@example.com',
      password: 'Password123',
      phone: '9851099999',
    });
    orgToken = orgReg.body.data.accessToken as string;

    const debReg = await request(app).post('/api/v1/auth/register').send({
      name: 'Prashant Friend',
      email: 'prashant@example.com',
      password: 'Password123',
      phone: '9841088888',
    });
    debtorToken = debReg.body.data.accessToken as string;
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await disconnectDatabase();
  });

  it('tracks reported vs confirmed partial settlements, preserves original expenses, and serves sanitized public reports', async () => {
    // 1. Create Friends Mode trip
    const tripRes = await request(app)
      .post('/api/v1/trips')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        name: 'Annapurna Base Camp Trek',
        mode: 'FRIENDS',
        budgetPaisa: 5000000,
      });
    const tripId = tripRes.body.data.trip.id as string;
    const inviteCode = tripRes.body.data.trip.inviteCode as string;
    const shareToken = tripRes.body.data.trip.shareToken as string;
    const sagarId = tripRes.body.data.myParticipant.id as string;

    // 2. Prashant joins via invite code and organizer grants CONTRIBUTOR role
    const joinRes = await request(app)
      .post(`/api/v1/trips/join/${inviteCode}`)
      .set('Authorization', `Bearer ${debtorToken}`);
    expect(joinRes.status).toBe(200);
    const prashantId = joinRes.body.data.participantId as string;

    await request(app)
      .patch(`/api/v1/trips/${tripId}/participants/${prashantId}`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        phone: '9841088888',
        role: 'CONTRIBUTOR',
      });

    // 3. Record Expense: Tea House Accommodation NPR 6,000 (600,000 paisa) paid by Sagar, split EQUAL (300,000 each)
    const expRes = await request(app)
      .post(`/api/v1/trips/${tripId}/expenses`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        title: 'Chhomrong Tea House',
        category: 'ACCOMMODATION',
        amountPaisa: 600000,
        splitMethod: 'EQUAL',
        paymentMethod: 'CASH',
        payments: [{ participantId: sagarId, amountPaisa: 600000 }],
      });
    expect(expRes.status).toBe(201);

    // Sagar is owed NPR 3,000 (+300,000 paisa), Prashant owes NPR 3,000 (-300,000 paisa)
    expect(expRes.body.data.individualSettlementSuggestions).toHaveLength(1);
    expect(expRes.body.data.individualSettlementSuggestions[0].amountPaisa).toBe(300000);

    // 4. Prashant (Debtor) reports a partial settlement of NPR 1,200 (120,000 paisa) via Fonepay
    // Even if Prashant tries to pass status: 'CONFIRMED', backend enforces 'REPORTED' since he is the sender
    const reportSettleRes = await request(app)
      .post(`/api/v1/trips/${tripId}/settlements`)
      .set('Authorization', `Bearer ${debtorToken}`)
      .send({
        settlementMode: 'INDIVIDUAL',
        fromParticipantId: prashantId,
        toParticipantId: sagarId,
        amountPaisa: 120000,
        paymentMethod: 'FONEPAY',
        status: 'CONFIRMED',
        referenceNote: 'Fonepay ref 9911',
      });
    expect(reportSettleRes.status).toBe(201);
    const settlementId = reportSettleRes.body.data.settlement.id as string;
    expect(reportSettleRes.body.data.settlement.status).toBe('REPORTED');

    // Because it is only REPORTED (not CONFIRMED), confirmed outstanding balances remain +/- 300,000 paisa
    expect(reportSettleRes.body.data.individualSettlementSuggestions[0].amountPaisa).toBe(
      300000
    );

    // 5. Prashant (Debtor) tries to confirm his own reported settlement -> rejected with 403
    const selfConfirmRes = await request(app)
      .patch(`/api/v1/trips/${tripId}/settlements/${settlementId}/status`)
      .set('Authorization', `Bearer ${debtorToken}`)
      .send({ status: 'CONFIRMED' });
    expect(selfConfirmRes.status).toBe(403);

    // 6. Sagar (Receiver / Organizer) confirms the partial settlement
    const confirmRes = await request(app)
      .patch(`/api/v1/trips/${tripId}/settlements/${settlementId}/status`)
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ status: 'CONFIRMED' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.settlement.status).toBe('CONFIRMED');

    // Remaining debt is now NPR 1,800 (180,000 paisa), while original expense remains NPR 6,000 (600,000 paisa)
    expect(confirmRes.body.data.ledger.totalApprovedExpensePaisa).toBe(600000);
    expect(confirmRes.body.data.ledger.totalConfirmedSettlementPaisa).toBe(120000);
    expect(confirmRes.body.data.individualSettlementSuggestions[0].amountPaisa).toBe(
      180000
    );

    // 7. Verify Report Summary endpoint
    const reportRes = await request(app)
      .get(`/api/v1/trips/${tripId}/reports/summary`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(reportRes.status).toBe(200);
    expect(reportRes.body.data.categoryBreakdown).toHaveLength(1);
    expect(reportRes.body.data.categoryBreakdown[0].category).toBe('ACCOMMODATION');
    expect(reportRes.body.data.categoryBreakdown[0].percentage).toBe(100);

    // 8. Verify Public Shared Report endpoint strips private user info (email, phone, userId, inviteCode)
    const publicRes = await request(app).get(`/api/v1/shared/${shareToken}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data.trip.name).toBe('Annapurna Base Camp Trek');
    expect(publicRes.body.data.trip.inviteCode).toBeUndefined();

    for (const p of publicRes.body.data.participants) {
      expect(p.email).toBeUndefined();
      expect(p.phone).toBeUndefined();
      expect(p.userId).toBeUndefined();
    }

    // 9. Verify ledger invariants
    const check = verifyLedgerInvariants(
      reportRes.body.data.ledger.individualBalances.map((b: { participantId: string; participantName: string; familyId: string | null; role: 'ORGANIZER' | 'CONTRIBUTOR'; memberType: 'ADULT' }) => ({
        id: b.participantId,
        tripId,
        familyId: b.familyId,
        name: b.participantName,
        role: b.role,
        memberType: b.memberType,
        defaultWeight: 1,
        isActive: true,
      })),
      [],
      reportRes.body.data.expenses,
      reportRes.body.data.settlements
    );
    expect(check.valid).toBe(true);
  });
});
