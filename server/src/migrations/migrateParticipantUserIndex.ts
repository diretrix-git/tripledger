import path from 'path';
import { pathToFileURL } from 'url';
import mongoose from 'mongoose';
import { DEFAULT_OPEN_INVITE_ROLE, PRIVILEGED_TRIP_ROLES } from '@tripledger/shared';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import {
  PARTICIPANT_TRIP_USER_INDEX_NAME,
  ParticipantModel,
} from '../models/Participant.js';

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

export interface LegacyInviteDefaultsBackfillReport {
  updatedUsersCount: number;
  updatedTripsInviteEnabledCount: number;
  updatedTripsDefaultRoleCount: number;
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
  nonCreatorUnverifiedPrivilegedLinks: HistoricalPrivilegedLinkRiskEntry[];
}

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
    anomalousLinks,
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
  ]);

  return {
    unverifiedUsersCount,
    unlinkedGuestsWithEmailCount,
    unlinkedPrivilegedGuestsWithEmailCount,
    nonCreatorUnverifiedPrivilegedLinks: anomalousLinks.map((entry) => ({
      tripId: String(entry.tripId),
      participantId: String(entry._id),
      userId: String(entry.userId),
      role: entry.role,
      email: entry.email ?? null,
      userEmailVerified: Boolean(entry.userEmailVerified),
    })),
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
      backfillReport: LegacyInviteDefaultsBackfillReport;
      auditReport: ParticipantLinkingRiskAuditReport;
    }
> {
  const args = new Set(argv);
  // Disable Mongoose background autoIndex so --audit-only never performs index DDL
  // and migrateParticipantUserIndex always completes audits prior to index creation.
  await connectDatabase(uriOverride, { autoIndex: false });
  try {
    if (args.has('--audit-only')) {
      const auditReport = await auditParticipantLinkingRisks();
      console.log('[TripLedger Migration] Read-only participant linking risk audit:', auditReport);
      return { mode: 'audit-only', auditReport };
    }

    const indexReport = await migrateParticipantUserIndex();
    const backfillReport = await backfillInviteSecurityDefaults();
    const auditReport = await auditParticipantLinkingRisks();
    console.log('[TripLedger Migration] Participant user index migration complete:', {
      indexReport,
      backfillReport,
      auditReport,
    });
    return { mode: 'migrate', indexReport, backfillReport, auditReport };
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
