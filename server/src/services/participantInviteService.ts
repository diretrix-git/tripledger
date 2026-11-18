import mongoose from 'mongoose';
import {
  claimParticipantInviteSchema,
  createParticipantInviteSchema,
  isPrivilegedTripRole,
  resolveParticipantInvitePolicy,
  type CreateParticipantInviteResponse,
  type ParticipantInviteEntity,
  type PendingParticipantInviteEntity,
} from '@tripledger/shared';
import { env } from '../config/env.js';
import {
  ActivityLogModel,
  FamilyModel,
  ParticipantInviteModel,
  ParticipantModel,
  TripModel,
  UserModel,
  type IParticipant,
  type IParticipantInvite,
  type ITrip,
} from '../models/index.js';
import { formatParticipantDoc, formatTripDoc } from '../controllers/tripController.js';
import { AppError } from '../utils/http.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { generateParticipantInviteToken, hashToken } from '../utils/tokens.js';
import {
  buildParticipantInviteUrl,
  defaultEmailDeliveryService,
  type EmailDeliveryService,
} from './emailService.js';
import { logTripActivity } from './ledgerService.js';
import {
  assertParticipantEligibleForFamilyRepInvite,
  captureFamilySnapshot,
  restoreFamilySnapshots,
  restoreRevokedInviteRecords,
  revokePendingParticipantInvites,
  type FamilyUpdateSnapshot,
  type RevokedInviteRollbackRecord,
} from './familyInvariant.js';
import {
  assertFreshActiveOrganizerActor,
  buildParticipantUpdateRestoreOp,
  captureParticipantUpdateSnapshot,
  countActiveLinkedOrganizers,
  isActiveLinkedOrganizer,
  runSerializedTripOrganizerMutation,
  type ParticipantUpdateSnapshot,
} from './organizerInvariant.js';

export function formatParticipantInvite(invite: IParticipantInvite): ParticipantInviteEntity {
  return {
    id: invite._id.toString(),
    tripId: invite.tripId.toString(),
    participantId: invite.participantId.toString(),
    intendedEmail: invite.intendedEmail ?? null,
    grantedRole: invite.grantedRole,
    requireVerifiedEmail: Boolean(invite.requireVerifiedEmail),
    expiresAt: invite.expiresAt.toISOString(),
    usedAt: invite.usedAt ? invite.usedAt.toISOString() : null,
    revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null,
    createdAt: invite.createdAt.toISOString(),
  };
}

