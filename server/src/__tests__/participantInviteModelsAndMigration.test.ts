import crypto from 'crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import {
  auditParticipantLinkingRisks,
  backfillInviteSecurityDefaults,
  migrateParticipantUserIndex,
  runParticipantMigrationCli,
} from '../migrations/migrateParticipantUserIndex.js';
import {
  ActivityLogModel,
  PARTICIPANT_INVITE_TOKEN_INDEX_NAME,
  PARTICIPANT_TRIP_USER_INDEX_NAME,
  ParticipantInviteModel,
  ParticipantModel,
  TripModel,
  USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME,
  UserModel,
} from '../models/index.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/tripledger_test_phase1_models';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('Phase 1: Security Contracts, Models & Participant User Index Migration', () => {
  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI);
  }, 30000);

  beforeEach(async () => {
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

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await disconnectDatabase();
  });

  it('adds email verification fields and partial unique tokenHash index to UserModel', async () => {
    const u1 = await UserModel.create({
      name: 'Alice Verified',
      email: 'alice@example.com',
      passwordHash: 'hashed-pw-1',
    });

    expect(u1.emailVerified).toBe(false);
    expect(u1.emailVerifiedAt).toBeNull();

    // Token hash/expiry are select: false by default
    const reloaded = await UserModel.findById(u1._id).lean();
    expect(reloaded?.emailVerificationTokenHash).toBeUndefined();
    expect(reloaded?.emailVerificationExpiresAt).toBeUndefined();

    // Multiple unverified users with null verification token hashes must coexist
    const u2 = await UserModel.create({
      name: 'Bob Unverified',
      email: 'bob@example.com',
      passwordHash: 'hashed-pw-2',
    });
    expect(u2._id).toBeDefined();

    // Reject raw/non-SHA256 verification token hashes
    await expect(
      UserModel.create({
        name: 'Bad Hash',
        email: 'badhash@example.com',
        passwordHash: 'hashed-pw-3',
        emailVerificationTokenHash: 'raw-unhashed-token',
      })
    ).rejects.toThrow(/SHA-256/i);

    // Partial unique index enforces uniqueness for populated hashes while ignoring nulls
    const tokenHash = sha256('secret-email-verify-token-1');
    await UserModel.updateOne(
      { _id: u1._id },
      { $set: { emailVerificationTokenHash: tokenHash, emailVerificationExpiresAt: new Date() } }
    );
    await expect(
      UserModel.updateOne(
        { _id: u2._id },
        { $set: { emailVerificationTokenHash: tokenHash } }
      )
    ).rejects.toThrow(/E11000/);

    const indexes = await UserModel.collection.indexes();
    expect(indexes.some((i) => i.name === USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME)).toBe(true);
  });

  it('defaults TripModel open invite settings safely and forces defaultInviteRole to PARTICIPANT', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const trip = await TripModel.create({
      name: 'Annapurna Circuit',
      mode: 'FRIENDS',
      createdBy: ownerId,
      inviteCode: 'ACAP2026',
      shareToken: 'share-acap-2026',
    });

    expect(trip.inviteEnabled).toBe(true);
    expect(trip.inviteExpiresAt).toBeNull();
    expect(trip.inviteCodeRotatedAt).toBeNull();
    expect(trip.defaultInviteRole).toBe('PARTICIPANT');

    await expect(
      TripModel.create({
        name: 'Escalated Default Role Trip',
        mode: 'FRIENDS',
        createdBy: ownerId,
        inviteCode: 'BADROLE1',
        shareToken: 'share-bad-role-1',
        defaultInviteRole: 'CONTRIBUTOR' as unknown as 'PARTICIPANT',
      })
    ).rejects.toThrow();
  });

  it('enforces unique partial index on Participant (tripId, userId) across active and deactivated slots while allowing multiple guest slots', async () => {
    const tripA = new mongoose.Types.ObjectId();
    const tripB = new mongoose.Types.ObjectId();
    const user1 = new mongoose.Types.ObjectId();

    // Multiple unlinked guests (`userId: null` / omitted) in same trip are allowed
    const g1 = await ParticipantModel.create({
      tripId: tripA,
      name: 'Guest One',
      userId: null,
      role: 'PARTICIPANT',
    });
    const g2 = await ParticipantModel.create({
      tripId: tripA,
      name: 'Guest Two',
      role: 'CONTRIBUTOR',
    });
    expect(g1.userId).toBeNull();
    expect(g2.userId).toBeNull();

    // First linked user in tripA succeeds; same user in tripB also succeeds
    await ParticipantModel.create({
      tripId: tripA,
      userId: user1,
      name: 'User One Inactive',
      role: 'PARTICIPANT',
      isActive: false,
    });
    await ParticipantModel.create({
      tripId: tripB,
      userId: user1,
      name: 'User One Trip B',
      role: 'ORGANIZER',
    });

    // Duplicate (tripId, userId) in tripA is rejected even if existing record is deactivated
    await expect(
      ParticipantModel.create({
        tripId: tripA,
        userId: user1,
        name: 'User One Duplicate',
        role: 'ORGANIZER',
        isActive: true,
      })
    ).rejects.toThrow(/E11000/);

    const indexes = await ParticipantModel.collection.indexes();
    const partialIdx = indexes.find((i) => i.name === PARTICIPANT_TRIP_USER_INDEX_NAME);
    expect(partialIdx?.unique).toBe(true);
    expect(partialIdx?.partialFilterExpression).toEqual({ userId: { $type: 'objectId' } });
  });

  it('enforces ParticipantInvite security invariants including privileged role verified-email policy and immutability', async () => {
    const tripId = new mongoose.Types.ObjectId();
    const participantId = new mongoose.Types.ObjectId();
    const adminUserId = new mongoose.Types.ObjectId();
    const adminParticipantId = new mongoose.Types.ObjectId();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 1. Privileged roles (ORGANIZER, FAMILY_REP) require intendedEmail & requireVerifiedEmail: true
    for (const privRole of ['ORGANIZER', 'FAMILY_REP'] as const) {
      await expect(
        ParticipantInviteModel.create({
          tripId,
          participantId,
          invitedByUserId: adminUserId,
          invitedByParticipantId: adminParticipantId,
          tokenHash: sha256(`missing-email-${privRole}`),
          grantedRole: privRole,
          expiresAt: future,
        })
      ).rejects.toThrow(/intendedEmail/i);

      await expect(
        ParticipantInviteModel.create({
          tripId,
          participantId,
          invitedByUserId: adminUserId,
          invitedByParticipantId: adminParticipantId,
          tokenHash: sha256(`disabled-verify-${privRole}`),
          grantedRole: privRole,
          intendedEmail: 'priv@example.com',
          requireVerifiedEmail: false,
          expiresAt: future,
        })
      ).rejects.toThrow(/verification/i);
    }

    // Valid ORGANIZER invite auto-normalizes email & enforces requireVerifiedEmail: true
    const orgInvite = await ParticipantInviteModel.create({
      tripId,
      participantId,
      invitedByUserId: adminUserId,
      invitedByParticipantId: adminParticipantId,
      tokenHash: sha256('valid-org-token'),
      grantedRole: 'ORGANIZER',
      intendedEmail: '  Co.Organizer@Example.COM ',
      expiresAt: future,
    });
    expect(orgInvite.intendedEmail).toBe('co.organizer@example.com');
    expect(orgInvite.requireVerifiedEmail).toBe(true);

    // 2. Non-privileged role with intendedEmail also rejects requireVerifiedEmail: false
    await expect(
      ParticipantInviteModel.create({
        tripId,
        participantId,
        invitedByUserId: adminUserId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: sha256('email-bound-no-verify'),
        grantedRole: 'CONTRIBUTOR',
        intendedEmail: 'guest@example.com',
        requireVerifiedEmail: false,
        expiresAt: future,
      })
    ).rejects.toThrow(/verified email ownership/i);

    // 3. Rejects unhashed tokenHash and already-expired timestamps on creation
    await expect(
      ParticipantInviteModel.create({
        tripId,
        participantId,
        invitedByUserId: adminUserId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: 'plaintext-token',
        grantedRole: 'PARTICIPANT',
        expiresAt: future,
      })
    ).rejects.toThrow(/SHA-256/i);

    await expect(
      ParticipantInviteModel.create({
        tripId,
        participantId,
        invitedByUserId: adminUserId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: sha256('expired-token'),
        grantedRole: 'PARTICIPANT',
        expiresAt: new Date(Date.now() - 1000),
      })
    ).rejects.toThrow(/future/i);

    // 4. Valid bearer invite for non-privileged PARTICIPANT defaults requireVerifiedEmail: false
    const bearerHash = sha256('valid-bearer-token');
    const guestInvite = await ParticipantInviteModel.create({
      tripId,
      participantId,
      invitedByUserId: adminUserId,
      invitedByParticipantId: adminParticipantId,
      tokenHash: bearerHash,
      grantedRole: 'PARTICIPANT',
      expiresAt: future,
    });
    expect(guestInvite.intendedEmail).toBeNull();
    expect(guestInvite.requireVerifiedEmail).toBe(false);

    // tokenHash is select: false by default and unique across invites
    const hiddenRead = await ParticipantInviteModel.findById(guestInvite._id).lean();
    expect(hiddenRead?.tokenHash).toBeUndefined();

    await expect(
      ParticipantInviteModel.create({
        tripId,
        participantId,
        invitedByUserId: adminUserId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: bearerHash,
        grantedRole: 'PARTICIPANT',
        expiresAt: future,
      })
    ).rejects.toThrow(/E11000/);

    // 5. Security policy fields fail closed on query updates while legitimate lifecycle updates work
    const claimedUserId = new mongoose.Types.ObjectId();
    const claimedAt = new Date();
    await expect(
      ParticipantInviteModel.findByIdAndUpdate(
        guestInvite._id,
        {
          $set: {
            grantedRole: 'ORGANIZER',
            requireVerifiedEmail: false,
            intendedEmail: 'hijack@example.com',
            usedAt: claimedAt,
            usedByUserId: claimedUserId,
          },
        },
        { new: true }
      )
    ).rejects.toThrow(/immutable/i);

    // Valid atomic claim update succeeds cleanly on legitimate lifecycle fields
    const updated = await ParticipantInviteModel.findByIdAndUpdate(
      guestInvite._id,
      { $set: { usedAt: claimedAt, usedByUserId: claimedUserId } },
      { new: true }
    );
    expect(updated?.grantedRole).toBe('PARTICIPANT');
    expect(updated?.requireVerifiedEmail).toBe(false);
    expect(updated?.intendedEmail).toBeNull();
    expect(updated?.usedAt?.toISOString()).toBe(claimedAt.toISOString());
    expect(updated?.usedByUserId?.toString()).toBe(claimedUserId.toString());

    const inviteIndexes = await ParticipantInviteModel.collection.indexes();
    expect(inviteIndexes.some((i) => i.name === PARTICIPANT_INVITE_TOKEN_INDEX_NAME)).toBe(true);
  });

  it('blocks all query-update/insertMany/lifecycle bypasses on ParticipantInvite, Trip.defaultInviteRole, and accepts PARTICIPANT_INVITE logs', async () => {
    const tripId = new mongoose.Types.ObjectId();
    const ownerId = new mongoose.Types.ObjectId();
    const participantId = new mongoose.Types.ObjectId();
    const adminParticipantId = new mongoose.Types.ObjectId();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 1. Trip.defaultInviteRole resists updateOne, overwriteImmutable, strict: false, pipeline, replaceOne, insertMany
    const trip = await TripModel.create({
      _id: tripId,
      name: 'Immutability Guard Trip',
      mode: 'FRIENDS',
      createdBy: ownerId,
      inviteCode: 'GUARD001',
      shareToken: 'share-guard-001',
    });

    await expect(
      TripModel.updateOne({ _id: trip._id }, { $set: { defaultInviteRole: 'CONTRIBUTOR' } })
    ).rejects.toThrow(/immutable/i);
    await expect(
      TripModel.findByIdAndUpdate(
        trip._id,
        { $set: { name: 'Renamed' } },
        { overwriteImmutable: true } as unknown as mongoose.QueryOptions
      )
    ).rejects.toThrow(/overwriteImmutable/i);
    await expect(
      TripModel.replaceOne(
        { _id: trip._id },
        {
          name: 'Replaced Trip',
          mode: 'FRIENDS',
          createdBy: ownerId,
          inviteCode: 'GUARD001',
          shareToken: 'share-guard-001',
          defaultInviteRole: 'CONTRIBUTOR',
        }
      )
    ).rejects.toThrow(/defaultInviteRole/i);
    await expect(
      TripModel.insertMany([
        {
          name: 'InsertMany Trip',
          mode: 'FRIENDS',
          createdBy: ownerId,
          inviteCode: 'GUARD002',
          shareToken: 'share-guard-002',
          defaultInviteRole: 'CONTRIBUTOR',
        },
      ])
    ).rejects.toThrow(/PARTICIPANT/i);

    // Legitimate non-immutable Trip updates continue working
    const renamedTrip = await TripModel.findByIdAndUpdate(
      trip._id,
      { $set: { name: 'Valid Updated Name', inviteEnabled: false } },
      { new: true }
    );
    expect(renamedTrip?.name).toBe('Valid Updated Name');
    expect(renamedTrip?.defaultInviteRole).toBe('PARTICIPANT');

    // 2. ParticipantInvite.insertMany rejects invalid privileged, expired, invalid-date, and inconsistent lifecycle invites
    await expect(
      ParticipantInviteModel.insertMany([
        {
          tripId,
          participantId,
          invitedByUserId: ownerId,
          invitedByParticipantId: adminParticipantId,
          tokenHash: sha256('insertmany-org-no-email'),
          grantedRole: 'ORGANIZER',
          expiresAt: future,
        },
      ])
    ).rejects.toThrow(/intendedEmail/i);

    await expect(
      ParticipantInviteModel.insertMany([
        {
          tripId,
          participantId,
          invitedByUserId: ownerId,
          invitedByParticipantId: adminParticipantId,
          tokenHash: sha256('insertmany-rep-no-verify'),
          grantedRole: 'FAMILY_REP',
          intendedEmail: 'rep@example.com',
          requireVerifiedEmail: false,
          expiresAt: future,
        },
      ])
    ).rejects.toThrow(/verification/i);

    await expect(
      ParticipantInviteModel.insertMany([
        {
          tripId,
          participantId,
          invitedByUserId: ownerId,
          invitedByParticipantId: adminParticipantId,
          tokenHash: sha256('insertmany-past'),
          grantedRole: 'PARTICIPANT',
          expiresAt: new Date(Date.now() - 5000),
        },
      ])
    ).rejects.toThrow(/future/i);

    await expect(
      ParticipantInviteModel.insertMany([
        {
          tripId,
          participantId,
          invitedByUserId: ownerId,
          invitedByParticipantId: adminParticipantId,
          tokenHash: sha256('insertmany-invalid-date'),
          grantedRole: 'PARTICIPANT',
          expiresAt: new Date('not-a-valid-date'),
        },
      ])
    ).rejects.toThrow(/valid Date/i);

    // Valid privileged ORGANIZER invite via insertMany auto-normalizes email & sets requireVerifiedEmail: true
    const [validOrgInvite] = await ParticipantInviteModel.insertMany([
      {
        tripId,
        participantId,
        invitedByUserId: ownerId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: sha256('insertmany-valid-org'),
        grantedRole: 'ORGANIZER',
        intendedEmail: '  Org.InsertMany@Example.COM ',
        expiresAt: future,
      },
    ]);
    expect(validOrgInvite.intendedEmail).toBe('org.insertmany@example.com');
    expect(validOrgInvite.requireVerifiedEmail).toBe(true);

    // 3. Query update bypass attempts fail closed on ParticipantInvite
    const claimerId = new mongoose.Types.ObjectId();
    for (const badAttempt of [
      () =>
        ParticipantInviteModel.updateOne(
          { _id: validOrgInvite._id },
          { $unset: { intendedEmail: 1 } },
          { runValidators: true }
        ),
      () =>
        ParticipantInviteModel.findOneAndUpdate(
          { _id: validOrgInvite._id },
          { $set: { usedAt: new Date(), usedByUserId: claimerId } },
          { overwriteImmutable: true, runValidators: true } as unknown as mongoose.QueryOptions
        ),
      () =>
        ParticipantInviteModel.updateOne(
          { _id: validOrgInvite._id },
          { $set: { usedAt: new Date(), usedByUserId: claimerId } },
          { strict: false }
        ),
      () =>
        ParticipantInviteModel.findOneAndUpdate(
          { _id: validOrgInvite._id },
          { $set: { requireVerifiedEmail: false } },
          { overwriteImmutable: true, runValidators: true } as unknown as mongoose.QueryOptions
        ),
      () =>
        ParticipantInviteModel.updateMany(
          { _id: validOrgInvite._id },
          [{ $set: { grantedRole: 'PARTICIPANT', requireVerifiedEmail: false } }]
        ),
      () =>
        ParticipantInviteModel.findOneAndUpdate(
          { _id: validOrgInvite._id },
          { $set: { usedAt: new Date() } } // missing usedByUserId
        ),
      () =>
        ParticipantInviteModel.findOneAndUpdate(
          { _id: validOrgInvite._id },
          {
            $set: {
              usedAt: new Date(),
              usedByUserId: claimerId,
              revokedAt: new Date(),
            },
          }
        ),
      () =>
        ParticipantInviteModel.replaceOne(
          { _id: validOrgInvite._id },
          {
            tripId,
            participantId,
            invitedByUserId: ownerId,
            invitedByParticipantId: adminParticipantId,
            tokenHash: sha256('replaced'),
            grantedRole: 'PARTICIPANT',
            requireVerifiedEmail: false,
            expiresAt: future,
          }
        ),
    ]) {
      await expect(badAttempt()).rejects.toThrow();
    }

    // 4. Document creation rejects inconsistent lifecycle states (used + revoked, partial used/revoked)
    await expect(
      ParticipantInviteModel.create({
        tripId,
        participantId,
        invitedByUserId: ownerId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: sha256('doc-used-without-user'),
        grantedRole: 'PARTICIPANT',
        expiresAt: future,
        usedAt: new Date(),
      })
    ).rejects.toThrow(/usedByUserId/i);

    await expect(
      ParticipantInviteModel.create({
        tripId,
        participantId,
        invitedByUserId: ownerId,
        invitedByParticipantId: adminParticipantId,
        tokenHash: sha256('doc-both-used-and-revoked'),
        grantedRole: 'PARTICIPANT',
        expiresAt: future,
        usedAt: new Date(),
        usedByUserId: claimerId,
        revokedAt: new Date(),
      })
    ).rejects.toThrow(/both used and revoked/i);

    // 5. Once used, invite cannot be un-used or revoked, and once revoked cannot be claimed
    const claimed = await ParticipantInviteModel.findOneAndUpdate(
      { _id: validOrgInvite._id },
      { $set: { usedAt: new Date(), usedByUserId: claimerId } },
      { new: true }
    );
    expect(claimed?.usedByUserId?.toString()).toBe(claimerId.toString());
    expect(claimed?.requireVerifiedEmail).toBe(true);

    await expect(
      ParticipantInviteModel.updateOne({ _id: validOrgInvite._id }, { $set: { usedAt: null } })
    ).rejects.toThrow(/cannot be cleared/i);
    await expect(
      ParticipantInviteModel.updateOne({ _id: validOrgInvite._id }, { $unset: { usedAt: '' } })
    ).rejects.toThrow(/append-only/i);

    // Query hook forces { usedAt: null, revokedAt: null }, so trying to revoke an already-used invite modifies 0 docs
    const lateRevoke = await ParticipantInviteModel.findOneAndUpdate(
      { _id: validOrgInvite._id },
      { $set: { revokedAt: new Date(), revokedByParticipantId: adminParticipantId } },
      { new: true }
    );
    expect(lateRevoke).toBeNull();
    const stillUsed = await ParticipantInviteModel.findById(validOrgInvite._id);
    expect(stillUsed?.revokedAt).toBeNull();
    expect(stillUsed?.usedAt).not.toBeNull();

    // 6. ActivityLog accepts entityType PARTICIPANT_INVITE
    const log = await ActivityLogModel.create({
      tripId,
      actorUserId: ownerId,
      actorParticipantId: adminParticipantId,
      actorName: 'Owner',
      actionType: 'PARTICIPANT_INVITE_CREATED',
      entityType: 'PARTICIPANT_INVITE',
      entityId: validOrgInvite._id,
      summary: 'Created invite for Co-Organizer',
    });
    expect(log.entityType).toBe('PARTICIPANT_INVITE');
  });

  it('blocks findOneAndReplace bypasses and reloaded terminal .save() reopening/retransitioning while preserving valid redemption, revocation, and non-terminal metadata updates', async () => {
    const tripId = new mongoose.Types.ObjectId();
    const ownerId = new mongoose.Types.ObjectId();
    const adminParticipantId = new mongoose.Types.ObjectId();
    const claimer1 = new mongoose.Types.ObjectId();
    const claimer2 = new mongoose.Types.ObjectId();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const trip = await TripModel.create({
      _id: tripId,
      name: 'FindOneAndReplace Guard Trip',
      mode: 'FRIENDS',
      createdBy: ownerId,
      inviteCode: 'FOR00001',
      shareToken: 'share-for-00001',
    });

    // 1. TripModel.findOneAndReplace() cannot change defaultInviteRole or bypass options
    await expect(
      TripModel.findOneAndReplace(
        { _id: trip._id },
        {
          name: 'Tampered Trip',
          mode: 'FRIENDS',
          createdBy: ownerId,
          inviteCode: 'FOR00001',
          shareToken: 'share-for-00001',
          defaultInviteRole: 'CONTRIBUTOR',
        }
      )
    ).rejects.toThrow(/defaultInviteRole/i);

    await expect(
      TripModel.findOneAndReplace(
        { _id: trip._id },
        {
          name: 'Tampered Null Role',
          mode: 'FRIENDS',
          createdBy: ownerId,
          inviteCode: 'FOR00001',
          shareToken: 'share-for-00001',
          defaultInviteRole: null as unknown as 'PARTICIPANT',
        }
      )
    ).rejects.toThrow(/defaultInviteRole/i);

    await expect(
      TripModel.findOneAndReplace(
        { _id: trip._id },
        {
          name: 'Opt Bypass',
          mode: 'FRIENDS',
          createdBy: ownerId,
          inviteCode: 'FOR00001',
          shareToken: 'share-for-00001',
        },
        { overwriteImmutable: true } as unknown as mongoose.QueryOptions
      )
    ).rejects.toThrow(/overwriteImmutable/i);

    await expect(
      TripModel.findOneAndReplace(
        { _id: trip._id },
        {
          name: 'Strict Bypass',
          mode: 'FRIENDS',
          createdBy: ownerId,
          inviteCode: 'FOR00001',
          shareToken: 'share-for-00001',
        },
        { strict: false }
      )
    ).rejects.toThrow(/strict: false/i);

    // Legitimate Trip.findOneAndReplace preserving PARTICIPANT continues working cleanly
    const legitReplacedTrip = await TripModel.findOneAndReplace(
      { _id: trip._id },
      {
        name: 'Legit Renamed via Replace',
        mode: 'FRIENDS',
        createdBy: ownerId,
        inviteCode: 'FOR00001',
        shareToken: 'share-for-00001',
        defaultInviteRole: 'PARTICIPANT',
      },
      { new: true }
    );
    expect(legitReplacedTrip?.name).toBe('Legit Renamed via Replace');
    expect(legitReplacedTrip?.defaultInviteRole).toBe('PARTICIPANT');

    // Legitimate findOneAndReplace omitting defaultInviteRole restores PARTICIPANT default
    const replacedWithoutRole = await TripModel.findOneAndReplace(
      { _id: trip._id },
      {
        name: 'Legit Replace Omitted Role',
        mode: 'FRIENDS',
        createdBy: ownerId,
        inviteCode: 'FOR00001',
        shareToken: 'share-for-00001',
      },
      { new: true }
    );
    expect(replacedWithoutRole?.defaultInviteRole).toBe('PARTICIPANT');

    // Partial .select('name') Trip document saves cleanly, while overwriteImmutable still fails
    const partialTrip = await TripModel.findById(trip._id).select('name');
    partialTrip!.name = 'Partial Select Update';
    await expect(partialTrip!.save()).resolves.toBeDefined();

    const partialTamperedTrip = await TripModel.findById(trip._id).select('name');
    partialTamperedTrip!.set('defaultInviteRole', 'CONTRIBUTOR', { overwriteImmutable: true });
    await expect(partialTamperedTrip!.save()).rejects.toThrow(/defaultInviteRole/i);

    // Also block Trip .set(..., { overwriteImmutable: true }).save() on full doc
    legitReplacedTrip!.set('defaultInviteRole', 'CONTRIBUTOR', { overwriteImmutable: true });
    await expect(legitReplacedTrip!.save()).rejects.toThrow(/defaultInviteRole/i);

    // 2. ParticipantInviteModel.findOneAndReplace() cannot replace an invite with an unverified privileged invite
    const redeemTarget = await ParticipantInviteModel.create({
      tripId,
      participantId: new mongoose.Types.ObjectId(),
      invitedByUserId: ownerId,
      invitedByParticipantId: adminParticipantId,
      tokenHash: sha256('for-invite-1'),
      grantedRole: 'PARTICIPANT',
      expiresAt: future,
    });

    for (const opts of [
      undefined,
      { runValidators: true },
      { overwriteImmutable: true } as mongoose.QueryOptions,
      { strict: false },
    ]) {
      await expect(
        ParticipantInviteModel.findOneAndReplace(
          { _id: redeemTarget._id },
          {
            tripId,
            participantId: redeemTarget.participantId,
            invitedByUserId: ownerId,
            invitedByParticipantId: adminParticipantId,
            tokenHash: sha256('for-invite-1-hijack'),
            grantedRole: 'ORGANIZER',
            requireVerifiedEmail: false,
            intendedEmail: null,
            expiresAt: future,
          },
          opts
        )
      ).rejects.toThrow(/findOneAndReplace/i);
    }

    // Confirm DB doc remained completely intact
    const intactAfterReplaceAttempt = await ParticipantInviteModel.findById(redeemTarget._id);
    expect(intactAfterReplaceAttempt?.grantedRole).toBe('PARTICIPANT');
    expect(intactAfterReplaceAttempt?.requireVerifiedEmail).toBe(false);

    // 3. Ordinary updates to non-terminal invitation metadata still work on unused invite
    const originalUpdatedAt = intactAfterReplaceAttempt!.updatedAt;
    const nextMetaTime = new Date(originalUpdatedAt.getTime() + 10000);
    intactAfterReplaceAttempt!.updatedAt = nextMetaTime;
    await intactAfterReplaceAttempt!.save();
    const viaQueryMeta = await ParticipantInviteModel.findByIdAndUpdate(
      redeemTarget._id,
      { $set: { updatedAt: new Date(nextMetaTime.getTime() + 5000) } },
      { new: true }
    );
    expect(viaQueryMeta).not.toBeNull();
    expect(viaQueryMeta!.usedAt).toBeNull();
    expect(viaQueryMeta!.revokedAt).toBeNull();

    // Also block valid-policy immutable changes via .set(..., { overwriteImmutable: true }).save()
    const reloadedForImmutableSave = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedForImmutableSave!.set('grantedRole', 'CONTRIBUTOR', { overwriteImmutable: true });
    await expect(reloadedForImmutableSave!.save()).rejects.toThrow(/immutable/i);

    // 4. Valid redemption works (findOneAndUpdate) AND valid .save() transition from unused -> redeemed works
    const saveRedeemTarget = await ParticipantInviteModel.create({
      tripId,
      participantId: new mongoose.Types.ObjectId(),
      invitedByUserId: ownerId,
      invitedByParticipantId: adminParticipantId,
      tokenHash: sha256('save-redeem-target'),
      grantedRole: 'CONTRIBUTOR',
      expiresAt: future,
    });

    const redeemedQuery = await ParticipantInviteModel.findOneAndUpdate(
      { _id: redeemTarget._id, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date(), usedByUserId: claimer1 } },
      { new: true }
    );
    expect(redeemedQuery?.usedAt).not.toBeNull();
    expect(redeemedQuery?.usedByUserId?.toString()).toBe(claimer1.toString());

    const reloadedForSaveRedeem = await ParticipantInviteModel.findById(saveRedeemTarget._id);
    reloadedForSaveRedeem!.usedAt = new Date();
    reloadedForSaveRedeem!.usedByUserId = claimer1;
    await reloadedForSaveRedeem!.save();
    expect(reloadedForSaveRedeem!.usedAt).not.toBeNull();

    // Immediately using the same in-memory instance cannot clear or convert to revoked
    reloadedForSaveRedeem!.usedAt = null;
    reloadedForSaveRedeem!.usedByUserId = null;
    await expect(reloadedForSaveRedeem!.save()).rejects.toThrow(/terminal/i);

    // 5. Reloaded redeemed invitation cannot be reopened, reassigned, or converted to revoked with .save()
    const reloadedRedeemedClear = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedRedeemedClear!.usedAt = null;
    reloadedRedeemedClear!.usedByUserId = null;
    await expect(reloadedRedeemedClear!.save()).rejects.toThrow(/terminal/i);

    const reloadedRedeemedReassign = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedRedeemedReassign!.usedByUserId = claimer2;
    await expect(reloadedRedeemedReassign!.save()).rejects.toThrow(/terminal/i);

    const reloadedRedeemedChangeTime = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedRedeemedChangeTime!.usedAt = new Date(Date.now() + 60000);
    await expect(reloadedRedeemedChangeTime!.save()).rejects.toThrow(/terminal/i);

    const reloadedRedeemedToRevoked = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedRedeemedToRevoked!.revokedAt = new Date();
    reloadedRedeemedToRevoked!.revokedByParticipantId = adminParticipantId;
    await expect(reloadedRedeemedToRevoked!.save()).rejects.toThrow(/both used and revoked/i);

    const reloadedRedeemedSwapToRevoked = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedRedeemedSwapToRevoked!.usedAt = null;
    reloadedRedeemedSwapToRevoked!.usedByUserId = null;
    reloadedRedeemedSwapToRevoked!.revokedAt = new Date();
    reloadedRedeemedSwapToRevoked!.revokedByParticipantId = adminParticipantId;
    await expect(reloadedRedeemedSwapToRevoked!.save()).rejects.toThrow(/terminal/i);

    // Non-terminal metadata save on a redeemed invite without modifying terminal fields still works
    const reloadedRedeemedMetaOnly = await ParticipantInviteModel.findById(redeemTarget._id);
    reloadedRedeemedMetaOnly!.updatedAt = new Date(Date.now() + 20000);
    await expect(reloadedRedeemedMetaOnly!.save()).resolves.toBeDefined();

    // 6. Valid revocation works (updateMany with & without actor) and reloaded revoked invitation fails closed
    const revokeTargetA = await ParticipantInviteModel.create({
      tripId,
      participantId: new mongoose.Types.ObjectId(),
      invitedByUserId: ownerId,
      invitedByParticipantId: adminParticipantId,
      tokenHash: sha256('revoke-target-a'),
      grantedRole: 'ORGANIZER',
      intendedEmail: 'Org.Revoke@Example.COM',
      expiresAt: future,
    });
    const revokeTargetB = await ParticipantInviteModel.create({
      tripId,
      participantId: new mongoose.Types.ObjectId(),
      invitedByUserId: ownerId,
      invitedByParticipantId: adminParticipantId,
      tokenHash: sha256('revoke-target-b'),
      grantedRole: 'PARTICIPANT',
      expiresAt: future,
    });

    const revResA = await ParticipantInviteModel.updateMany(
      { _id: revokeTargetA._id, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedByParticipantId: adminParticipantId } }
    );
    const revResB = await ParticipantInviteModel.updateMany(
      { _id: revokeTargetB._id, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    expect(revResA.modifiedCount).toBe(1);
    expect(revResB.modifiedCount).toBe(1);

    const reloadedRevokedClear = await ParticipantInviteModel.findById(revokeTargetA._id);
    reloadedRevokedClear!.revokedAt = null;
    reloadedRevokedClear!.revokedByParticipantId = null;
    await expect(reloadedRevokedClear!.save()).rejects.toThrow(/terminal/i);

    const reloadedRevokedChangeTime = await ParticipantInviteModel.findById(revokeTargetA._id);
    reloadedRevokedChangeTime!.revokedAt = new Date(Date.now() + 60000);
    await expect(reloadedRevokedChangeTime!.save()).rejects.toThrow(/terminal/i);

    const reloadedRevokedToRedeemed = await ParticipantInviteModel.findById(revokeTargetA._id);
    reloadedRevokedToRedeemed!.usedAt = new Date();
    reloadedRevokedToRedeemed!.usedByUserId = claimer1;
    await expect(reloadedRevokedToRedeemed!.save()).rejects.toThrow(/both used and revoked/i);

    const reloadedRevokedSwapToRedeemed = await ParticipantInviteModel.findById(revokeTargetA._id);
    reloadedRevokedSwapToRedeemed!.revokedAt = null;
    reloadedRevokedSwapToRedeemed!.revokedByParticipantId = null;
    reloadedRevokedSwapToRedeemed!.usedAt = new Date();
    reloadedRevokedSwapToRedeemed!.usedByUserId = claimer1;
    await expect(reloadedRevokedSwapToRedeemed!.save()).rejects.toThrow(/terminal/i);

    // Query operators other than top-level $set ($rename, $currentDate, $min, $setOnInsert, and clearing revokedByParticipantId) fail closed
    for (const opBypass of [
      () =>
        ParticipantInviteModel.updateOne(
          { _id: redeemTarget._id },
          { $rename: { usedAt: 'revokedAt' } }
        ),
      () =>
        ParticipantInviteModel.updateOne(
          { _id: revokeTargetB._id },
          { $rename: { createdAt: 'usedAt' } }
        ),
      () =>
        ParticipantInviteModel.findOneAndUpdate(
          { _id: redeemTarget._id },
          { $currentDate: { usedAt: true } }
        ),
      () =>
        ParticipantInviteModel.updateOne(
          { _id: redeemTarget._id },
          { $min: { usedAt: new Date(0) } }
        ),
      () =>
        ParticipantInviteModel.findOneAndUpdate(
          { _id: new mongoose.Types.ObjectId() },
          { $setOnInsert: { usedAt: new Date(), usedByUserId: claimer1 } },
          { upsert: true }
        ),
      () =>
        ParticipantInviteModel.updateOne(
          { _id: revokeTargetA._id },
          { $set: { revokedByParticipantId: null } }
        ),
    ]) {
      await expect(opBypass()).rejects.toThrow();
    }

    // Even using partial .select('updatedAt') projection on a redeemed/revoked doc blocks reopening
    const partialRedeemed = await ParticipantInviteModel.findById(redeemTarget._id).select('updatedAt');
    partialRedeemed!.usedAt = null;
    partialRedeemed!.usedByUserId = null;
    await expect(partialRedeemed!.save()).rejects.toThrow(/terminal/i);
  });

  it('migrates legacy non-unique Participant index safely, audits malformed/duplicate rows before mutation, preserves unrelated indexes, and stays idempotent', async () => {
    const col = ParticipantModel.collection;

    // Reset collection to simulate a pre-Phase-1 production DB
    await col.deleteMany({});
    try {
      await col.dropIndex(PARTICIPANT_TRIP_USER_INDEX_NAME);
    } catch {
      // Ignore if absent
    }

    await col.createIndex({ tripId: 1, userId: 1 }, { name: 'tripId_1_userId_1' });
    await col.createIndex({ email: 1 }, { name: 'custom_email_idx' });

    const tripId = new mongoose.Types.ObjectId();
    const user1 = new mongoose.Types.ObjectId();
    const user2 = new mongoose.Types.ObjectId();

    // 1. Aborts cleanly on malformed scalar and array-typed userId values without mutating indexes
    await col.insertOne({
      tripId,
      userId: 'corrupt-user-string',
      name: 'Corrupt String Row',
      role: 'PARTICIPANT',
      isActive: true,
    });
    await expect(migrateParticipantUserIndex(col)).rejects.toThrow(/malformed/i);

    await col.deleteMany({});
    await col.insertOne({
      tripId,
      userId: [user1],
      name: 'Corrupt Array ObjectId Row',
      role: 'PARTICIPANT',
      isActive: true,
    });
    await expect(migrateParticipantUserIndex(col)).rejects.toThrow(/malformed[\s\S]*"array"/i);

    let currentIndexes = await col.indexes();
    expect(currentIndexes.some((i) => i.name === PARTICIPANT_TRIP_USER_INDEX_NAME)).toBe(false);
    expect(currentIndexes.some((i) => i.name === 'tripId_1_userId_1')).toBe(true);
    expect(currentIndexes.some((i) => i.name === 'custom_email_idx')).toBe(true);

    // 2. Aborts cleanly on duplicate (tripId, userId) across active + inactive records
    await col.deleteMany({});
    await col.insertMany([
      { tripId, userId: user1, name: 'Old Deactivated', role: 'PARTICIPANT', isActive: false },
      { tripId, userId: user1, name: 'New Active', role: 'ORGANIZER', isActive: true },
    ]);
    await expect(migrateParticipantUserIndex(col)).rejects.toThrow(/duplicate/i);
    currentIndexes = await col.indexes();
    expect(currentIndexes.some((i) => i.name === PARTICIPANT_TRIP_USER_INDEX_NAME)).toBe(false);
    expect(currentIndexes.some((i) => i.name === 'tripId_1_userId_1')).toBe(true);

    // 3. Aborts cleanly if unfamiliar same-key indexes or corrupted target index options exist
    await col.deleteMany({});
    await col.dropIndex('tripId_1_userId_1');
    await col.createIndex(
      { tripId: 1, userId: 1 },
      { name: 'tripId_1_userId_1', unique: true }
    );
    await expect(migrateParticipantUserIndex(col)).rejects.toThrow(/unfamiliar/i);
    expect((await col.indexes()).some((i) => i.name === 'tripId_1_userId_1')).toBe(true);
    await col.dropIndex('tripId_1_userId_1');

    // Mismatched existing target index name must abort without overwriting
    await col.createIndex(
      { tripId: 1, userId: 1 },
      {
        name: PARTICIPANT_TRIP_USER_INDEX_NAME,
        unique: true,
        partialFilterExpression: { isActive: true },
      }
    );
    await expect(migrateParticipantUserIndex(col)).rejects.toThrow(/unexpected options/i);
    await col.dropIndex(PARTICIPANT_TRIP_USER_INDEX_NAME);

    // Failed createIndex preserves legacy tripId_1_userId_1 and custom indexes cleanly
    await col.createIndex({ tripId: 1, userId: 1 }, { name: 'tripId_1_userId_1' });
    const createSpy = vi
      .spyOn(col, 'createIndex')
      .mockRejectedValueOnce(new Error('Simulated index build failure'));
    await expect(migrateParticipantUserIndex(col)).rejects.toThrow(/Simulated index build failure/);
    createSpy.mockRestore();
    const afterCreateFailure = await col.indexes();
    expect(afterCreateFailure.some((i) => i.name === 'tripId_1_userId_1')).toBe(true);
    expect(afterCreateFailure.some((i) => i.name === 'custom_email_idx')).toBe(true);
    expect(afterCreateFailure.some((i) => i.name === PARTICIPANT_TRIP_USER_INDEX_NAME)).toBe(false);

    // Interrupted crash-resume (both target and legacy indexes exist simultaneously) completes cleanly
    await col.createIndex(
      { tripId: 1, userId: 1 },
      {
        name: PARTICIPANT_TRIP_USER_INDEX_NAME,
        unique: true,
        partialFilterExpression: { userId: { $type: 'objectId' } },
      }
    );
    const crashResume = await migrateParticipantUserIndex(col);
    expect(crashResume.createdNewIndex).toBe(false);
    expect(crashResume.verifiedNewIndexReady).toBe(true);
    expect(crashResume.droppedLegacyIndexNames).toEqual(['tripId_1_userId_1']);
    await col.dropIndex(PARTICIPANT_TRIP_USER_INDEX_NAME);

    // 4. Clean legacy collection: old tripId_1_userId_1 index, multiple guests, empty string userIds
    await col.createIndex({ tripId: 1, userId: 1 }, { name: 'tripId_1_userId_1' });
    await col.insertMany([
      { tripId, userId: null, name: 'Guest Null', role: 'PARTICIPANT', isActive: true },
      { tripId, name: 'Guest Omitted', role: 'CONTRIBUTOR', isActive: true },
      { tripId, userId: '', name: 'Guest Empty String', role: 'PARTICIPANT', isActive: true },
      { tripId, userId: '   ', name: 'Guest Whitespace', role: 'PARTICIPANT', isActive: true },
      { tripId, userId: user1, name: 'Linked Member', role: 'ORGANIZER', isActive: true },
    ]);

    const report1 = await migrateParticipantUserIndex(col);
    expect(report1.cleanedEmptyStringUserIdCount).toBe(2);
    expect(report1.invalidUserIdEntries).toEqual([]);
    expect(report1.duplicatePairs).toEqual([]);
    expect(report1.createdNewIndex).toBe(true);
    expect(report1.verifiedNewIndexReady).toBe(true);
    expect(report1.droppedLegacyIndexNames).toEqual(['tripId_1_userId_1']);

    const indexesAfter = await col.indexes();
    const targetIdx = indexesAfter.find((i) => i.name === PARTICIPANT_TRIP_USER_INDEX_NAME);
    expect(targetIdx?.unique).toBe(true);
    expect(targetIdx?.partialFilterExpression).toEqual({ userId: { $type: 'objectId' } });
    expect(indexesAfter.some((i) => i.name === 'tripId_1_userId_1')).toBe(false);
    expect(indexesAfter.some((i) => i.name === 'custom_email_idx')).toBe(true);
    expect(indexesAfter.some((i) => i.name === 'tripId_1_isActive_1')).toBe(true);

    // Empty-string userIds were normalized to null (3 explicit nulls + 1 omitted = 4 unlinked slots),
    // duplicate ObjectId insert is now blocked, while additional guests and distinct linked users succeed.
    const explicitNullCount = await col.countDocuments({ tripId, userId: { $type: 'null' } });
    const unlinkedCount = await col.countDocuments({ tripId, userId: null });
    const remainingStringUserIds = await col.countDocuments({
      tripId,
      userId: { $type: 'string' },
    });
    expect(explicitNullCount).toBe(3);
    expect(unlinkedCount).toBe(4);
    expect(remainingStringUserIds).toBe(0);

    await expect(
      col.insertOne({ tripId, userId: user1, name: 'Dup Race', role: 'PARTICIPANT', isActive: true })
    ).rejects.toThrow(/E11000/);

    await col.insertOne({ tripId, userId: user2, name: 'Distinct Member', role: 'PARTICIPANT', isActive: true });

    // 5. Repeat run is strictly idempotent
    const report2 = await migrateParticipantUserIndex(col);
    expect(report2.cleanedEmptyStringUserIdCount).toBe(0);
    expect(report2.createdNewIndex).toBe(false);
    expect(report2.verifiedNewIndexReady).toBe(true);
    expect(report2.droppedLegacyIndexNames).toEqual([]);

    // 6. Fresh nonexistent collection creates collection and partial unique index cleanly
    const freshCol = mongoose.connection.collection('fresh_participants_migration_test');
    const freshReport = await migrateParticipantUserIndex(freshCol);
    expect(freshReport.createdNewIndex).toBe(true);
    expect(freshReport.verifiedNewIndexReady).toBe(true);
    expect(freshReport.droppedLegacyIndexNames).toEqual([]);
    await freshCol.drop();

    await col.dropIndex('custom_email_idx');
  });

  it('backfills legacy User/Trip security defaults safely without auto-verifying users and audits historical privileged risk links', async () => {
    const db = mongoose.connection.db!;
    const creatorId = new mongoose.Types.ObjectId();
    const hijackerId = new mongoose.Types.ObjectId();
    const verifiedCoOrgId = new mongoose.Types.ObjectId();
    const legacyTripId = new mongoose.Types.ObjectId();

    await db.collection('users').insertMany([
      {
        _id: creatorId,
        name: 'Creator Legacy',
        email: 'creator@example.com',
        passwordHash: 'hash',
      },
      {
        _id: hijackerId,
        name: 'Unverified Hijacker',
        email: 'rep@example.com',
        passwordHash: 'hash',
        emailVerified: null,
      },
      {
        _id: verifiedCoOrgId,
        name: 'Verified Co-Org',
        email: 'coorg@example.com',
        passwordHash: 'hash',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    ]);

    const explicitFalseId = new mongoose.Types.ObjectId();
    const invalidStringVerifiedId = new mongoose.Types.ObjectId();
    await db.collection('users').insertMany([
      {
        _id: explicitFalseId,
        name: 'Explicit False',
        email: 'false@example.com',
        passwordHash: 'hash',
        emailVerified: false,
      },
      {
        _id: invalidStringVerifiedId,
        name: 'Corrupt Verified Type',
        email: 'corrupt@example.com',
        passwordHash: 'hash',
        emailVerified: 'true',
      },
    ]);

    await db.collection('trips').insertOne({
      _id: legacyTripId,
      name: 'Legacy Pre-SEC01 Trip',
      mode: 'FAMILY',
      createdBy: creatorId,
      inviteCode: 'LEGACY01',
      shareToken: 'legacy-share-01',
    });

    await db.collection('participants').insertMany([
      {
        tripId: legacyTripId,
        userId: creatorId,
        name: 'Creator Legacy',
        email: 'creator@example.com',
        role: 'ORGANIZER',
        isActive: true,
      },
      {
        tripId: legacyTripId,
        userId: hijackerId,
        name: 'Claimed Rep',
        email: 'rep@example.com',
        role: 'FAMILY_REP',
        isActive: true,
      },
      {
        tripId: legacyTripId,
        userId: verifiedCoOrgId,
        name: 'Verified Co-Org',
        email: 'coorg@example.com',
        role: 'ORGANIZER',
        isActive: true,
      },
      {
        tripId: legacyTripId,
        userId: null,
        name: 'Waiting Priv Guest',
        email: 'waiting-org@example.com',
        role: 'ORGANIZER',
        isActive: true,
      },
      {
        tripId: legacyTripId,
        userId: '',
        name: 'Waiting Empty UserId Guest',
        email: 'waiting-friend@example.com',
        role: 'PARTICIPANT',
        isActive: true,
      },
      {
        tripId: legacyTripId,
        userId: null,
        name: 'Whitespace Email Guest',
        email: '   ',
        role: 'ORGANIZER',
        isActive: true,
      },
    ]);

    const backfill = await backfillInviteSecurityDefaults(db);
    // creator (missing), hijacker (null), corrupt ('true') -> 3 normalized; explicit false & true untouched
    expect(backfill.updatedUsersCount).toBe(3);
    expect(backfill.updatedTripsInviteEnabledCount).toBe(1);
    expect(backfill.updatedTripsDefaultRoleCount).toBe(1);

    // Ensure legacy/invalid accounts are normalized to emailVerified: false and verified stayed true
    const creatorDoc = await db.collection('users').findOne({ _id: creatorId });
    const hijackerDoc = await db.collection('users').findOne({ _id: hijackerId });
    const corruptVerifiedDoc = await db.collection('users').findOne({ _id: invalidStringVerifiedId });
    const verifiedDoc = await db.collection('users').findOne({ _id: verifiedCoOrgId });
    expect(creatorDoc?.emailVerified).toBe(false);
    expect(hijackerDoc?.emailVerified).toBe(false);
    expect(corruptVerifiedDoc?.emailVerified).toBe(false);
    expect(verifiedDoc?.emailVerified).toBe(true);

    const legacyTripDoc = await db.collection('trips').findOne({ _id: legacyTripId });
    expect(legacyTripDoc?.inviteEnabled).toBe(true);
    expect(legacyTripDoc?.defaultInviteRole).toBe('PARTICIPANT');

    // Audit ignores whitespace-only emails and includes unmigrated empty-string userId guest slots
    const audit = await auditParticipantLinkingRisks(db);
    expect(audit.unverifiedUsersCount).toBe(4);
    expect(audit.unlinkedGuestsWithEmailCount).toBe(2);
    expect(audit.unlinkedPrivilegedGuestsWithEmailCount).toBe(1);
    expect(audit.nonCreatorUnverifiedPrivilegedLinks).toHaveLength(1);
    expect(audit.nonCreatorUnverifiedPrivilegedLinks[0]).toMatchObject({
      tripId: legacyTripId.toString(),
      userId: hijackerId.toString(),
      role: 'FAMILY_REP',
      email: 'rep@example.com',
      userEmailVerified: false,
    });
  });

  it('CLI --audit-only connects with autoIndex: false and performs zero index or document mutations on un-migrated DB', async () => {
    const db = mongoose.connection.db!;
    const pCol = db.collection('participants');

    // Reset to un-migrated production-like indexes: only _id_ and legacy tripId_1_userId_1
    await db.dropDatabase();
    await pCol.createIndex({ tripId: 1, userId: 1 }, { name: 'tripId_1_userId_1' });

    const tripId = new mongoose.Types.ObjectId();
    const unverifiedUserId = new mongoose.Types.ObjectId();
    await db.collection('users').insertOne({
      _id: unverifiedUserId,
      name: 'Legacy User',
      email: 'legacy@example.com',
      passwordHash: 'hash',
    });
    await db.collection('trips').insertOne({
      _id: tripId,
      name: 'Unmigrated Audit Trip',
      mode: 'FRIENDS',
      createdBy: new mongoose.Types.ObjectId(),
      inviteCode: 'AUDIT001',
      shareToken: 'share-audit-001',
    });
    await pCol.insertMany([
      {
        tripId,
        userId: unverifiedUserId,
        name: 'Hijacked Organizer',
        email: 'legacy@example.com',
        role: 'ORGANIZER',
        isActive: true,
      },
      {
        tripId,
        userId: '',
        name: 'Empty String Guest',
        email: 'guest-empty@example.com',
        role: 'PARTICIPANT',
        isActive: true,
      },
      {
        tripId,
        userId: null,
        name: 'Whitespace Email Priv Guest',
        email: '   ',
        role: 'ORGANIZER',
        isActive: true,
      },
    ]);

    await disconnectDatabase();
    try {
      const cliResult = await runParticipantMigrationCli(['--audit-only'], TEST_DB_URI);
      expect(cliResult.mode).toBe('audit-only');
      expect(cliResult.auditReport.unverifiedUsersCount).toBe(1);
      expect(cliResult.auditReport.unlinkedGuestsWithEmailCount).toBe(1);
      expect(cliResult.auditReport.unlinkedPrivilegedGuestsWithEmailCount).toBe(0);
      expect(cliResult.auditReport.nonCreatorUnverifiedPrivilegedLinks).toHaveLength(1);
    } finally {
      await connectDatabase(TEST_DB_URI, { autoIndex: false });
    }

    const postAuditDb = mongoose.connection.db!;
    const postIndexes = await postAuditDb.collection('participants').indexes();
    expect(postIndexes.map((i) => i.name).sort()).toEqual(['_id_', 'tripId_1_userId_1']);
    expect(postIndexes.some((i) => i.name === PARTICIPANT_TRIP_USER_INDEX_NAME)).toBe(false);

    // Verify with autoIndex: false that users verification-token index is NOT created until explicit migration runs
    const preUserIndexes = await postAuditDb.collection('users').indexes();
    expect(
      preUserIndexes.some((i) => i.name === 'emailVerificationTokenHash_partial_unique')
    ).toBe(false);

    // Documents remain completely untouched (emailVerified still absent, userId still '')
    const rawUser = await postAuditDb.collection('users').findOne({ _id: unverifiedUserId });
    expect('emailVerified' in (rawUser ?? {})).toBe(false);
    const rawEmptyGuest = await postAuditDb
      .collection('participants')
      .findOne({ name: 'Empty String Guest' });
    expect(rawEmptyGuest?.userId).toBe('');
  });

  it('autoIndex: false leaves users.emailVerificationTokenHash_partial_unique absent until migration applies it idempotently', async () => {
    const db = mongoose.connection.db!;
    await db.dropDatabase();

    // Seed un-migrated collections without indexes (simulating production DB before migration with autoIndex: false)
    await db.collection('users').insertOne({
      name: 'AutoIndex Check',
      email: 'autoindex@example.com',
      passwordHash: 'hash',
      emailVerificationTokenHash: '',
    });
    await db.collection('participants').createIndex({ tripId: 1, userId: 1 }, { name: 'tripId_1_userId_1' });

    await disconnectDatabase();
    try {
      const preAudit = await runParticipantMigrationCli(['--audit-only'], TEST_DB_URI);
      expect(preAudit.mode).toBe('audit-only');
      expect(preAudit.auditReport.participantsTripUserPartialIndexPresent).toBe(false);
      expect(preAudit.auditReport.usersVerificationTokenPartialIndexPresent).toBe(false);
      expect(preAudit.auditReport.rateLimitBucketIndexesPresent).toBe(false);
      expect(preAudit.auditReport.participantInvitesIndexesPresent).toBe(false);

      const migrated = await runParticipantMigrationCli([], TEST_DB_URI);
      expect(migrated.mode).toBe('migrate');
      if (migrated.mode === 'migrate') {
        expect(migrated.userVerificationIndexReport.createdNewIndex).toBe(true);
        expect(migrated.userVerificationIndexReport.verifiedNewIndexReady).toBe(true);
        expect(migrated.userVerificationIndexReport.cleanedEmptyStringTokenCount).toBe(1);
        expect(migrated.auditReport.participantsTripUserPartialIndexPresent).toBe(true);
        expect(migrated.auditReport.usersVerificationTokenPartialIndexPresent).toBe(true);
        expect(migrated.auditReport.rateLimitBucketIndexesPresent).toBe(true);
        expect(migrated.auditReport.participantInvitesIndexesPresent).toBe(true);
      }

      // Repeat execution is idempotent
      const repeat = await runParticipantMigrationCli([], TEST_DB_URI);
      if (repeat.mode === 'migrate') {
        expect(repeat.userVerificationIndexReport.createdNewIndex).toBe(false);
        expect(repeat.userVerificationIndexReport.verifiedNewIndexReady).toBe(true);
      }
    } finally {
      await connectDatabase(TEST_DB_URI);
    }
  });
});
