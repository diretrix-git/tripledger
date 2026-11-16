import mongoose, { type ClientSession } from 'mongoose';
import {
  FamilyModel,
  ParticipantInviteModel,
  ParticipantModel,
  type IFamily,
  type IParticipant,
  type ITrip,
} from '../models/index.js';
import { AppError } from '../utils/http.js';
import {
  buildParticipantUpdateRestoreOp,
  captureParticipantUpdateSnapshot,
  type ParticipantUpdateSnapshot,
} from './organizerInvariant.js';

export function sameObjectId(
  a: mongoose.Types.ObjectId | null | undefined,
  b: mongoose.Types.ObjectId | null | undefined
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.equals(b);
}

export interface FamilyUpdateSnapshot {
  _id: mongoose.Types.ObjectId;
  name: string;
  representativeId: mongoose.Types.ObjectId | null | undefined;
  defaultWeight: number;
  notes: string | undefined;
  expectedUpdatedAt?: Date;
}

export function captureFamilySnapshot(family: IFamily): FamilyUpdateSnapshot {
  return {
    _id: family._id,
    name: family.name,
    representativeId: family.representativeId ?? null,
    defaultWeight: family.defaultWeight,
    notes: family.notes,
  };
}

export function buildFamilyRestoreOp(snapshot: FamilyUpdateSnapshot) {
  const $set: Record<string, unknown> = {
    name: snapshot.name,
    representativeId: snapshot.representativeId ?? null,
    defaultWeight: snapshot.defaultWeight,
  };
  const $unset: Record<string, 1> = {};
  if (snapshot.notes !== undefined) {
    $set.notes = snapshot.notes;
  } else {
    $unset.notes = 1;
  }
  return Object.keys($unset).length > 0 ? { $set, $unset } : { $set };
}

export async function restoreFamilySnapshots(
  snapshots: readonly FamilyUpdateSnapshot[]
): Promise<void> {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i]!;
    await FamilyModel.updateOne(
      {
        _id: snap._id,
        ...(snap.expectedUpdatedAt ? { updatedAt: snap.expectedUpdatedAt } : {}),
      },
      buildFamilyRestoreOp(snap)
    );
  }
}

export async function restoreParticipantSnapshots(
  snapshots: readonly ParticipantUpdateSnapshot[]
): Promise<void> {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i]!;
    await ParticipantModel.updateOne(
      {
        _id: snap._id,
        ...(snap.expectedUpdatedAt ? { updatedAt: snap.expectedUpdatedAt } : {}),
      },
      buildParticipantUpdateRestoreOp(snap)
    );
  }
}

export interface RevokedInviteRollbackRecord {
  inviteIds: mongoose.Types.ObjectId[];
  revokedAt: Date;
}

export async function restoreRevokedInviteRecords(
  records: readonly RevokedInviteRollbackRecord[]
): Promise<void> {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]!;
    if (rec.inviteIds.length === 0) continue;
    await ParticipantInviteModel.collection.updateMany(
      {
        _id: { $in: rec.inviteIds },
        revokedAt: rec.revokedAt,
        usedAt: null,
      },
      {
        $set: {
          revokedAt: null,
          revokedByParticipantId: null,
        },
      }
    );
  }
}

export function collectParticipantSnapshots(
  docs: readonly IParticipant[]
): ParticipantUpdateSnapshot[] {
  return docs.map(captureParticipantUpdateSnapshot);
}

export async function assertValidFamilyInTrip(
  tripId: mongoose.Types.ObjectId,
  familyId: string,
  session: ClientSession | null = null
): Promise<IFamily> {
  if (!mongoose.Types.ObjectId.isValid(familyId)) {
    throw new AppError('Invalid family identifier format.', 400, 'INVALID_ID');
  }
  const family = await FamilyModel.findOne({ _id: familyId, tripId }).session(session);
  if (!family) {
    throw new AppError(
      'Specified family group does not exist in this trip.',
      404,
      'FAMILY_NOT_FOUND'
    );
  }
  return family;
}

export async function assertActiveRepresentativeCandidateInTrip(
  tripId: mongoose.Types.ObjectId,
  participantId: string,
  session: ClientSession | null = null
): Promise<IParticipant> {
  if (!mongoose.Types.ObjectId.isValid(participantId)) {
    throw new AppError('Invalid representative participant identifier format.', 400, 'INVALID_ID');
  }
  const participant = await ParticipantModel.findOne({
    _id: participantId,
    tripId,
  }).session(session);
  if (!participant) {
    throw new AppError(
      'Specified representative participant does not belong to this trip.',
      404,
      'PARTICIPANT_NOT_FOUND'
    );
  }
  if (!participant.isActive) {
    throw new AppError(
      'Inactive participants cannot be assigned as a family representative.',
      400,
      'PARTICIPANT_INACTIVE'
    );
  }
  return participant;
}

/**
 * Ensures assigning `participant` as `representativeId` on `targetFamilyId` (or a newly
 * created family when `targetFamilyId` is undefined) will not steal an active representative
 * from another family or introduce cross-family `FAMILY_REP` ambiguity.
 */
