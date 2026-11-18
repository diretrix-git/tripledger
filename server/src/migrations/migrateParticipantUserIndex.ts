import path from 'path';
import { pathToFileURL } from 'url';
import mongoose from 'mongoose';
import { DEFAULT_OPEN_INVITE_ROLE, PRIVILEGED_TRIP_ROLES } from '@tripledger/shared';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ActivityLogModel } from '../models/ActivityLog.js';
import {
  PARTICIPANT_TRIP_USER_INDEX_NAME,
  ParticipantModel,
} from '../models/Participant.js';
import {
  PARTICIPANT_INVITE_EMAIL_PENDING_INDEX_NAME,
  PARTICIPANT_INVITE_TOKEN_INDEX_NAME,
  ParticipantInviteModel,
} from '../models/ParticipantInvite.js';
import {
  USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME,
  UserModel,
} from '../models/User.js';
import { supportsTransactions } from '../services/atomicWrite.js';
import { ensureRateLimitIndexes } from '../services/rateLimitStore.js';

export interface DuplicateTripUserAuditEntry {
  tripId: string;
  userId: string;
  count: number;
  participantIds: string[];
  roles: string[];
  isActiveStates: boolean[];
}

export interface InvalidParticipantUserIdEntry {
  participantId: string;
  tripId: string;
  rawUserIdType: string;
  rawUserId: unknown;
}

export interface ParticipantUserIndexMigrationReport {
  cleanedEmptyStringUserIdCount: number;
  invalidUserIdEntries: InvalidParticipantUserIdEntry[];
  duplicatePairs: DuplicateTripUserAuditEntry[];
  createdNewIndex: boolean;
  verifiedNewIndexReady: boolean;
  droppedLegacyIndexNames: string[];
}

export interface UserVerificationTokenIndexMigrationReport {
  cleanedEmptyStringTokenCount: number;
  duplicateTokenHashesCount: number;
  createdNewIndex: boolean;
  verifiedNewIndexReady: boolean;
}

export interface LegacyInviteDefaultsBackfillReport {
  updatedUsersCount: number;
  updatedTripsInviteEnabledCount: number;
  updatedTripsDefaultRoleCount: number;
}

export interface LegacyFamilyRepInviteMigrationReport {
  scannedPendingCount: number;
  revokedLegacyFamilyRepInvitesCount: number;
  recoveredAuditLogsCount: number;
  revokedInviteIds: string[];
}

export interface HistoricalPrivilegedLinkRiskEntry {
  tripId: string;
  participantId: string;
  userId: string;
  role: string;
  email: string | null;
  userEmailVerified: boolean;
}

export interface ParticipantLinkingRiskAuditReport {
  unverifiedUsersCount: number;
  unlinkedGuestsWithEmailCount: number;
  unlinkedPrivilegedGuestsWithEmailCount: number;
  unlinkedPrivilegedGuestsCount: number;
  pendingLegacyFamilyRepInvitesMissingFamilyIdCount: number;
  pendingMigrationAuditLogsCount: number;
  nonCreatorUnverifiedPrivilegedLinks: HistoricalPrivilegedLinkRiskEntry[];
  participantsTripUserPartialIndexPresent: boolean;
  usersVerificationTokenPartialIndexPresent: boolean;
  rateLimitBucketIndexesPresent: boolean;
  participantInvitesIndexesPresent: boolean;
}

const LEGACY_PENDING_FAMILY_REP_INVITE_FILTER = {
  grantedRole: 'FAMILY_REP',
  usedAt: null,
  revokedAt: null,
  $or: [{ familyId: { $not: { $type: 'objectId' } } }, { familyId: { $type: 'array' } }],
};

