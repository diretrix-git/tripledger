import path from 'path';
import { pathToFileURL } from 'url';
import type mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { EXPENSE_MUTATION_ID_INDEX_NAME, ExpenseModel } from '../models/Expense.js';

export interface DuplicateMutationKeyAuditEntry {
  tripId: string;
  clientMutationId: string;
  count: number;
  expenseIds: string[];
}

export interface ExpenseMutationIndexMigrationReport {
  cleanedEmptyOrNullCount: number;
  duplicatePairs: DuplicateMutationKeyAuditEntry[];
  createdNewIndex: boolean;
  verifiedNewIndexReady: boolean;
  droppedLegacyIndexNames: string[];
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

function isSamePartialFilter(expr: unknown): boolean {
  if (!isPlainRecord(expr)) return false;
  const topKeys = Object.keys(expr);
  if (topKeys.length !== 1 || topKeys[0] !== 'clientMutationId') {
    return false;
  }
  const field = expr.clientMutationId;
  if (!isPlainRecord(field)) return false;
  const fieldKeys = Object.keys(field);
  return (
    fieldKeys.length === 2 &&
    fieldKeys.includes('$type') &&
    fieldKeys.includes('$gt') &&
    field.$type === 'string' &&
    field.$gt === ''
  );
}

function isTripClientMutationKey(key: Record<string, unknown> | undefined): boolean {
  if (!key) return false;
  const entries = Object.entries(key);
  return (
    entries.length === 2 &&
    entries[0][0] === 'tripId' &&
    entries[0][1] === 1 &&
    entries[1][0] === 'clientMutationId' &&
    entries[1][1] === 1
  );
}

function isExpectedTargetPartialIndex(idx: IndexInfo): boolean {
  return (
    idx.name === EXPENSE_MUTATION_ID_INDEX_NAME &&
    idx.unique === true &&
    idx.sparse !== true &&
    isTripClientMutationKey(idx.key) &&
    isSamePartialFilter(idx.partialFilterExpression) &&
    idx.expireAfterSeconds === undefined &&
    idx.collation === undefined
  );
}

function isExpectedLegacySparseIndex(idx: IndexInfo): boolean {
  return (
    idx.name === 'tripId_1_clientMutationId_1' &&
    idx.unique === true &&
    idx.sparse === true &&
    isTripClientMutationKey(idx.key) &&
    idx.partialFilterExpression === undefined &&
    idx.expireAfterSeconds === undefined &&
    idx.collation === undefined
  );
}

/**
 * Safely migrates the `expenses` collection from the legacy compound sparse index
 * (`tripId_1_clientMutationId_1`) to the explicit partial unique index
 * (`tripId_1_clientMutationId_partial_unique`).
 *
 * Properties:
 * - Idempotent / repeatable: safe to run multiple times.
 * - Preserves all unrelated indexes (never calls unrestricted `syncIndexes()`).
 * - Cleans `null` and `""` `clientMutationId` values via `$unset`.
 * - Audits non-empty duplicate `(tripId, clientMutationId)` pairs and aborts before changing indexes.
 * - Creates and verifies readiness of the new partial unique index before dropping the legacy index.
 */
export async function migrateExpenseMutationIndex(
  collection: mongoose.Collection = ExpenseModel.collection
): Promise<ExpenseMutationIndexMigrationReport> {
  // Ensure the collection exists so index inspection and updates succeed on fresh DBs too.
  const db = collection.conn.db;
  if (db) {
    const existingCollections = await db
      .listCollections({ name: collection.collectionName }, { nameOnly: true })
      .toArray();
    if (existingCollections.length === 0) {
      await db.createCollection(collection.collectionName);
    }
  }

  // Step 1: Audit non-empty duplicate (tripId, clientMutationId) pairs BEFORE mutating any
  // documents or indexes so problems abort safely with full diagnostics.
  const duplicateDocs = await collection
    .aggregate<{
      _id: { tripId: unknown; clientMutationId: string };
      count: number;
      expenseIds: unknown[];
    }>([
      { $match: { clientMutationId: { $type: 'string', $gt: '' } } },
      {
        $group: {
          _id: { tripId: '$tripId', clientMutationId: '$clientMutationId' },
          count: { $sum: 1 },
          expenseIds: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  const duplicatePairs: DuplicateMutationKeyAuditEntry[] = duplicateDocs.map((d) => ({
    tripId: String(d._id.tripId),
    clientMutationId: d._id.clientMutationId,
    count: d.count,
    expenseIds: d.expenseIds.map((id) => String(id)),
  }));

  if (duplicatePairs.length > 0) {
    throw new Error(
      `Cannot build ${EXPENSE_MUTATION_ID_INDEX_NAME}: found ${duplicatePairs.length} duplicate (tripId, clientMutationId) pair(s): ${JSON.stringify(duplicatePairs)}`
    );
  }

  // Step 2: Inspect current indexes selectively (never drop unrelated or unfamiliar indexes).
  const beforeIndexes = (await collection.indexes()) as IndexInfo[];
  const existingTarget = beforeIndexes.find((idx) => idx.name === EXPENSE_MUTATION_ID_INDEX_NAME);

  if (existingTarget && !isExpectedTargetPartialIndex(existingTarget)) {
    throw new Error(
      `Existing index "${EXPENSE_MUTATION_ID_INDEX_NAME}" has unexpected options and was not overwritten automatically: ${JSON.stringify(
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

  // Abort with clear diagnostics if a manual non-sparse or otherwise unfamiliar index exists
  // on { tripId: 1, clientMutationId: 1 } rather than dropping it automatically.
  const unfamiliarCompoundIndexes = beforeIndexes.filter(
    (idx) =>
      idx.name !== EXPENSE_MUTATION_ID_INDEX_NAME &&
      isTripClientMutationKey(idx.key) &&
      !isExpectedLegacySparseIndex(idx)
  );
  if (unfamiliarCompoundIndexes.length > 0) {
    throw new Error(
      `Cannot migrate ${EXPENSE_MUTATION_ID_INDEX_NAME}: found ${unfamiliarCompoundIndexes.length} unfamiliar index(es) on (tripId, clientMutationId) requiring manual inspection and intervention: ${JSON.stringify(
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
    // Build the new partial unique index alongside any existing legacy index so uniqueness
    // protection has zero unprotected gap.
    await collection.createIndex(
      { tripId: 1, clientMutationId: 1 },
      {
        name: EXPENSE_MUTATION_ID_INDEX_NAME,
        unique: true,
        partialFilterExpression: { clientMutationId: { $type: 'string', $gt: '' } },
      }
    );
    createdNewIndex = true;
  }

  // Step 3: Explicitly verify the new index is ready before dropping the legacy sparse index.
  const verifiedIndexes = (await collection.indexes()) as IndexInfo[];
  const readyTarget = verifiedIndexes.find((idx) => idx.name === EXPENSE_MUTATION_ID_INDEX_NAME);
  const verifiedNewIndexReady = Boolean(readyTarget && isExpectedTargetPartialIndex(readyTarget));

  if (!verifiedNewIndexReady) {
    throw new Error(
      `Verification failed: index "${EXPENSE_MUTATION_ID_INDEX_NAME}" was not ready after creation.`
    );
  }

  // Step 4: Drop ONLY the known legacy Mongoose compound sparse unique index
  // (`tripId_1_clientMutationId_1`). This happens before $unset cleanup because MongoDB
  // compound sparse indexes still index { tripId, clientMutationId: null }, causing $unset
  // on legacy "" / whitespace values to collide with existing null/absent rows.
  const droppedLegacyIndexNames: string[] = [];
  for (const idx of verifiedIndexes) {
    if (isExpectedLegacySparseIndex(idx) && idx.name) {
      await collection.dropIndex(idx.name);
      droppedLegacyIndexNames.push(idx.name);
    }
  }

  // Step 5: Remove legacy null / empty / whitespace-only clientMutationId fields cleanly now
  // that only the partial unique index governs { tripId, clientMutationId }.
  const cleanupResult = await collection.updateMany(
    {
      $or: [
        { clientMutationId: null },
        { clientMutationId: '' },
        { clientMutationId: { $type: 'string', $regex: /^\s+$/ } },
      ],
    },
    { $unset: { clientMutationId: '' } }
  );
  const cleanedEmptyOrNullCount = cleanupResult.modifiedCount ?? 0;

  return {
    cleanedEmptyOrNullCount,
    duplicatePairs,
    createdNewIndex,
    verifiedNewIndexReady,
    droppedLegacyIndexNames,
  };
}

async function main() {
  await connectDatabase();
  try {
    const report = await migrateExpenseMutationIndex();
    console.log('[TripLedger Migration] Expense clientMutationId index migration complete:', report);
  } finally {
    await disconnectDatabase();
  }
}

const isCliEntry =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliEntry) {
  main().catch((err) => {
    console.error('[TripLedger Migration] Failed:', err);
    process.exit(1);
  });
}