export async function issueParticipantInvite(params: {
  trip: ITrip;
  actorUserId?: string;
  actorParticipant: IParticipant;
  targetParticipantId: string;
  body: unknown;
  emailDeliveryService?: EmailDeliveryService;
}): Promise<CreateParticipantInviteResponse> {
  const { trip, actorUserId, actorParticipant, targetParticipantId } = params;
  const parsed = createParticipantInviteSchema.parse(params.body);

  if (!mongoose.Types.ObjectId.isValid(targetParticipantId)) {
    throw new AppError('Invalid participant identifier format.', 400, 'INVALID_ID');
  }

  if (trip.status === 'CLOSED') {
    throw new AppError(
      'Cannot issue participant invitations for a closed trip.',
      403,
      'TRIP_CLOSED'
    );
  }

  const policy = resolveParticipantInvitePolicy({
    role: parsed.grantedRole,
    intendedEmail: parsed.intendedEmail,
  });

  const { rawToken, tokenHash, expiresAt } = generateParticipantInviteToken(parsed.expiresInHours);
  let claimUrl: string;
  try {
    claimUrl = buildParticipantInviteUrl(env.CLIENT_URL, rawToken, env.NODE_ENV);
  } catch {
    throw new AppError(
      'Invitation link configuration is invalid.',
      503,
      'EMAIL_DELIVERY_FAILED'
    );
  }

  const emailService = params.emailDeliveryService ?? defaultEmailDeliveryService;

  const txState: {
    invite?: IParticipantInvite;
    targetParticipant?: IParticipant;
    freshActor?: IParticipant;
    revokedInvites: RevokedInviteRollbackRecord[];
    activityLogId?: mongoose.Types.ObjectId;
  } = {
    revokedInvites: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.invite = undefined;
      txState.targetParticipant = undefined;
      txState.freshActor = undefined;
      txState.revokedInvites = [];
      txState.activityLogId = undefined;

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actorParticipant._id, session);

      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (liveTrip.status === 'CLOSED') {
        throw new AppError(
          'Cannot issue participant invitations for a closed trip.',
          403,
          'TRIP_CLOSED'
        );
      }

      const targetParticipant = await ParticipantModel.findOne({
        _id: targetParticipantId,
        tripId: trip._id,
      }).session(session);
      if (!targetParticipant) {
        throw new AppError('Participant not found in this trip.', 404, 'PARTICIPANT_NOT_FOUND');
      }
      if (!targetParticipant.isActive) {
        throw new AppError(
          'Cannot issue an invitation for a deactivated participant.',
          400,
          'PARTICIPANT_INACTIVE'
        );
      }

      if (targetParticipant.userId) {
        const linkedUser = await UserModel.findById(targetParticipant.userId)
          .select('email')
          .session(session);
        if (!linkedUser) {
          throw new AppError('Linked user account not found.', 404, 'USER_NOT_FOUND');
        }
        if (!policy.intendedEmail) {
          throw new AppError(
            'Email-less claim links cannot be issued for already-linked participants.',
            409,
            'PARTICIPANT_ALREADY_LINKED'
          );
        }
        if (policy.intendedEmail !== linkedUser.email.trim().toLowerCase()) {
          throw new AppError(
            'Cannot invite a different email address for an already-linked participant slot.',
            409,
            'PARTICIPANT_ALREADY_LINKED'
          );
        }
      } else if (policy.intendedEmail) {
        const existingAccount = await UserModel.findOne({ email: policy.intendedEmail })
          .select('_id')
          .session(session);
        if (existingAccount) {
          const conflictingMembership = await ParticipantModel.findOne({
            tripId: trip._id,
            userId: existingAccount._id,
            _id: { $ne: targetParticipant._id },
          }).session(session);
          if (conflictingMembership) {
            throw new AppError(
              'That user is already a participant in this trip; promote their existing participant record instead.',
              409,
              'ALREADY_TRIP_MEMBER'
            );
          }
        }
      }

      let boundFamilyId: mongoose.Types.ObjectId | null = null;
      if (parsed.grantedRole === 'FAMILY_REP') {
        const eligibleFamily = await assertParticipantEligibleForFamilyRepInvite({
          trip: liveTrip,
          participant: targetParticipant,
          session,
        });
        if (!eligibleFamily?._id) {
          throw new AppError(
            'FAMILY_REP invitation requires a valid non-null familyId.',
            400,
            'FAMILY_REQUIRED_FOR_REP'
          );
        }
        boundFamilyId = eligibleFamily._id;
      }

      // Supersede any prior pending unredeemed invitations for the same participant slot
      // so stale or duplicate pending links/roles cannot remain active simultaneously.
      const revokedPrior = await revokePendingParticipantInvites({
        tripId: trip._id,
        participantIds: [targetParticipant._id],
        actorParticipantId: freshActor._id,
        session,
      });
      if (revokedPrior) {
        txState.revokedInvites.push(revokedPrior);
      }

      const inviterObjectId =
        actorUserId && mongoose.Types.ObjectId.isValid(actorUserId)
          ? new mongoose.Types.ObjectId(actorUserId)
          : freshActor.userId;
      if (!inviterObjectId) {
        throw new AppError('Inviter account linkage required.', 403, 'FORBIDDEN_TRIP_ACCESS');
      }

      const [created] = await ParticipantInviteModel.create(
        [
          {
            tripId: trip._id,
            participantId: targetParticipant._id,
            familyId: boundFamilyId,
            invitedByUserId: inviterObjectId,
            invitedByParticipantId: freshActor._id,
            tokenHash,
            intendedEmail: policy.intendedEmail,
            grantedRole: parsed.grantedRole,
            requireVerifiedEmail: policy.requireVerifiedEmail,
            expiresAt,
          },
        ],
        session ? { session } : undefined
      );

      txState.invite = created;
      txState.targetParticipant = targetParticipant;
      txState.freshActor = freshActor;

      const activityLogId = new mongoose.Types.ObjectId();
      txState.activityLogId = activityLogId;
      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'PARTICIPANT_INVITE_CREATED',
        entityType: 'PARTICIPANT_INVITE',
        entityId: created._id,
        summary: `${freshActor.name} issued a ${created.grantedRole} invitation for "${targetParticipant.name}".`,
        metadata: {
          participantId: targetParticipant._id.toString(),
          grantedRole: created.grantedRole,
          requireVerifiedEmail: created.requireVerifiedEmail,
        },
        session,
      });
    },
    rollback: async () => {
      if (txState.activityLogId) {
        await ActivityLogModel.deleteOne({ _id: txState.activityLogId });
      }
      if (txState.invite) {
        await ParticipantInviteModel.deleteOne({ _id: txState.invite._id });
      }
      await restoreRevokedInviteRecords(txState.revokedInvites);
    },
  });

  if (!txState.invite || !txState.targetParticipant) {
    throw new AppError('Failed to create participant invitation.', 500, 'INTERNAL_SERVER_ERROR');
  }

  let emailDelivery: { sent: boolean; provider?: string } = { sent: false };
  if (policy.intendedEmail) {
    try {
      const deliveryResult = await emailService.sendParticipantInviteEmail({
        to: policy.intendedEmail,
        recipientName: txState.targetParticipant.name,
        tripName: trip.name,
        grantedRole: txState.invite.grantedRole,
        rawToken,
        expiresInHours: parsed.expiresInHours,
      });
      emailDelivery = { sent: true, provider: deliveryResult.provider };
    } catch (err) {
      // Fail closed on delivery failure: revoke the freshly created invite so no undelivered
      // active invite token lingers in the database.
      try {
        const actorForRevoke = txState.freshActor ?? actorParticipant;
        const revokeRes = await ParticipantInviteModel.updateOne(
          {
            _id: txState.invite._id,
            usedAt: null,
            revokedAt: null,
          },
          {
            $set: {
              revokedAt: new Date(),
              revokedByParticipantId: actorForRevoke._id,
            },
          }
        );
        if (revokeRes.modifiedCount === 1) {
          await logTripActivity({
            tripId: trip._id,
            actorUserId,
            actorParticipantId: actorForRevoke._id,
            actorName: actorForRevoke.name,
            actionType: 'PARTICIPANT_INVITE_REVOKED',
            entityType: 'PARTICIPANT_INVITE',
            entityId: txState.invite._id,
            summary: `${actorForRevoke.name}'s ${txState.invite.grantedRole} invitation for "${txState.targetParticipant.name}" was revoked after email delivery failed.`,
            metadata: {
              participantId: txState.targetParticipant._id.toString(),
              grantedRole: txState.invite.grantedRole,
              reason: 'EMAIL_DELIVERY_FAILED',
            },
          });
        }
      } catch (revokeErr) {
        console.error(
          '[tripledger] Failed to revoke invite after email delivery error:',
          revokeErr
        );
      }
      throw err;
    }
  }

  return {
    invite: formatParticipantInvite(txState.invite),
    rawToken,
    claimUrl,
    emailDelivery,
  };
}

