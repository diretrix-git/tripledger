import crypto from 'crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { ParticipantModel, TripModel, type IParticipant } from '../models/index.js';
import { AppError } from '../utils/http.js';
import { runAtomically, type AtomicResult } from './atomicWrite.js';

const DEFAULT_ORGANIZER_LOCK_TTL_MS = 5000;
const DEFAULT_ORGANIZER_LOCK_TIMEOUT_MS = 2500;
const ORGANIZER_LOCK_RETRY_BASE_MS = 15;
const ORGANIZER_LOCK_RETRY_JITTER_MS = 20;

/**
 * MongoDB filter matching participants who satisfy the active linked-organizer invariant:
 * active membership, ORGANIZER role, and a real linked User ObjectId (never null guests).
 */
export function activeLinkedOrganizerFilter(
  tripId: mongoose.Types.ObjectId,
  excludeParticipantId?: mongoose.Types.ObjectId
): mongoose.FilterQuery<IParticipant> {
  return {
    tripId,
    role: 'ORGANIZER',
    isActive: true,
    userId: { $type: 'objectId' },
    ...(excludeParticipantId ? { _id: { $ne: excludeParticipantId } } : {}),
  };
}

/**
 * Returns true only when `participant` is active, holds `ORGANIZER`, and is linked to a User ObjectId.
 */
export function isActiveLinkedOrganizer(
  participant: Pick<IParticipant, 'role' | 'isActive' | 'userId'>
): boolean {
  return (
    participant.role === 'ORGANIZER' &&
    participant.isActive === true &&
    participant.userId instanceof mongoose.Types.ObjectId
  );
}

export interface ParticipantUpdateSnapshot {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId | null | undefined;
  name: string;
  email: string | undefined;
  phone: string | undefined;
  role: IParticipant['role'];
  memberType: IParticipant['memberType'];
  defaultWeight: number;
  isActive: boolean;
  familyId: mongoose.Types.ObjectId | null | undefined;
}

export function captureParticipantUpdateSnapshot(
  participant: IParticipant
): ParticipantUpdateSnapshot {
  return {
    _id: participant._id,
    userId: participant.userId,
    name: participant.name,
    email: participant.email,
    phone: participant.phone,
    role: participant.role,
    memberType: participant.memberType,
    defaultWeight: participant.defaultWeight,
    isActive: participant.isActive,
    familyId: participant.familyId,
  };
}

export function buildParticipantUpdateRestoreOp(snapshot: ParticipantUpdateSnapshot) {
  const $set: Record<string, unknown> = {
    userId: snapshot.userId ?? null,
    name: snapshot.name,
    role: snapshot.role,
    memberType: snapshot.memberType,
    defaultWeight: snapshot.defaultWeight,
    isActive: snapshot.isActive,
    familyId: snapshot.familyId ?? null,
  };
  const $unset: Record<string, 1> = {};
  if (snapshot.email !== undefined) {
    $set.email = snapshot.email;
  } else {
    $unset.email = 1;
  }
  if (snapshot.phone !== undefined) {
    $set.phone = snapshot.phone;
  } else {
    $unset.phone = 1;
  }
  return Object.keys($unset).length > 0 ? { $set, $unset } : { $set };
}

export async function assertFreshActiveOrganizerActor(
  tripId: mongoose.Types.ObjectId,
  actorParticipantId: mongoose.Types.ObjectId,
  session: ClientSession | null
): Promise<IParticipant> {
  const freshActor = await ParticipantModel.findOne({
    _id: actorParticipantId,
    tripId,
  }).session(session);

  if (!freshActor || !freshActor.isActive) {
    throw new AppError('You do not have access to this trip.', 403, 'FORBIDDEN_TRIP_ACCESS');
  }
  if (freshActor.role !== 'ORGANIZER') {
    throw new AppError(
      `Insufficient permissions. Required role: ORGANIZER. Your role: ${freshActor.role}.`,
      403,
      'INSUFFICIENT_ROLE'
    );
  }
  return freshActor;
}

/**
 * Counts active linked organizers in `tripId`, optionally excluding one participant and binding to `session`.
 */