interface IndexInfo {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
  collation?: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSameUserObjectIdPartialFilter(expr: unknown): boolean {
  if (!isPlainRecord(expr)) return false;
  const topKeys = Object.keys(expr);
  if (topKeys.length !== 1 || topKeys[0] !== 'userId') {
    return false;
  }
  const field = expr.userId;
  if (!isPlainRecord(field)) return false;
  const fieldKeys = Object.keys(field);
  return fieldKeys.length === 1 && fieldKeys[0] === '$type' && field.$type === 'objectId';
}

function isTripUserKey(key: Record<string, unknown> | undefined): boolean {
  if (!key) return false;
  const entries = Object.entries(key);
  return (
    entries.length === 2 &&
    entries[0][0] === 'tripId' &&
    entries[0][1] === 1 &&
    entries[1][0] === 'userId' &&
    entries[1][1] === 1
  );
}

function isExpectedTargetPartialIndex(idx: IndexInfo): boolean {
  return (
    idx.name === PARTICIPANT_TRIP_USER_INDEX_NAME &&
    idx.unique === true &&
    idx.sparse !== true &&
    isTripUserKey(idx.key) &&
    isSameUserObjectIdPartialFilter(idx.partialFilterExpression) &&
    idx.expireAfterSeconds === undefined &&
    idx.collation === undefined
  );
}

function isExpectedLegacyNonUniqueIndex(idx: IndexInfo): boolean {
  return (
    idx.name === 'tripId_1_userId_1' &&
    idx.unique !== true &&
    idx.sparse !== true &&
    isTripUserKey(idx.key) &&
    idx.partialFilterExpression === undefined &&
    idx.expireAfterSeconds === undefined &&
    idx.collation === undefined
  );
}

function isUserVerificationTokenKey(key: Record<string, unknown> | undefined): boolean {
  if (!key) return false;
  const entries = Object.entries(key);
  return (
    entries.length === 1 &&
    entries[0][0] === 'emailVerificationTokenHash' &&
    entries[0][1] === 1
  );
}

function isExpectedUserVerificationPartialFilter(expr: unknown): boolean {
  if (!isPlainRecord(expr)) return false;
  const topKeys = Object.keys(expr);
  if (topKeys.length !== 1 || topKeys[0] !== 'emailVerificationTokenHash') {
    return false;
  }
  const field = expr.emailVerificationTokenHash;
  if (!isPlainRecord(field)) return false;
  const fieldKeys = Object.keys(field).sort();
  return (
    fieldKeys.length === 2 &&
    fieldKeys[0] === '$gt' &&
    fieldKeys[1] === '$type' &&
    field.$type === 'string' &&
    field.$gt === ''
  );
}

function hasKeySequence(
  key: Record<string, unknown> | undefined,
  expectedEntries: ReadonlyArray<readonly [string, number]>
): boolean {
  if (!key) return false;
  const entries = Object.entries(key);
  if (entries.length !== expectedEntries.length) return false;
  return expectedEntries.every(
    ([field, dir], idx) => entries[idx]?.[0] === field && entries[idx]?.[1] === dir
  );
}

function areParticipantInviteIndexesPresent(indexes: readonly IndexInfo[]): boolean {
  const hasTokenUnique = indexes.some(
    (idx) =>
      idx.name === PARTICIPANT_INVITE_TOKEN_INDEX_NAME &&
      idx.unique === true &&
      hasKeySequence(idx.key, [['tokenHash', 1]])
  );
  const hasEmailPending = indexes.some(
    (idx) =>
      idx.name === PARTICIPANT_INVITE_EMAIL_PENDING_INDEX_NAME &&
      hasKeySequence(idx.key, [
        ['intendedEmail', 1],
        ['usedAt', 1],
        ['revokedAt', 1],
        ['expiresAt', 1],
      ])
  );
  const hasParticipantPending = indexes.some((idx) =>
    hasKeySequence(idx.key, [
      ['participantId', 1],
      ['usedAt', 1],
      ['revokedAt', 1],
    ])
  );
  const hasTripHistory = indexes.some((idx) =>
    hasKeySequence(idx.key, [
      ['tripId', 1],
      ['participantId', 1],
      ['createdAt', -1],
    ])
  );
  return hasTokenUnique && hasEmailPending && hasParticipantPending && hasTripHistory;
}

export async function ensureParticipantInviteIndexes(
  collection: mongoose.Collection = ParticipantInviteModel.collection
): Promise<void> {
  await ensureCollectionExists(collection);
  await collection.createIndex(
    { tokenHash: 1 },
    { name: PARTICIPANT_INVITE_TOKEN_INDEX_NAME, unique: true }
  );
  await collection.createIndex({ participantId: 1, usedAt: 1, revokedAt: 1 });
  await collection.createIndex(
    { intendedEmail: 1, usedAt: 1, revokedAt: 1, expiresAt: 1 },
    { name: PARTICIPANT_INVITE_EMAIL_PENDING_INDEX_NAME }
  );
  await collection.createIndex({ tripId: 1, participantId: 1, createdAt: -1 });
}

function isExpectedUserVerificationPartialIndex(idx: IndexInfo): boolean {
  return (
    idx.name === USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME &&
    idx.unique === true &&
    idx.sparse !== true &&
    isUserVerificationTokenKey(idx.key) &&
    isExpectedUserVerificationPartialFilter(idx.partialFilterExpression) &&
    idx.expireAfterSeconds === undefined &&
    idx.collation === undefined
  );
}

async function listCollectionIndexesReadOnly(
  db: NonNullable<mongoose.Connection['db']>,
  collectionName: string
): Promise<IndexInfo[]> {
  const existing = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .toArray();
  if (existing.length === 0) {
    return [];
  }
  return (await db.collection(collectionName).indexes()) as IndexInfo[];
}

async function ensureCollectionExists(collection: mongoose.Collection): Promise<void> {
  const db = collection.conn.db;
  if (!db) return;

  const existing = await db
    .listCollections({ name: collection.collectionName }, { nameOnly: true })
    .toArray();
  if (existing.length === 0) {
    await db.createCollection(collection.collectionName);
  }
}

/**
 * Safely migrates the `participants` collection from the legacy non-unique compound index
 * (`tripId_1_userId_1`) to the explicit partial unique index
 * (`tripId_1_userId_partial_unique`).
 *
 * Properties:
 * - Idempotent / repeatable: safe to run multiple times.
 * - Preserves all unrelated indexes (never calls unrestricted `syncIndexes()`).
 * - Audits malformed non-empty non-ObjectId `userId` values BEFORE changing indexes.
 * - Audits duplicate non-null `(tripId, userId)` pairs across BOTH active and inactive
 *   participants BEFORE changing indexes, aborting with diagnostics instead of deleting records.
 * - Creates and verifies readiness of the new partial unique index before dropping the legacy index.
 * - Preserves multiple `userId: null` / omitted guest records per trip.
 */
export async function migrateParticipantUserIndex(
  collection: mongoose.Collection = ParticipantModel.collection
): Promise<ParticipantUserIndexMigrationReport> {
  await ensureCollectionExists(collection);

  // Step 1a: Audit malformed userId values (arrays including ObjectId arrays, or non-empty
  // non-ObjectId scalar/object values) BEFORE creating any index.
  const invalidDocs = await collection
    .find<{ _id: unknown; tripId: unknown; userId: unknown }>({
      $or: [
        { userId: { $type: 'array' } },
        {
          $and: [
            { userId: { $exists: true } },
            { userId: { $ne: null } },
            { userId: { $not: { $type: 'objectId' } } },
            {
              $or: [
                { userId: { $not: { $type: 'string' } } },
                { userId: { $type: 'string', $not: /^\s*$/ } },
              ],
            },
          ],
        },
      ],
    })
    .toArray();

  const invalidUserIdEntries: InvalidParticipantUserIdEntry[] = invalidDocs.map((doc) => ({
    participantId: String(doc._id),
    tripId: String(doc.tripId),
    rawUserIdType: Array.isArray(doc.userId) ? 'array' : typeof doc.userId,
    rawUserId: doc.userId,
  }));

  if (invalidUserIdEntries.length > 0) {
    throw new Error(
      `Cannot migrate ${PARTICIPANT_TRIP_USER_INDEX_NAME}: found ${invalidUserIdEntries.length} participant(s) with malformed non-ObjectId userId values requiring manual review: ${JSON.stringify(
        invalidUserIdEntries
      )}`
    );
  }

  // Step 1b: Audit duplicate (tripId, userId) pairs across BOTH active and inactive rows.
  const duplicateDocs = await collection
    .aggregate<{
      _id: { tripId: unknown; userId: unknown };
      count: number;
      participantIds: unknown[];
      roles: string[];
      isActiveStates: boolean[];
    }>([
      { $match: { userId: { $type: 'objectId' } } },
      {
        $group: {
          _id: { tripId: '$tripId', userId: '$userId' },
          count: { $sum: 1 },
          participantIds: { $push: '$_id' },
          roles: { $push: '$role' },
          isActiveStates: { $push: '$isActive' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  const duplicatePairs: DuplicateTripUserAuditEntry[] = duplicateDocs.map((d) => ({
    tripId: String(d._id.tripId),
    userId: String(d._id.userId),
    count: d.count,
    participantIds: d.participantIds.map((id) => String(id)),
    roles: d.roles,
    isActiveStates: d.isActiveStates,
  }));

  if (duplicatePairs.length > 0) {
    throw new Error(
      `Cannot build ${PARTICIPANT_TRIP_USER_INDEX_NAME}: found ${duplicatePairs.length} duplicate (tripId, userId) pair(s): ${JSON.stringify(
        duplicatePairs
      )}`
    );
  }

  // Step 2: Inspect existing indexes selectively before mutating anything.
  const beforeIndexes = (await collection.indexes()) as IndexInfo[];
  const existingTarget = beforeIndexes.find((idx) => idx.name === PARTICIPANT_TRIP_USER_INDEX_NAME);

  if (existingTarget && !isExpectedTargetPartialIndex(existingTarget)) {
    throw new Error(
      `Existing index "${PARTICIPANT_TRIP_USER_INDEX_NAME}" has unexpected options and was not overwritten automatically: ${JSON.stringify(
        {
          unique: existingTarget.unique ?? false,
          sparse: existingTarget.sparse ?? false,
          key: existingTarget.key,
          partialFilterExpression: existingTarget.partialFilterExpression,
          expireAfterSeconds: existingTarget.expireAfterSeconds,
          collation: existingTarget.collation,
        }
      )}`
    );
  }

  const unfamiliarCompoundIndexes = beforeIndexes.filter(
    (idx) =>
      idx.name !== PARTICIPANT_TRIP_USER_INDEX_NAME &&
      isTripUserKey(idx.key) &&
      !isExpectedLegacyNonUniqueIndex(idx)
  );
  if (unfamiliarCompoundIndexes.length > 0) {
    throw new Error(
      `Cannot migrate ${PARTICIPANT_TRIP_USER_INDEX_NAME}: found ${unfamiliarCompoundIndexes.length} unfamiliar index(es) on (tripId, userId) requiring manual inspection: ${JSON.stringify(
        unfamiliarCompoundIndexes.map((idx) => ({
          name: idx.name,
          unique: idx.unique ?? false,
          sparse: idx.sparse ?? false,
          partialFilterExpression: idx.partialFilterExpression,
          expireAfterSeconds: idx.expireAfterSeconds,
          collation: idx.collation,
        }))
      )}`
    );
  }

  let createdNewIndex = false;
  if (!existingTarget) {
    await collection.createIndex(
      { tripId: 1, userId: 1 },
      {
        name: PARTICIPANT_TRIP_USER_INDEX_NAME,
        unique: true,
        partialFilterExpression: { userId: { $type: 'objectId' } },
      }
    );
    createdNewIndex = true;
  }

  // Step 3: Verify target index is ready BEFORE dropping the legacy non-unique index.
  const verifiedIndexes = (await collection.indexes()) as IndexInfo[];
  const readyTarget = verifiedIndexes.find((idx) => idx.name === PARTICIPANT_TRIP_USER_INDEX_NAME);
  const verifiedNewIndexReady = Boolean(readyTarget && isExpectedTargetPartialIndex(readyTarget));

  if (!verifiedNewIndexReady) {
    throw new Error(
      `Verification failed: index "${PARTICIPANT_TRIP_USER_INDEX_NAME}" was not ready after creation.`
    );
  }

  // Step 4: Drop ONLY the legacy non-unique compound index (`tripId_1_userId_1`).
  const droppedLegacyIndexNames: string[] = [];
  for (const idx of verifiedIndexes) {
    if (isExpectedLegacyNonUniqueIndex(idx) && idx.name) {
      await collection.dropIndex(idx.name);
      droppedLegacyIndexNames.push(idx.name);
    }
  }

  // Step 5: Normalize legacy empty/whitespace string userId values cleanly to `null`
  // so unlinked guest queries (`{ userId: null }`) match consistently.
  const cleanupResult = await collection.updateMany(
    { userId: { $type: 'string', $regex: /^\s*$/ } },
    { $set: { userId: null } }
  );
  const cleanedEmptyStringUserIdCount = cleanupResult.modifiedCount ?? 0;

  return {
    cleanedEmptyStringUserIdCount,
    invalidUserIdEntries,
    duplicatePairs,
    createdNewIndex,
    verifiedNewIndexReady,
    droppedLegacyIndexNames,
  };
}

/**
 * Safely ensures `users.emailVerificationTokenHash_partial_unique` exists even when Mongoose
 * `autoIndex` is disabled in production. Aborts before DDL if duplicate non-empty hashes or
 * conflicting index specifications exist.
 */
export async function migrateUserVerificationTokenIndex(
  collection: mongoose.Collection = UserModel.collection
): Promise<UserVerificationTokenIndexMigrationReport> {
  await ensureCollectionExists(collection);

  const duplicateHashes = await collection
    .aggregate<{ _id: string; count: number }>([
      { $match: { emailVerificationTokenHash: { $type: 'string', $gt: '' } } },
      { $group: { _id: '$emailVerificationTokenHash', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicateHashes.length > 0) {
    throw new Error(
      `Cannot build ${USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME}: found ${duplicateHashes.length} duplicate verification token hash(es).`
    );
  }

  const beforeIndexes = (await collection.indexes()) as IndexInfo[];
  const existingTarget = beforeIndexes.find(
    (idx) => idx.name === USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME
  );

  if (existingTarget && !isExpectedUserVerificationPartialIndex(existingTarget)) {
    throw new Error(
      `Existing index "${USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME}" has unexpected options and was not overwritten automatically.`
    );
  }

  const unfamiliarTokenIndexes = beforeIndexes.filter(
    (idx) =>
      idx.name !== USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME &&
      isUserVerificationTokenKey(idx.key)
  );
  if (unfamiliarTokenIndexes.length > 0) {
    throw new Error(
      `Cannot migrate ${USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME}: found unfamiliar index(es) on emailVerificationTokenHash: ${JSON.stringify(
        unfamiliarTokenIndexes.map((idx) => idx.name)
      )}`
    );
  }

  let createdNewIndex = false;
  if (!existingTarget) {
    await collection.createIndex(
      { emailVerificationTokenHash: 1 },
      {
        name: USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME,
        unique: true,
        partialFilterExpression: { emailVerificationTokenHash: { $type: 'string', $gt: '' } },
      }
    );
    createdNewIndex = true;
  }

  const verifiedIndexes = (await collection.indexes()) as IndexInfo[];
  const readyTarget = verifiedIndexes.find(
    (idx) => idx.name === USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME
  );
  const verifiedNewIndexReady = Boolean(
    readyTarget && isExpectedUserVerificationPartialIndex(readyTarget)
  );
  if (!verifiedNewIndexReady) {
    throw new Error(
      `Verification failed: index "${USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME}" was not ready after creation.`
    );
  }

  const cleanupResult = await collection.updateMany(
    { emailVerificationTokenHash: { $type: 'string', $regex: /^\s*$/ } },
    { $set: { emailVerificationTokenHash: null } }
  );

  return {
    cleanedEmptyStringTokenCount: cleanupResult.modifiedCount ?? 0,
    duplicateTokenHashesCount: 0,
    createdNewIndex,
    verifiedNewIndexReady,
  };
}

/**
 * Safely populates missing security defaults on legacy User and Trip documents.
 * Deliberately sets `emailVerified: false` on legacy accounts (never auto-verifies
 * unverified pre-migration accounts) and sets `defaultInviteRole: 'PARTICIPANT'`.
 */
export async function backfillInviteSecurityDefaults(
  db: NonNullable<mongoose.Connection['db']> | undefined = mongoose.connection.db
): Promise<LegacyInviteDefaultsBackfillReport> {
  if (!db) {
    throw new Error('Database handle is required to backfill invite security defaults.');
  }

  const usersCol = db.collection('users');
  const tripsCol = db.collection('trips');

  const usersResult = await usersCol.updateMany(
    { emailVerified: { $nin: [true, false] } },
    { $set: { emailVerified: false, emailVerifiedAt: null } }
  );

  const tripsInviteEnabledResult = await tripsCol.updateMany(
    { inviteEnabled: { $exists: false } },
    { $set: { inviteEnabled: true } }
  );

  const tripsDefaultRoleResult = await tripsCol.updateMany(
    { defaultInviteRole: { $exists: false } },
    { $set: { defaultInviteRole: DEFAULT_OPEN_INVITE_ROLE } }
  );

  return {
    updatedUsersCount: usersResult.modifiedCount ?? 0,
    updatedTripsInviteEnabledCount: tripsInviteEnabledResult.modifiedCount ?? 0,
    updatedTripsDefaultRoleCount: tripsDefaultRoleResult.modifiedCount ?? 0,
  };
}

interface LegacyInviteMigrationCandidate {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  participantId?: mongoose.Types.ObjectId;
  intendedEmail?: string | null;
  familyId?: unknown;
  revokedAt?: unknown;
}

function describeRawValueType(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

async function ensureLegacyInviteMigrationAuditLog(params: {
  activityLogsCol: mongoose.mongo.Collection<mongoose.mongo.BSON.Document>;
  doc: LegacyInviteMigrationCandidate;
  createdAt: Date;
  session?: mongoose.ClientSession;
}): Promise<boolean> {
  const { activityLogsCol, doc, createdAt, session } = params;
  const existingLog = await activityLogsCol.findOne(
    {
      entityType: 'PARTICIPANT_INVITE',
      entityId: doc._id,
      actionType: 'PARTICIPANT_INVITE_REVOKED_MIGRATION',
    },
    {
      projection: { _id: 1 },
      ...(session ? { session } : {}),
    }
  );
  if (existingLog) {
    return false;
  }

  await activityLogsCol.insertOne(
    {
      tripId: doc.tripId,
      actorUserId: null,
      actorParticipantId: null,
      actorName: 'System Migration',
      actionType: 'PARTICIPANT_INVITE_REVOKED_MIGRATION',
      entityType: 'PARTICIPANT_INVITE',
      entityId: doc._id,
      summary:
        'System migration revoked a legacy pending FAMILY_REP invitation missing a valid familyId ObjectId binding.',
      metadata: {
        reason: 'MISSING_FAMILY_ID_LEGACY_INVITE',
        grantedRole: 'FAMILY_REP',
        participantId: doc.participantId ? doc.participantId.toString() : null,
        intendedEmail: doc.intendedEmail ?? null,
        rawFamilyIdType: describeRawValueType(doc.familyId),
      },
      createdAt,
    },
    session ? { session } : undefined
  );
  return true;
}

/**
 * Revokes legacy pending (unredeemed, unrevoked) `FAMILY_REP` invitations that lack a
 * valid non-null `ObjectId` `familyId` binding (covering `null`, absent, or malformed values).
 * Historical already-used or already-revoked invites are preserved untouched, and intended
 * family assignments are never guessed.
 *
 * - On replica sets (`supportsTransactions() === true` on the active Mongoose connection),
 *   revocation + `ActivityLog` insertion execute inside an atomic ACID transaction.
 * - On standalone MongoDB (or when recovering an interrupted standalone run), invites are
 *   revoked with `migrationAuditPending: true`, recovered on retry by idempotently backfilling
 *   the `PARTICIPANT_INVITE_REVOKED_MIGRATION` log if missing, and cleared via `$unset`.
 */
export async function migrateLegacyFamilyRepInvites(
  db: NonNullable<mongoose.Connection['db']> | undefined = mongoose.connection.db
): Promise<LegacyFamilyRepInviteMigrationReport> {
  if (!db) {
    throw new Error('Database handle is required to migrate legacy FAMILY_REP invites.');
  }

  const invitesCol = db.collection(ParticipantInviteModel.collection.collectionName);
  const activityLogsCol = db.collection(ActivityLogModel.collection.collectionName);

  const now = new Date();
  let recoveredAuditLogsCount = 0;

  // Step 1: Recover any interrupted standalone revocations awaiting migration audit logging.
  const pendingAuditDocs = await invitesCol
    .find<LegacyInviteMigrationCandidate>(
      {
        grantedRole: 'FAMILY_REP',
        usedAt: null,
        revokedAt: { $ne: null },
        migrationAuditPending: true,
      },
      {
        projection: {
          _id: 1,
          tripId: 1,
          participantId: 1,
          intendedEmail: 1,
          familyId: 1,
          revokedAt: 1,
        },
      }
    )
    .toArray();

  for (const pendingAuditDoc of pendingAuditDocs) {
    const inserted = await ensureLegacyInviteMigrationAuditLog({
      activityLogsCol,
      doc: pendingAuditDoc,
      createdAt:
        pendingAuditDoc.revokedAt instanceof Date ? pendingAuditDoc.revokedAt : now,
    });
    if (inserted) {
      recoveredAuditLogsCount += 1;
    }
    await invitesCol.updateOne(
      { _id: pendingAuditDoc._id, migrationAuditPending: true },
      { $unset: { migrationAuditPending: '' } }
    );
  }

  // Step 2: Revoke remaining pending invalid FAMILY_REP invites (missing, null, or malformed familyId).
  const pendingLegacyInvites = await invitesCol
    .find<LegacyInviteMigrationCandidate>(LEGACY_PENDING_FAMILY_REP_INVITE_FILTER, {
      projection: { _id: 1, tripId: 1, participantId: 1, intendedEmail: 1, familyId: 1 },
    })
    .toArray();

  const revokedInviteIds: string[] = [];
  const useTransaction = mongoose.connection.db === db && (await supportsTransactions());

  if (useTransaction) {
    for (const doc of pendingLegacyInvites) {
      let committedRevoke = false;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          committedRevoke = false;
          const updateRes = await invitesCol.updateOne(
            {
              _id: doc._id,
              ...LEGACY_PENDING_FAMILY_REP_INVITE_FILTER,
            },
            {
              $set: {
                revokedAt: now,
                updatedAt: now,
              },
            },
            { session }
          );

          if ((updateRes.modifiedCount ?? 0) === 1) {
            await ensureLegacyInviteMigrationAuditLog({
              activityLogsCol,
              doc,
              createdAt: now,
              session,
            });
            committedRevoke = true;
          }
        });
      } finally {
        await session.endSession();
      }
      if (committedRevoke) {
        revokedInviteIds.push(doc._id.toString());
      }
    }
  } else {
    for (const doc of pendingLegacyInvites) {
      const updateRes = await invitesCol.updateOne(
        {
          _id: doc._id,
          ...LEGACY_PENDING_FAMILY_REP_INVITE_FILTER,
        },
        {
          $set: {
            revokedAt: now,
            updatedAt: now,
            migrationAuditPending: true,
          },
        }
      );

      if ((updateRes.modifiedCount ?? 0) === 1) {
        revokedInviteIds.push(doc._id.toString());
        await ensureLegacyInviteMigrationAuditLog({
          activityLogsCol,
          doc,
          createdAt: now,
        });
        await invitesCol.updateOne(
          { _id: doc._id, migrationAuditPending: true },
          { $unset: { migrationAuditPending: '' } }
        );
      }
    }
  }

  return {
    scannedPendingCount: pendingLegacyInvites.length,
    revokedLegacyFamilyRepInvitesCount: revokedInviteIds.length,
    recoveredAuditLogsCount,
    revokedInviteIds,
  };
}

/**
 * Read-only audit helper surfacing historical pre-SEC-01 exposure:
 * counts unverified users, email-labeled guest slots, and any existing non-creator
 * privileged (`ORGANIZER` / `FAMILY_REP`) participants linked to unverified users.
 */
export async function auditParticipantLinkingRisks(
  db: NonNullable<mongoose.Connection['db']> | undefined = mongoose.connection.db
): Promise<ParticipantLinkingRiskAuditReport> {
  if (!db) {
    throw new Error('Database handle is required to audit participant linking risks.');
  }

  const usersCol = db.collection('users');
  const participantsCol = db.collection('participants');
  const invitesCol = db.collection(ParticipantInviteModel.collection.collectionName);
  const unlinkedFilter = {
    $or: [{ userId: null }, { userId: { $type: 'string', $regex: /^\s*$/ } }],
  };
  const nonBlankEmailFilter = {
    email: { $type: 'string', $regex: /\S/ },
  };

  const [
    unverifiedUsersCount,
    unlinkedGuestsWithEmailCount,
    unlinkedPrivilegedGuestsWithEmailCount,
    unlinkedPrivilegedGuestsCount,
    pendingLegacyFamilyRepInvitesMissingFamilyIdCount,
    pendingMigrationAuditLogsCount,
    anomalousLinks,
    participantIndexes,
    userIndexes,
    rateLimitIndexes,
    inviteIndexes,
  ] = await Promise.all([
    usersCol.countDocuments({ emailVerified: { $ne: true } }),
    participantsCol.countDocuments({
      $and: [unlinkedFilter, nonBlankEmailFilter],
    }),
    participantsCol.countDocuments({
      $and: [
        unlinkedFilter,
        nonBlankEmailFilter,
        { role: { $in: [...PRIVILEGED_TRIP_ROLES] } },
      ],
    }),
    participantsCol.countDocuments({
      $and: [unlinkedFilter, { role: { $in: [...PRIVILEGED_TRIP_ROLES] } }],
    }),
    invitesCol.countDocuments(LEGACY_PENDING_FAMILY_REP_INVITE_FILTER),
    invitesCol.countDocuments({
      grantedRole: 'FAMILY_REP',
      usedAt: null,
      revokedAt: { $ne: null },
      migrationAuditPending: true,
    }),
    participantsCol
      .aggregate<{
        _id: unknown;
        tripId: unknown;
        userId: unknown;
        role: string;
        email?: string | null;
        userEmailVerified: boolean;
      }>([
        {
          $match: {
            userId: { $type: 'objectId', $not: { $type: 'array' } },
            role: { $in: [...PRIVILEGED_TRIP_ROLES] },
          },
        },
        {
          $lookup: {
            from: 'trips',
            localField: 'tripId',
            foreignField: '_id',
            as: 'tripDocs',
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'userDocs',
          },
        },
        {
          $addFields: {
            tripCreatedBy: { $arrayElemAt: ['$tripDocs.createdBy', 0] },
            linkedUserVerified: {
              $eq: [{ $arrayElemAt: ['$userDocs.emailVerified', 0] }, true],
            },
          },
        },
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ['$userId', '$tripCreatedBy'] },
                { $eq: ['$linkedUserVerified', false] },
              ],
            },
          },
        },
        {
          $project: {
            tripId: 1,
            userId: 1,
            role: 1,
            email: 1,
            userEmailVerified: '$linkedUserVerified',
          },
        },
      ])
      .toArray(),
    listCollectionIndexesReadOnly(db, 'participants'),
    listCollectionIndexesReadOnly(db, 'users'),
    listCollectionIndexesReadOnly(db, 'rate_limit_buckets'),
    listCollectionIndexesReadOnly(db, ParticipantInviteModel.collection.collectionName),
  ]);

  const participantsTripUserPartialIndexPresent = participantIndexes.some((idx) =>
    isExpectedTargetPartialIndex(idx)
  );
  const usersVerificationTokenPartialIndexPresent = userIndexes.some((idx) =>
    isExpectedUserVerificationPartialIndex(idx)
  );
  const rateLimitBucketsIndexesPresent =
    rateLimitIndexes.some((idx) => idx.key?.key === 1 && idx.unique === true) &&
    rateLimitIndexes.some(
      (idx) => idx.key?.expiresAt === 1 && idx.expireAfterSeconds === 0
    );
  const participantInvitesIndexesPresent = areParticipantInviteIndexesPresent(inviteIndexes);

  return {
    unverifiedUsersCount,
    unlinkedGuestsWithEmailCount,
    unlinkedPrivilegedGuestsWithEmailCount,
    unlinkedPrivilegedGuestsCount,
    pendingLegacyFamilyRepInvitesMissingFamilyIdCount,
    pendingMigrationAuditLogsCount,
    nonCreatorUnverifiedPrivilegedLinks: anomalousLinks.map((entry) => ({
      tripId: String(entry.tripId),
      participantId: String(entry._id),
      userId: String(entry.userId),
      role: entry.role,
      email: entry.email ?? null,
      userEmailVerified: Boolean(entry.userEmailVerified),
    })),
    participantsTripUserPartialIndexPresent,
    usersVerificationTokenPartialIndexPresent,
    rateLimitBucketIndexesPresent: rateLimitBucketsIndexesPresent,
    participantInvitesIndexesPresent,
  };
}

export async function runParticipantMigrationCli(
  argv: string[] = process.argv.slice(2),
  uriOverride?: string
): Promise<
  | { mode: 'audit-only'; auditReport: ParticipantLinkingRiskAuditReport }
  | {
      mode: 'migrate';
      indexReport: ParticipantUserIndexMigrationReport;
      userVerificationIndexReport: UserVerificationTokenIndexMigrationReport;
      backfillReport: LegacyInviteDefaultsBackfillReport;
      legacyInviteMigrationReport: LegacyFamilyRepInviteMigrationReport;
      auditReport: ParticipantLinkingRiskAuditReport;
    }
> {
  const args = new Set(argv);
  // Disable Mongoose background autoIndex so --audit-only never performs index DDL
  // and migrations always complete audits prior to index creation.
  await connectDatabase(uriOverride, { autoIndex: false });
  try {
    if (args.has('--audit-only')) {
      const auditReport = await auditParticipantLinkingRisks();
      console.log('[TripLedger Migration] Read-only participant linking risk audit:', auditReport);
      return { mode: 'audit-only', auditReport };
    }

    const indexReport = await migrateParticipantUserIndex();
    const userVerificationIndexReport = await migrateUserVerificationTokenIndex();
    await ensureRateLimitIndexes();
    await ensureParticipantInviteIndexes();
    const backfillReport = await backfillInviteSecurityDefaults();
    const legacyInviteMigrationReport = await migrateLegacyFamilyRepInvites();
    const auditReport = await auditParticipantLinkingRisks();
    console.log('[TripLedger Migration] Participant user index migration complete:', {
      indexReport,
      userVerificationIndexReport,
      backfillReport,
      legacyInviteMigrationReport,
      auditReport,
    });
    return {
      mode: 'migrate',
      indexReport,
      userVerificationIndexReport,
      backfillReport,
      legacyInviteMigrationReport,
      auditReport,
    };
  } finally {
    await disconnectDatabase();
  }
}

const isCliEntry =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntry) {
  runParticipantMigrationCli().catch((err) => {
    console.error('[TripLedger Migration] Failed:', err);
    process.exit(1);
  });
}