export async function listTripParticipantInvitesForOrganizer(
  tripId: mongoose.Types.ObjectId
): Promise<ParticipantInviteEntity[]> {
  const invites = await ParticipantInviteModel.find({ tripId }).sort({ createdAt: -1 });
  return invites.map(formatParticipantInvite);
}

export async function listPendingInvitesForVerifiedUser(
  userId: string
): Promise<PendingParticipantInviteEntity[]> {
  const user = await UserModel.findById(userId).select('email emailVerified');
  if (!user) {
    throw new AppError('User account not found.', 401, 'UNAUTHORIZED');
  }
  if (user.emailVerified !== true) {
    throw new AppError(
      'Please verify your email address before viewing email-bound invitations.',
      403,
      'EMAIL_NOT_VERIFIED'
    );
  }

  const normalizedEmail = user.email.trim().toLowerCase();
  const now = new Date();
  const pendingInvites = await ParticipantInviteModel.find({
    intendedEmail: normalizedEmail,
    usedAt: null,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).sort({ createdAt: -1 });

  if (pendingInvites.length === 0) {
    return [];
  }

  const tripIds = Array.from(new Set(pendingInvites.map((inv) => inv.tripId)));
  const participantIds = Array.from(new Set(pendingInvites.map((inv) => inv.participantId)));

  const [trips, participants] = await Promise.all([
    TripModel.find({ _id: { $in: tripIds } }).select('name mode status'),
    ParticipantModel.find({ _id: { $in: participantIds } }).select('name userId isActive familyId'),
  ]);

  const tripMap = new Map(trips.map((t) => [t._id.toString(), t]));
  const participantMap = new Map(participants.map((p) => [p._id.toString(), p]));

  const results: PendingParticipantInviteEntity[] = [];
  for (const inv of pendingInvites) {
    const trip = tripMap.get(inv.tripId.toString());
    const participant = participantMap.get(inv.participantId.toString());
    if (!trip || trip.status === 'CLOSED' || !participant || !participant.isActive) {
      continue;
    }
    if (participant.userId && participant.userId.toString() !== user._id.toString()) {
      continue;
    }
    if (
      inv.grantedRole === 'FAMILY_REP' &&
      (!inv.familyId ||
        !participant.familyId ||
        participant.familyId.toString() !== inv.familyId.toString())
    ) {
      continue;
    }
    results.push({
      id: inv._id.toString(),
      tripId: inv.tripId.toString(),
      tripName: trip.name,
      tripMode: trip.mode,
      participantId: inv.participantId.toString(),
      participantName: participant.name,
      grantedRole: inv.grantedRole,
      intendedEmail: normalizedEmail,
      requireVerifiedEmail: Boolean(inv.requireVerifiedEmail),
      expiresAt: inv.expiresAt.toISOString(),
    });
  }

  return results;
}

export async function claimParticipantInviteForUser(params: {
  userId: string;
  body: unknown;
}) {
  const { token } = claimParticipantInviteSchema.parse(params.body);
  const tokenHash = hashToken(token);

  const initialInvite = await ParticipantInviteModel.findOne({ tokenHash });
  if (!initialInvite) {
    throw new AppError('Invitation token is invalid or unavailable.', 404, 'INVITE_NOT_FOUND');
  }

  const txState: {
    trip?: ITrip;
    participant?: IParticipant;
    invite?: IParticipantInvite;
    rollbackSnapshot?: ParticipantUpdateSnapshot;
    participantSaved: boolean;
    familySnapshots: FamilyUpdateSnapshot[];
    claimedInviteRevert?: {
      _id: mongoose.Types.ObjectId;
      usedAt: Date;
    };
    activityLogId?: mongoose.Types.ObjectId;
  } = {
    participantSaved: false,
    familySnapshots: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: initialInvite.tripId,
    work: async (session) => {
      txState.trip = undefined;
      txState.participant = undefined;
      txState.invite = undefined;
      txState.rollbackSnapshot = undefined;
      txState.participantSaved = false;
      txState.familySnapshots = [];
      txState.claimedInviteRevert = undefined;
      txState.activityLogId = undefined;

      const user = await UserModel.findById(params.userId).session(session);
      if (!user) {
        throw new AppError('User account not found.', 401, 'UNAUTHORIZED');
      }

      const trip = await TripModel.findById(initialInvite.tripId).session(session);
      if (!trip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (trip.status === 'CLOSED') {
        throw new AppError(
          'This trip is closed and no longer accepting role invitations.',
          403,
          'TRIP_CLOSED'
        );
      }

      const liveInvite = await ParticipantInviteModel.findById(initialInvite._id).session(session);
      if (!liveInvite) {
        throw new AppError('Invitation token is invalid or unavailable.', 404, 'INVITE_NOT_FOUND');
      }
      if (liveInvite.revokedAt) {
        throw new AppError('This invitation has been revoked by an organizer.', 409, 'INVITE_REVOKED');
      }
      if (liveInvite.usedAt) {
        throw new AppError('This invitation has already been redeemed.', 409, 'INVITE_ALREADY_USED');
      }

      const now = new Date();
      if (liveInvite.expiresAt.getTime() <= now.getTime()) {
        throw new AppError('This invitation has expired.', 400, 'INVITE_EXPIRED');
      }

      const privileged = isPrivilegedTripRole(liveInvite.grantedRole);
      if (privileged && (!liveInvite.intendedEmail || liveInvite.requireVerifiedEmail !== true)) {
        throw new AppError(
          'Invitation violates verified-email privilege policy.',
          403,
          'INVITE_POLICY_VIOLATION'
        );
      }

      if (
        privileged ||
        liveInvite.requireVerifiedEmail === true ||
        liveInvite.intendedEmail !== null
      ) {
        if (user.emailVerified !== true) {
          throw new AppError(
            'Please verify your email address before accepting this invitation.',
            403,
            'EMAIL_NOT_VERIFIED'
          );
        }
      }

      if (liveInvite.intendedEmail !== null) {
        const userEmail = user.email.trim().toLowerCase();
        const targetEmail = liveInvite.intendedEmail.trim().toLowerCase();
        if (userEmail !== targetEmail) {
          throw new AppError(
            'This invitation was issued for a different email address.',
            403,
            'INVITE_EMAIL_MISMATCH'
          );
        }
      }

      const participant = await ParticipantModel.findOne({
        _id: liveInvite.participantId,
        tripId: trip._id,
      }).session(session);
      if (!participant) {
        throw new AppError('Target participant slot no longer exists.', 404, 'PARTICIPANT_NOT_FOUND');
      }
      if (!participant.isActive) {
        throw new AppError(
          'Your participant record in this trip is deactivated.',
          403,
          'PARTICIPANT_DEACTIVATED'
        );
      }

      // Policy #6: Existing linked users must never be silently replaced or reassigned.
      if (participant.userId && participant.userId.toString() !== user._id.toString()) {
        throw new AppError(
          'This participant slot is already linked to another user account.',
          409,
          'PARTICIPANT_ALREADY_LINKED'
        );
      }

      const existingOtherMembership = await ParticipantModel.findOne({
        tripId: trip._id,
        userId: user._id,
        _id: { $ne: participant._id },
      }).session(session);
      if (existingOtherMembership) {
        throw new AppError(
          'Your account is already linked to another participant record in this trip.',
          409,
          'ALREADY_TRIP_MEMBER'
        );
      }

      // Policy #8: Preserve the sole-linked-organizer invariant on any role change.
      const wasActiveLinkedOrganizer = isActiveLinkedOrganizer(participant);
      const wasFamilyRep = participant.role === 'FAMILY_REP';
      if (wasActiveLinkedOrganizer && liveInvite.grantedRole !== 'ORGANIZER') {
        const otherLinkedOrganizers = await countActiveLinkedOrganizers(trip._id, {
          excludeParticipantId: participant._id,
          session,
        });
        if (otherLinkedOrganizers === 0) {
          throw new AppError(
            'Cannot demote the sole active linked organizer of the trip.',
            400,
            'SOLE_ORGANIZER'
          );
        }
      }

      // Enforce FAMILY_REP eligibility (including mandatory familyId binding) BEFORE marking
      // the single-use invite redeemed.
      const eligibleFamily =
        liveInvite.grantedRole === 'FAMILY_REP'
          ? await assertParticipantEligibleForFamilyRepInvite({
              trip,
              participant,
              session,
              expectedFamilyId: liveInvite.familyId ?? null,
              requireExpectedFamilyId: true,
            })
          : null;

      if (
        liveInvite.grantedRole === 'FAMILY_REP' &&
        (!liveInvite.familyId ||
          !eligibleFamily ||
          !liveInvite.familyId.equals(eligibleFamily._id))
      ) {
        throw new AppError(
          'This FAMILY_REP invitation was issued without a matching family group binding and is no longer valid.',
          409,
          'INVITE_FAMILY_MISMATCH'
        );
      }

      // Atomically mark the invitation used before mutating the participant so replay/concurrent
      // claims fail closed immediately at single-use transition.
      const claimedInvite = await ParticipantInviteModel.findOneAndUpdate(
        {
          _id: liveInvite._id,
          usedAt: null,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            usedAt: now,
            usedByUserId: user._id,
          },
        },
        {
          ...(session ? { session } : {}),
          new: true,
        }
      );

      if (!claimedInvite) {
        throw new AppError(
          'This invitation is no longer available.',
          409,
          'INVITE_ALREADY_USED'
        );
      }

      txState.claimedInviteRevert = {
        _id: claimedInvite._id,
        usedAt: claimedInvite.usedAt ?? now,
      };

      const participantSnap = captureParticipantUpdateSnapshot(participant);
      txState.rollbackSnapshot = participantSnap;

      if (!participant.userId) {
        participant.userId = user._id;
      }
      participant.email = user.email;
      participant.role = claimedInvite.grantedRole;

      try {
        await participant.save(session ? { session } : undefined);
        participantSnap.expectedUpdatedAt = participant.updatedAt;
        txState.participantSaved = true;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new AppError(
            'Your account is already linked to another participant record in this trip.',
            409,
            'ALREADY_TRIP_MEMBER'
          );
        }
        throw err;
      }

      if (claimedInvite.grantedRole === 'FAMILY_REP' && eligibleFamily) {
        const famSnap = !eligibleFamily.representativeId
          ? captureFamilySnapshot(eligibleFamily)
          : null;
        if (famSnap) {
          txState.familySnapshots.push(famSnap);
        }
        const boundFamily = await FamilyModel.findOneAndUpdate(
          {
            _id: eligibleFamily._id,
            tripId: trip._id,
            $or: [{ representativeId: null }, { representativeId: participant._id }],
          },
          { $set: { representativeId: participant._id } },
          { new: true, ...(session ? { session } : {}) }
        );
        if (!boundFamily) {
          throw new AppError(
            'This family group already has a designated representative.',
            409,
            'FAMILY_ALREADY_HAS_REPRESENTATIVE'
          );
        }
        if (famSnap) {
          famSnap.expectedUpdatedAt = boundFamily.updatedAt;
        }
      } else if (wasFamilyRep && !isPrivilegedTripRole(claimedInvite.grantedRole)) {
        const affectedFamilies = await FamilyModel.find({
          tripId: trip._id,
          representativeId: participant._id,
        }).session(session);
        for (const fam of affectedFamilies) {
          const famSnap = captureFamilySnapshot(fam);
          txState.familySnapshots.push(famSnap);
          fam.representativeId = null;
          await fam.save(session ? { session } : undefined);
          famSnap.expectedUpdatedAt = fam.updatedAt;
        }
      }

      if (wasActiveLinkedOrganizer) {
        const remainingLinkedOrganizers = await countActiveLinkedOrganizers(trip._id, {
          session,
        });
        if (remainingLinkedOrganizers < 1) {
          throw new AppError(
            'Cannot demote the sole active linked organizer of the trip.',
            400,
            'SOLE_ORGANIZER'
          );
        }
      }

      txState.trip = trip;
      txState.participant = participant;
      txState.invite = claimedInvite;

      const activityLogId = new mongoose.Types.ObjectId();
      txState.activityLogId = activityLogId;
      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: params.userId,
        actorParticipantId: participant._id,
        actorName: participant.name,
        actionType: 'PARTICIPANT_INVITE_REDEEMED',
        entityType: 'PARTICIPANT_INVITE',
        entityId: claimedInvite._id,
        summary: `${participant.name} accepted a ${participant.role} role invitation.`,
        metadata: {
          participantId: participant._id.toString(),
          grantedRole: participant.role,
        },
        session,
      });
    },
    rollback: async () => {
      if (txState.activityLogId) {
        await ActivityLogModel.deleteOne({ _id: txState.activityLogId });
      }
      await restoreFamilySnapshots(txState.familySnapshots);
      if (txState.participantSaved && txState.rollbackSnapshot) {
        await ParticipantModel.updateOne(
          {
            _id: txState.rollbackSnapshot._id,
            ...(txState.rollbackSnapshot.expectedUpdatedAt
              ? { updatedAt: txState.rollbackSnapshot.expectedUpdatedAt }
              : {}),
          },
          buildParticipantUpdateRestoreOp(txState.rollbackSnapshot)
        );
      }
      if (txState.claimedInviteRevert) {
        await ParticipantInviteModel.collection.updateOne(
          {
            _id: txState.claimedInviteRevert._id,
            usedAt: txState.claimedInviteRevert.usedAt,
            revokedAt: null,
          },
          {
            $set: {
              usedAt: null,
              usedByUserId: null,
            },
          }
        );
      }
    },
  });

  if (!txState.trip || !txState.participant || !txState.invite) {
    throw new AppError('Failed to redeem participant invitation.', 500, 'INTERNAL_SERVER_ERROR');
  }

  return {
    tripId: txState.trip._id.toString(),
    role: txState.participant.role,
    participant: formatParticipantDoc(txState.participant),
    trip: formatTripDoc(txState.trip, {
      includeInviteCode: txState.participant.role === 'ORGANIZER',
    }),
    invite: formatParticipantInvite(txState.invite),
  };
}