export async function countActiveLinkedOrganizers(
  tripId: mongoose.Types.ObjectId,
  options: {
    excludeParticipantId?: mongoose.Types.ObjectId;
    session?: ClientSession | null;
  } = {}
): Promise<number> {
  return ParticipantModel.countDocuments(
    activeLinkedOrganizerFilter(tripId, options.excludeParticipantId)
  ).session(options.session ?? null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStandaloneOrganizerLease(
  tripId: mongoose.Types.ObjectId,
  leaseTtlMs: number,
  acquireTimeoutMs: number
): Promise<string> {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + acquireTimeoutMs;

  while (true) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseTtlMs);

    const acquired = await TripModel.findOneAndUpdate(
      {
        _id: tripId,
        $or: [
          { 'organizerMutationLock.owner': null },
          { 'organizerMutationLock.owner': { $exists: false } },
          { 'organizerMutationLock.expiresAt': { $lte: now } },
          { 'organizerMutationLock.expiresAt': null },
        ],
      },
      {
        $set: {
          organizerMutationLock: { owner, expiresAt },
        },
        $inc: { organizerLockVersion: 1 },
      },
      { new: true }
    );

    if (acquired) {
      return owner;
    }

    const tripExists = await TripModel.exists({ _id: tripId });
    if (!tripExists) {
      throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
    }

    if (Date.now() >= deadline) {
      throw new AppError(
        'Another organizer update is currently in progress. Please retry.',
        409,
        'CONCURRENT_MODIFICATION'
      );
    }

    const backoffMs =
      ORGANIZER_LOCK_RETRY_BASE_MS + Math.floor(Math.random() * ORGANIZER_LOCK_RETRY_JITTER_MS);
    await sleep(backoffMs);
  }
}

async function releaseStandaloneOrganizerLease(
  tripId: mongoose.Types.ObjectId,
  owner: string
): Promise<void> {
  try {
    await TripModel.updateOne(
      {
        _id: tripId,
        'organizerMutationLock.owner': owner,
      },
      {
        $set: {
          'organizerMutationLock.owner': null,
          'organizerMutationLock.expiresAt': null,
        },
      }
    );
  } catch (err) {
    console.error('[tripledger] Failed to release standalone organizer mutation lock:', err);
  }
}

export interface RunSerializedTripOrganizerMutationOptions {
  tripId: mongoose.Types.ObjectId;
  work: (session: ClientSession | null) => Promise<void>;
  rollback: () => Promise<void>;
  leaseTtlMs?: number;
  acquireTimeoutMs?: number;
}

/**
 * Serializes participant role/membership mutations per Trip across multiple server instances:
 * - Replica set / mongos (`session !== null`): mutates `Trip.organizerLockVersion` inside the ACID
 *   transaction so WiredTiger forces WriteConflict/TransientTransactionError retries across concurrent
 *   updates to distinct Participant documents (preventing snapshot-isolation write skew).
 * - Standalone MongoDB (`session === null`, non-production only): acquires a short-TTL distributed lease on
 *   `Trip.organizerMutationLock` in MongoDB, keeps the lease held until any compensating `rollback()`
 *   completes, and fails closed on lease timeout (`409 CONCURRENT_MODIFICATION`). Production always fails
 *   closed with `503 TRANSACTIONS_UNAVAILABLE` via `runAtomically`.
 */
export async function runSerializedTripOrganizerMutation({
  tripId,
  work,
  rollback,
  leaseTtlMs = DEFAULT_ORGANIZER_LOCK_TTL_MS,
  acquireTimeoutMs = DEFAULT_ORGANIZER_LOCK_TIMEOUT_MS,
}: RunSerializedTripOrganizerMutationOptions): Promise<AtomicResult> {
  let standaloneLockOwner: string | null = null;

  try {
    return await runAtomically(
      async (session) => {
        if (session !== null) {
          const lockedTrip = await TripModel.findOneAndUpdate(
            { _id: tripId },
            { $inc: { organizerLockVersion: 1 } },
            { session, new: true }
          );
          if (!lockedTrip) {
            throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
          }
        } else {
          if (!standaloneLockOwner) {
            standaloneLockOwner = await acquireStandaloneOrganizerLease(
              tripId,
              leaseTtlMs,
              acquireTimeoutMs
            );
          }
        }

        await work(session);
      },
      rollback
    );
  } finally {
    if (standaloneLockOwner) {
      await releaseStandaloneOrganizerLease(tripId, standaloneLockOwner);
    }
  }
}