export async function assertParticipantEligibleAsFamilyRepresentative(params: {
  trip: ITrip;
  participant: IParticipant;
  targetFamilyId?: mongoose.Types.ObjectId;
  session: ClientSession | null;
}): Promise<void> {
  const { trip, participant, targetFamilyId, session } = params;
  if (trip.mode !== 'FAMILY') {
    throw new AppError(
      'Family groups and representatives are only supported in Family Mode trips.',
      400,
      'FAMILY_MODE_ONLY'
    );
  }
  if (!participant.isActive) {
    throw new AppError(
      'Inactive participants cannot be assigned as a family representative.',
      400,
      'PARTICIPANT_INACTIVE'
    );
  }

  const otherDesignatedFamily = await FamilyModel.findOne({
    tripId: trip._id,
    representativeId: participant._id,
    ...(targetFamilyId ? { _id: { $ne: targetFamilyId } } : {}),
  }).session(session);
  if (otherDesignatedFamily) {
    throw new AppError(
      'This participant is already the designated representative of another family group. Unassign them from the existing family first.',
      409,
      'PARTICIPANT_ALREADY_FAMILY_REP'
    );
  }

  if (
    participant.role === 'FAMILY_REP' &&
    (!participant.familyId || !targetFamilyId || !participant.familyId.equals(targetFamilyId))
  ) {
    throw new AppError(
      !participant.familyId
        ? 'Participant holds a legacy FAMILY_REP role without a family assignment and cannot be assigned directly. Demote them to PARTICIPANT first.'
        : 'Participant currently holds FAMILY_REP role in another family. Demote or move them from their current family first.',
      409,
      'PARTICIPANT_FAMILY_REP_CONFLICT'
    );
  }
}

/**
 * Enforces `FAMILY_REP` invitation issuance and claim preconditions:
 * - Trip must be `FAMILY` mode.
 * - Target participant must be active and assigned to a valid `Family` in the same trip.
 * - Target family must not already have a different designated representative or another active `FAMILY_REP`.
 */
export async function assertParticipantEligibleForFamilyRepInvite(params: {
  trip: ITrip;
  participant: IParticipant;
  session: ClientSession | null;
  expectedFamilyId?: mongoose.Types.ObjectId | null;
  requireExpectedFamilyId?: boolean;
}): Promise<IFamily> {
  const { trip, participant, session, expectedFamilyId, requireExpectedFamilyId } = params;

  if (trip.mode !== 'FAMILY') {
    throw new AppError(
      'FAMILY_REP invitations are only supported in Family Mode trips.',
      400,
      'FAMILY_MODE_ONLY'
    );
  }
  if (!participant.isActive) {
    throw new AppError(
      'Cannot issue or redeem a FAMILY_REP invitation for an inactive participant.',
      400,
      'PARTICIPANT_INACTIVE'
    );
  }
  if (!participant.familyId) {
    throw new AppError(
      'Participant must belong to a family group before holding or being invited to FAMILY_REP.',
      400,
      'FAMILY_REQUIRED_FOR_REP'
    );
  }

  if (
    requireExpectedFamilyId &&
    (!expectedFamilyId || !expectedFamilyId.equals(participant.familyId))
  ) {
    throw new AppError(
      !expectedFamilyId
        ? 'This FAMILY_REP invitation is missing a bound family group and is no longer valid.'
        : 'This FAMILY_REP invitation was issued for a different family group and is no longer valid.',
      409,
      'INVITE_FAMILY_MISMATCH'
    );
  }

  const family = await FamilyModel.findOne({
    _id: participant.familyId,
    tripId: trip._id,
  }).session(session);
  if (!family) {
    throw new AppError(
      'Participant family group no longer exists in this trip.',
      404,
      'FAMILY_NOT_FOUND'
    );
  }

  if (family.representativeId && !family.representativeId.equals(participant._id)) {
    throw new AppError(
      'This family group already has a designated representative. Unassign or replace the current representative first.',
      409,
      'FAMILY_ALREADY_HAS_REPRESENTATIVE'
    );
  }

  const conflictingActiveRep = await ParticipantModel.findOne({
    tripId: trip._id,
    familyId: family._id,
    _id: { $ne: participant._id },
    role: 'FAMILY_REP',
    isActive: true,
  }).session(session);
  if (conflictingActiveRep) {
    throw new AppError(
      'This family group already has an active FAMILY_REP participant.',
      409,
      'FAMILY_ALREADY_HAS_REPRESENTATIVE'
    );
  }

  return family;
}

export async function revokePendingParticipantInvites(params: {
  tripId: mongoose.Types.ObjectId;
  participantIds: readonly mongoose.Types.ObjectId[];
  actorParticipantId: mongoose.Types.ObjectId;
  grantedRole?: 'FAMILY_REP';
  session: ClientSession | null;
}): Promise<RevokedInviteRollbackRecord | null> {
  if (params.participantIds.length === 0) return null;

  const pendingDocs = await ParticipantInviteModel.find({
    tripId: params.tripId,
    participantId: { $in: params.participantIds },
    ...(params.grantedRole ? { grantedRole: params.grantedRole } : {}),
    usedAt: null,
    revokedAt: null,
  })
    .select('_id')
    .session(params.session)
    .lean();

  if (pendingDocs.length === 0) {
    return null;
  }

  const inviteIds = pendingDocs.map((doc) => doc._id);
  const revokedAt = new Date();

  await ParticipantInviteModel.updateMany(
    {
      _id: { $in: inviteIds },
      usedAt: null,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt,
        revokedByParticipantId: params.actorParticipantId,
      },
    },
    params.session ? { session: params.session } : undefined
  );

  return { inviteIds, revokedAt };
}