export async function revokeParticipantInviteForTrip(params: {
  tripId: mongoose.Types.ObjectId;
  inviteId: string;
  actorUserId?: string;
  actorParticipant: IParticipant;
}): Promise<{ invite: ParticipantInviteEntity; alreadyRevoked: boolean }> {
  const { tripId, inviteId, actorUserId, actorParticipant } = params;

  if (!mongoose.Types.ObjectId.isValid(inviteId)) {
    throw new AppError('Invalid invitation identifier format.', 400, 'INVALID_ID');
  }

  const txState: {
    invite?: IParticipantInvite;
    alreadyRevoked?: boolean;
    revokedRecord?: RevokedInviteRollbackRecord;
    activityLogId?: mongoose.Types.ObjectId;
  } = {};

  await runSerializedTripOrganizerMutation({
    tripId,
    work: async (session) => {
      txState.invite = undefined;
      txState.alreadyRevoked = false;
      txState.revokedRecord = undefined;
      txState.activityLogId = undefined;

      const freshActor = await assertFreshActiveOrganizerActor(tripId, actorParticipant._id, session);

      const liveInvite = await ParticipantInviteModel.findOne({
        _id: inviteId,
        tripId,
      }).session(session);
      if (!liveInvite) {
        throw new AppError('Invitation not found in this trip.', 404, 'INVITE_NOT_FOUND');
      }

      if (liveInvite.usedAt) {
        throw new AppError(
          'Cannot revoke an invitation that has already been redeemed.',
          409,
          'INVITE_ALREADY_USED'
        );
      }

      if (liveInvite.revokedAt) {
        txState.invite = liveInvite;
        txState.alreadyRevoked = true;
        return;
      }

      const revokeTimestamp = new Date();
      const revoked = await ParticipantInviteModel.findOneAndUpdate(
        {
          _id: liveInvite._id,
          tripId,
          usedAt: null,
          revokedAt: null,
        },
        {
          $set: {
            revokedAt: revokeTimestamp,
            revokedByParticipantId: freshActor._id,
          },
        },
        {
          ...(session ? { session } : {}),
          new: true,
        }
      );

      if (!revoked) {
        const currentAfterRace = await ParticipantInviteModel.findById(liveInvite._id).session(
          session
        );
        if (currentAfterRace?.usedAt) {
          throw new AppError(
            'Cannot revoke an invitation that has already been redeemed.',
            409,
            'INVITE_ALREADY_USED'
          );
        }
        if (currentAfterRace?.revokedAt) {
          txState.invite = currentAfterRace;
          txState.alreadyRevoked = true;
          return;
        }
        throw new AppError('Unable to revoke invitation.', 409, 'INVITE_UNAVAILABLE');
      }

      txState.invite = revoked;
      txState.alreadyRevoked = false;
      txState.revokedRecord = {
        inviteIds: [revoked._id],
        revokedAt: revoked.revokedAt ?? revokeTimestamp,
      };

      const activityLogId = new mongoose.Types.ObjectId();
      txState.activityLogId = activityLogId;
      await logTripActivity({
        _id: activityLogId,
        tripId,
        actorUserId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'PARTICIPANT_INVITE_REVOKED',
        entityType: 'PARTICIPANT_INVITE',
        entityId: revoked._id,
        summary: `${freshActor.name} revoked a pending ${revoked.grantedRole} invitation.`,
        metadata: {
          participantId: revoked.participantId.toString(),
          grantedRole: revoked.grantedRole,
        },
        session,
      });
    },
    rollback: async () => {
      if (txState.activityLogId) {
        await ActivityLogModel.deleteOne({ _id: txState.activityLogId });
      }
      if (txState.revokedRecord) {
        await restoreRevokedInviteRecords([txState.revokedRecord]);
      }
    },
  });

  if (!txState.invite) {
    throw new AppError('Failed to revoke invitation.', 500, 'INTERNAL_SERVER_ERROR');
  }

  return {
    invite: formatParticipantInvite(txState.invite),
    alreadyRevoked: Boolean(txState.alreadyRevoked),
  };
}
