import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  createFamilySchema,
  createParticipantSchema,
  createTripSchema,
  DEFAULT_OPEN_INVITE_ROLE,
  EXPENSE_CATEGORY_LABELS,
  FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES,
  isPrivilegedTripRole,
  joinTripSchema,
  updateChecklistItemSchema,
  updateFamilySchema,
  updateParticipantSchema,
  updateTripSchema,
} from '@tripledger/shared';
import {
  ActivityLogModel,
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
  FamilyModel,
  ParticipantModel,
  SettlementModel,
  TripModel,
  type IFamily,
  type IParticipant,
  type ITrip,
} from '../models/index.js';
import {
  assertActiveRepresentativeCandidateInTrip,
  assertParticipantEligibleAsFamilyRepresentative,
  assertValidFamilyInTrip,
  captureFamilySnapshot,
  restoreFamilySnapshots,
  restoreParticipantSnapshots,
  restoreRevokedInviteRecords,
  revokePendingParticipantInvites,
  sameObjectId,
  type FamilyUpdateSnapshot,
  type RevokedInviteRollbackRecord,
} from '../services/familyInvariant.js';
import { loadTripLedgerData, logTripActivity } from '../services/ledgerService.js';
import {
  assertFreshActiveOrganizerActor,
  captureParticipantUpdateSnapshot,
  countActiveLinkedOrganizers,
  isActiveLinkedOrganizer,
  runSerializedTripOrganizerMutation,
  type ParticipantUpdateSnapshot,
} from '../services/organizerInvariant.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { generateInviteCode, generateShareToken } from '../utils/tokens.js';

export const createTrip = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const parsed = createTripSchema.parse(req.body);

  const initialChecklist = FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES.map((category) => ({
    category,
    label: EXPENSE_CATEGORY_LABELS[category],
    checked: false,
    notApplicable: false,
    verifiedAt: null,
  }));

  const trip = await TripModel.create({
    name: parsed.name,
    description: parsed.description,
    mode: parsed.mode,
    status: 'ACTIVE',
    currency: 'NPR',
    budgetPaisa: parsed.budgetPaisa,
    startDate: parsed.startDate ? new Date(parsed.startDate) : undefined,
    endDate: parsed.endDate ? new Date(parsed.endDate) : undefined,
    createdBy: req.user.userId,
    inviteCode: generateInviteCode(8),
    shareToken: generateShareToken(),
    shareEnabled: true,
    checklist: initialChecklist,
  });

  let organizerFamilyId: mongoose.Types.ObjectId | null = null;
  if (parsed.mode === 'FAMILY' && parsed.organizerFamilyName) {
    const family = await FamilyModel.create({
      tripId: trip._id,
      name: parsed.organizerFamilyName,
      defaultWeight: 1,
    });
    organizerFamilyId = family._id;
  }

  const organizerParticipant = await ParticipantModel.create({
    tripId: trip._id,
    userId: req.user.userId,
    familyId: organizerFamilyId,
    name: req.user.name,
    email: req.user.email,
    role: 'ORGANIZER',
    memberType: 'ADULT',
    defaultWeight: 1,
    isActive: true,
  });

  if (organizerFamilyId) {
    await FamilyModel.findByIdAndUpdate(organizerFamilyId, {
      $set: { representativeId: organizerParticipant._id },
    });
  }

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user.userId,
    actorParticipantId: organizerParticipant._id,
    actorName: req.user.name,
    actionType: 'TRIP_CREATED',
    entityType: 'TRIP',
    entityId: trip._id,
    summary: `${req.user.name} created ${parsed.mode === 'FAMILY' ? 'Family' : 'Friends'} trip "${trip.name}".`,
  });

  const fullData = await loadTripLedgerData(trip._id);

  sendSuccess(
    res,
    {
      trip: formatTripDoc(trip, { includeInviteCode: true }),
      myParticipant: {
        id: organizerParticipant._id.toString(),
        role: organizerParticipant.role,
        name: organizerParticipant.name,
      },
      ...fullData,
    },
    201
  );
});

export const listTrips = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const { mode, status } = req.query;

  const myMemberships = await ParticipantModel.find({
    userId: req.user.userId,
    isActive: true,
  });

  const tripIds = myMemberships.map((m) => m.tripId);
  const query: Record<string, unknown> = { _id: { $in: tripIds } };
  if (typeof mode === 'string' && (mode === 'FRIENDS' || mode === 'FAMILY')) {
    query.mode = mode;
  }
  if (typeof status === 'string') {
    query.status = status;
  }

  const trips = await TripModel.find(query).sort({ updatedAt: -1 });
  const membershipByTrip = new Map(
    myMemberships.map((m) => [m.tripId.toString(), m])
  );

  const enrichedTrips = await Promise.all(
    trips.map(async (trip) => {
      const ledgerData = await loadTripLedgerData(trip._id);
      const myMember = membershipByTrip.get(trip._id.toString());
      const myBalance = ledgerData.ledger.individualBalances.find(
        (b) => b.participantId === myMember?._id.toString()
      );

      return {
        ...formatTripDoc(trip, { includeInviteCode: myMember?.role === 'ORGANIZER' }),
        participantCount: ledgerData.participants.filter((p) => p.isActive).length,
        familyCount: ledgerData.families.length,
        totalApprovedExpensePaisa: ledgerData.ledger.totalApprovedExpensePaisa,
        totalPendingExpensePaisa: ledgerData.ledger.totalPendingExpensePaisa,
        myRole: myMember?.role ?? 'PARTICIPANT',
        myParticipantId: myMember?._id.toString() ?? null,
        myOutstandingBalancePaisa: myBalance?.outstandingBalancePaisa ?? 0,
      };
    })
  );

  sendSuccess(res, { trips: enrichedTrips });
});

export const getTripById = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const participant = req.participant!;

  const ledgerData = await loadTripLedgerData(trip._id);

  sendSuccess(res, {
    trip: formatTripDoc(trip, { includeInviteCode: participant.role === 'ORGANIZER' }),
    myParticipant: {
      id: participant._id.toString(),
      name: participant.name,
      role: participant.role,
      familyId: participant.familyId ? participant.familyId.toString() : null,
    },
    participants: ledgerData.participants,
    families: ledgerData.families,
    expenses: ledgerData.expenses.filter((e) => !e.isDeleted),
    settlements: ledgerData.settlements.filter((s) => !s.isDeleted),
    ledger: ledgerData.ledger,
    individualSettlementSuggestions: ledgerData.individualSettlementSuggestions,
    familySettlementSuggestions: ledgerData.familySettlementSuggestions,
  });
});

export const updateTrip = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const participant = req.participant!;
  const parsed = updateTripSchema.parse(req.body);

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    updatedTrip?: ITrip;
    writtenUpdatedAt?: Date;
    loggedActivity: boolean;
    previousFields?: {
      name: string;
      description: string | undefined;
      budgetPaisa: number | undefined;
      startDate: Date | undefined;
      endDate: Date | undefined;
      shareEnabled: boolean;
      status: ITrip['status'];
      closedAt: Date | null;
      inviteEnabled: boolean;
      inviteExpiresAt: Date | null;
    };
  } = {
    loggedActivity: false,
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.updatedTrip = undefined;
      txState.writtenUpdatedAt = undefined;
      txState.loggedActivity = false;
      txState.previousFields = undefined;

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, participant._id, session);
      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }

      const wasClosed = liveTrip.status === 'CLOSED';
      const targetStatus = parsed.status ?? liveTrip.status;

      if (targetStatus === 'CLOSED' && parsed.inviteEnabled === true) {
        throw new AppError(
          'Open invite-code joining cannot be enabled while a trip is closed.',
          400,
          'INVITE_NOT_ALLOWED_ON_CLOSED_TRIP'
        );
      }

      txState.previousFields = {
        name: liveTrip.name,
        description: liveTrip.description,
        budgetPaisa: liveTrip.budgetPaisa,
        startDate: liveTrip.startDate,
        endDate: liveTrip.endDate,
        shareEnabled: liveTrip.shareEnabled,
        status: liveTrip.status,
        closedAt: liveTrip.closedAt ?? null,
        inviteEnabled: liveTrip.inviteEnabled,
        inviteExpiresAt: liveTrip.inviteExpiresAt ?? null,
      };

      if (parsed.name !== undefined) liveTrip.name = parsed.name;
      if (parsed.description !== undefined) liveTrip.description = parsed.description;
      if (parsed.budgetPaisa !== undefined) liveTrip.budgetPaisa = parsed.budgetPaisa;
      if (parsed.startDate !== undefined) {
        liveTrip.startDate = parsed.startDate ? new Date(parsed.startDate) : undefined;
      }
      if (parsed.endDate !== undefined) {
        liveTrip.endDate = parsed.endDate ? new Date(parsed.endDate) : undefined;
      }
      if (parsed.shareEnabled !== undefined) liveTrip.shareEnabled = parsed.shareEnabled;

      if (parsed.status !== undefined) {
        liveTrip.status = parsed.status;
        if (parsed.status === 'CLOSED') {
          liveTrip.closedAt = liveTrip.closedAt ?? new Date();
          liveTrip.inviteEnabled = false;
        } else if (wasClosed) {
          // Clear archival closure timestamp on organizer reopen; keep inviteEnabled under explicit control.
          liveTrip.closedAt = null;
        }
      }

      if (parsed.inviteEnabled !== undefined && targetStatus !== 'CLOSED') {
        liveTrip.inviteEnabled = parsed.inviteEnabled;
      }
      if (parsed.inviteExpiresAt !== undefined) {
        liveTrip.inviteExpiresAt =
          parsed.inviteExpiresAt === null ? null : new Date(parsed.inviteExpiresAt);
      }

      await liveTrip.save(session ? { session } : undefined);
      txState.writtenUpdatedAt = liveTrip.updatedAt;
      txState.updatedTrip = liveTrip;

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'TRIP_UPDATED',
        entityType: 'TRIP',
        entityId: liveTrip._id,
        summary: `${freshActor.name} updated trip settings.`,
        session,
      });
      txState.loggedActivity = true;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (!txState.updatedTrip || !txState.previousFields) return;
      const prev = txState.previousFields;
      const $set: Record<string, unknown> = {
        name: prev.name,
        shareEnabled: prev.shareEnabled,
        status: prev.status,
        closedAt: prev.closedAt,
        inviteEnabled: prev.inviteEnabled,
        inviteExpiresAt: prev.inviteExpiresAt,
      };
      const $unset: Record<string, 1> = {};
      if (prev.description !== undefined) $set.description = prev.description;
      else $unset.description = 1;
      if (prev.budgetPaisa !== undefined) $set.budgetPaisa = prev.budgetPaisa;
      else $unset.budgetPaisa = 1;
      if (prev.startDate !== undefined) $set.startDate = prev.startDate;
      else $unset.startDate = 1;
      if (prev.endDate !== undefined) $set.endDate = prev.endDate;
      else $unset.endDate = 1;

      await TripModel.updateOne(
        {
          _id: trip._id,
          ...(txState.writtenUpdatedAt ? { updatedAt: txState.writtenUpdatedAt } : {}),
        },
        Object.keys($unset).length > 0 ? { $set, $unset } : { $set }
      );
    },
  });

  if (!txState.updatedTrip) {
    throw new AppError('Failed to update trip.', 500, 'INTERNAL_SERVER_ERROR');
  }

  sendSuccess(res, { trip: formatTripDoc(txState.updatedTrip, { includeInviteCode: true }) });
});

export const joinTripByInviteCode = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }
  const authUser = req.user;

  joinTripSchema.parse(req.body ?? {});

  const rawInviteCode = req.params.inviteCode;
  const inviteCode = typeof rawInviteCode === 'string' ? rawInviteCode.trim().toUpperCase() : '';
  const initialTrip = inviteCode ? await TripModel.findOne({ inviteCode }) : null;
  if (!initialTrip) {
    throw new AppError('Invalid or unavailable invite code.', 404, 'TRIP_NOT_FOUND');
  }

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    createdParticipantId?: mongoose.Types.ObjectId;
    loggedActivity: boolean;
    result?: {
      trip: ITrip;
      participantId: string;
      alreadyJoined: boolean;
      role: IParticipant['role'];
      includeInviteCode: boolean;
    };
  } = {
    loggedActivity: false,
  };

  await runSerializedTripOrganizerMutation({
    tripId: initialTrip._id,
    work: async (session) => {
      txState.createdParticipantId = undefined;
      txState.loggedActivity = false;
      txState.result = undefined;

      const liveTrip = await TripModel.findById(initialTrip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Invalid or unavailable invite code.', 404, 'TRIP_NOT_FOUND');
      }

      if (liveTrip.status === 'CLOSED') {
        throw new AppError(
          'This trip is closed and no longer accepting new members.',
          403,
          'TRIP_CLOSED'
        );
      }

      if (liveTrip.inviteEnabled === false) {
        throw new AppError(
          'Open invite-code joining is disabled for this trip.',
          403,
          'INVITE_DISABLED'
        );
      }

      if (liveTrip.inviteExpiresAt && liveTrip.inviteExpiresAt.getTime() <= Date.now()) {
        throw new AppError('This invite code has expired.', 403, 'INVITE_EXPIRED');
      }

      // Existing membership check: never reactivate deactivated members via open invite code.
      const existingParticipant = await ParticipantModel.findOne({
        tripId: liveTrip._id,
        userId: authUser.userId,
      }).session(session);

      if (existingParticipant) {
        if (!existingParticipant.isActive) {
          throw new AppError(
            'Your membership in this trip has been deactivated by an organizer.',
            403,
            'PARTICIPANT_DEACTIVATED'
          );
        }
        txState.result = {
          trip: liveTrip,
          participantId: existingParticipant._id.toString(),
          alreadyJoined: true,
          role: existingParticipant.role,
          includeInviteCode: existingParticipant.role === 'ORGANIZER',
        };
        return;
      }

      // Open invite-code joins ALWAYS enroll a fresh low-privilege PARTICIPANT record and NEVER
      // auto-link or claim existing guest participant rows by ID or email.
      const participantId = new mongoose.Types.ObjectId();
      let participant: IParticipant;
      try {
        const [created] = await ParticipantModel.create(
          [
            {
              _id: participantId,
              tripId: liveTrip._id,
              userId: authUser.userId,
              name: authUser.name,
              email: authUser.email,
              role: DEFAULT_OPEN_INVITE_ROLE,
              memberType: 'ADULT',
              defaultWeight: 1,
              isActive: true,
            },
          ],
          session ? { session } : undefined
        );
        participant = created;
      } catch (err) {
        if (session === null && isDuplicateKeyError(err)) {
          const concurrent = await ParticipantModel.findOne({
            tripId: liveTrip._id,
            userId: authUser.userId,
          });
          if (concurrent) {
            if (!concurrent.isActive) {
              throw new AppError(
                'Your membership in this trip has been deactivated by an organizer.',
                403,
                'PARTICIPANT_DEACTIVATED'
              );
            }
            txState.result = {
              trip: liveTrip,
              participantId: concurrent._id.toString(),
              alreadyJoined: true,
              role: concurrent.role,
              includeInviteCode: concurrent.role === 'ORGANIZER',
            };
            return;
          }
        }
        throw err;
      }
      txState.createdParticipantId = participant._id;

      await logTripActivity({
        _id: activityLogId,
        tripId: liveTrip._id,
        actorUserId: authUser.userId,
        actorParticipantId: participant._id,
        actorName: authUser.name,
        actionType: 'PARTICIPANT_JOINED',
        entityType: 'PARTICIPANT',
        entityId: participant._id,
        summary: `${authUser.name} joined the trip via invite code.`,
        session,
      });
      txState.loggedActivity = true;

      txState.result = {
        trip: liveTrip,
        participantId: participant._id.toString(),
        alreadyJoined: false,
        role: participant.role,
        includeInviteCode: false,
      };
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (txState.createdParticipantId) {
        await ParticipantModel.deleteOne({ _id: txState.createdParticipantId });
      }
    },
  });

  if (!txState.result) {
    throw new AppError('Failed to join trip.', 500, 'INTERNAL_SERVER_ERROR');
  }

  sendSuccess(res, {
    trip: formatTripDoc(txState.result.trip, {
      includeInviteCode: txState.result.includeInviteCode,
    }),
    participantId: txState.result.participantId,
    alreadyJoined: txState.result.alreadyJoined,
    role: txState.result.role,
  });
});

export const addParticipant = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const parsed = createParticipantSchema.parse(req.body);

  if (parsed.role !== DEFAULT_OPEN_INVITE_ROLE) {
    throw new AppError(
      'Guest participants can only be created with the PARTICIPANT role; higher roles require verified account membership.',
      400,
      'GUEST_ROLE_RESTRICTED'
    );
  }

  const participantId = new mongoose.Types.ObjectId();
  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    createdParticipant?: IParticipant;
    loggedActivity: boolean;
  } = {
    loggedActivity: false,
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.createdParticipant = undefined;
      txState.loggedActivity = false;

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);
      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }

      let familyObjectId: mongoose.Types.ObjectId | null = null;
      if (parsed.familyId) {
        if (liveTrip.mode !== 'FAMILY') {
          throw new AppError(
            'Participants can only be assigned to family groups in Family Mode trips.',
            400,
            'FAMILY_MODE_ONLY'
          );
        }
        familyObjectId = (await assertValidFamilyInTrip(trip._id, parsed.familyId, session))._id;
      }

      // Organizers always create unlinked guest records (userId: null, role: PARTICIPANT); never auto-link by email.
      const [participant] = await ParticipantModel.create(
        [
          {
            _id: participantId,
            tripId: trip._id,
            userId: null,
            familyId: familyObjectId,
            name: parsed.name,
            email: parsed.email || undefined,
            phone: parsed.phone,
            role: DEFAULT_OPEN_INVITE_ROLE,
            memberType: parsed.memberType,
            defaultWeight: parsed.defaultWeight,
            isActive: true,
          },
        ],
        session ? { session } : undefined
      );
      txState.createdParticipant = participant;

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'PARTICIPANT_ADDED',
        entityType: 'PARTICIPANT',
        entityId: participant._id,
        summary: `${freshActor.name} added participant "${participant.name}" (${participant.role}).`,
        session,
      });
      txState.loggedActivity = true;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (txState.createdParticipant) {
        await ParticipantModel.deleteOne({ _id: participantId });
      }
    },
  });

  if (!txState.createdParticipant) {
    throw new AppError('Failed to add participant.', 500, 'INTERNAL_SERVER_ERROR');
  }

  sendSuccess(
    res,
    {
      participant: formatParticipantDoc(txState.createdParticipant),
    },
    201
  );
});

export const updateParticipant = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { participantId } = req.params;
  const parsed = updateParticipantSchema.parse(req.body);

  if (typeof participantId !== 'string' || !mongoose.Types.ObjectId.isValid(participantId)) {
    throw new AppError('Invalid participant identifier format.', 400, 'INVALID_ID');
  }

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    updatedParticipant?: IParticipant;
    loggedActivity: boolean;
    participantSnapshots: ParticipantUpdateSnapshot[];
    familySnapshots: FamilyUpdateSnapshot[];
    revokedInvites: RevokedInviteRollbackRecord[];
  } = {
    loggedActivity: false,
    participantSnapshots: [],
    familySnapshots: [],
    revokedInvites: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.updatedParticipant = undefined;
      txState.loggedActivity = false;
      txState.participantSnapshots = [];
      txState.familySnapshots = [];
      txState.revokedInvites = [];

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);

      const [liveTrip, participant] = await Promise.all([
        TripModel.findById(trip._id).session(session),
        ParticipantModel.findOne({ _id: participantId, tripId: trip._id }).session(session),
      ]);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (!participant) {
        throw new AppError('Participant not found in this trip.', 404, 'PARTICIPANT_NOT_FOUND');
      }

      let validatedFamilyId: mongoose.Types.ObjectId | null | undefined;
      if (parsed.familyId !== undefined) {
        if (parsed.familyId) {
          if (liveTrip.mode !== 'FAMILY') {
            throw new AppError(
              'Participants can only be assigned to family groups in Family Mode trips.',
              400,
              'FAMILY_MODE_ONLY'
            );
          }
          validatedFamilyId = (await assertValidFamilyInTrip(trip._id, parsed.familyId, session))._id;
        } else {
          validatedFamilyId = null;
        }
      }

      let nextEmail: string | undefined;
      let hasEmailChange = false;
      if (parsed.email !== undefined) {
        nextEmail = parsed.email || undefined;
        if (participant.userId && nextEmail !== (participant.email || undefined)) {
          throw new AppError(
            'Cannot change email on an already-linked participant record.',
            409,
            'PARTICIPANT_EMAIL_IMMUTABLE_WHILE_LINKED'
          );
        }
        hasEmailChange = true;
      }

      const familyChanged =
        validatedFamilyId !== undefined &&
        !sameObjectId(validatedFamilyId, participant.familyId ?? null);
      const nextIsActive = parsed.isActive ?? participant.isActive;
      const isDeactivating = participant.isActive && nextIsActive === false;
      const isReactivating = !participant.isActive && nextIsActive === true;

      if (parsed.role !== undefined && parsed.role !== participant.role) {
        if (isPrivilegedTripRole(parsed.role)) {
          throw new AppError(
            'Promoting a participant to ORGANIZER or FAMILY_REP requires a verified email-bound invitation.',
            400,
            'PRIVILEGED_ROLE_REQUIRES_INVITE'
          );
        }
        if (!participant.userId && parsed.role !== DEFAULT_OPEN_INVITE_ROLE) {
          throw new AppError(
            'Unlinked guest participants are restricted to the PARTICIPANT role.',
            400,
            'GUEST_ROLE_RESTRICTED'
          );
        }
      }

      if (familyChanged && parsed.role === 'FAMILY_REP') {
        throw new AppError(
          'Moving a participant to another family requires a new verified FAMILY_REP invitation.',
          400,
          'PRIVILEGED_ROLE_REQUIRES_INVITE'
        );
      }

      if (isDeactivating && parsed.role !== undefined && isPrivilegedTripRole(parsed.role)) {
        throw new AppError(
          'Cannot retain or assign privileged roles while deactivating a participant.',
          400,
          'PRIVILEGED_ROLE_REQUIRES_INVITE'
        );
      }

      if (isReactivating) {
        const reactivatedRole = parsed.role ?? participant.role;
        if (!participant.userId && reactivatedRole !== DEFAULT_OPEN_INVITE_ROLE) {
          throw new AppError(
            'Unlinked guest participants can only be reactivated with the PARTICIPANT role.',
            400,
            'GUEST_ROLE_RESTRICTED'
          );
        }
        if (isPrivilegedTripRole(reactivatedRole)) {
          throw new AppError(
            'Reactivating a participant cannot restore ORGANIZER or FAMILY_REP roles directly. Reactivate as PARTICIPANT and issue a verified invitation.',
            400,
            'PRIVILEGED_ROLE_REQUIRES_INVITE'
          );
        }
      }

      let resolvedNextRole = parsed.role ?? participant.role;
      if (isDeactivating && isPrivilegedTripRole(resolvedNextRole)) {
        resolvedNextRole = DEFAULT_OPEN_INVITE_ROLE;
      } else if (familyChanged && resolvedNextRole === 'FAMILY_REP') {
        resolvedNextRole = DEFAULT_OPEN_INVITE_ROLE;
      }

      const wasActiveLinkedOrganizer = isActiveLinkedOrganizer(participant);
      if (participant.role === 'ORGANIZER' && participant.isActive) {
        if (resolvedNextRole !== 'ORGANIZER' || !nextIsActive) {
          const otherActiveLinkedOrganizers = await countActiveLinkedOrganizers(trip._id, {
            excludeParticipantId: participant._id,
            session,
          });
          if (otherActiveLinkedOrganizers === 0) {
            throw new AppError(
              'Cannot demote or deactivate the sole active linked organizer of the trip.',
              400,
              'SOLE_ORGANIZER'
            );
          }
        }
      }

      const participantSnap = captureParticipantUpdateSnapshot(participant);
      txState.participantSnapshots.push(participantSnap);

      // Clear stale Family.representativeId links when deactivating, moving out of a family,
      // or explicitly demoting an in-place FAMILY_REP to PARTICIPANT/CONTRIBUTOR.
      const isDemotingFromFamilyRep =
        participant.role === 'FAMILY_REP' && resolvedNextRole !== 'FAMILY_REP';
      if (isDeactivating || familyChanged || isDemotingFromFamilyRep) {
        const affectedFamilies = await FamilyModel.find({
          tripId: trip._id,
          representativeId: participant._id,
        }).session(session);

        for (const fam of affectedFamilies) {
          if (
            isDeactivating ||
            isDemotingFromFamilyRep ||
            !sameObjectId(fam._id, validatedFamilyId ?? null)
          ) {
            const famSnap = captureFamilySnapshot(fam);
            txState.familySnapshots.push(famSnap);
            fam.representativeId = null;
            await fam.save(session ? { session } : undefined);
            famSnap.expectedUpdatedAt = fam.updatedAt;
          }
        }
      }

      if (hasEmailChange) participant.email = nextEmail;
      if (parsed.name !== undefined) participant.name = parsed.name;
      if (parsed.phone !== undefined) participant.phone = parsed.phone;
      participant.role = resolvedNextRole;
      if (parsed.memberType !== undefined) participant.memberType = parsed.memberType;
      if (parsed.defaultWeight !== undefined) participant.defaultWeight = parsed.defaultWeight;
      if (parsed.isActive !== undefined) participant.isActive = parsed.isActive;
      if (validatedFamilyId !== undefined) {
        participant.familyId = validatedFamilyId;
      }

      await participant.save(session ? { session } : undefined);
      participantSnap.expectedUpdatedAt = participant.updatedAt;

      // Revoke pending invites when deactivated, or pending FAMILY_REP invites when moved/demoted.
      if (isDeactivating) {
        const revoked = await revokePendingParticipantInvites({
          tripId: trip._id,
          participantIds: [participant._id],
          actorParticipantId: actor._id,
          session,
        });
        if (revoked) txState.revokedInvites.push(revoked);
      } else if (familyChanged || isDemotingFromFamilyRep) {
        const revoked = await revokePendingParticipantInvites({
          tripId: trip._id,
          participantIds: [participant._id],
          actorParticipantId: actor._id,
          grantedRole: 'FAMILY_REP',
          session,
        });
        if (revoked) txState.revokedInvites.push(revoked);
      }

      // Post-write invariant assertion (belt-and-suspenders) inside serialized scope
      if (wasActiveLinkedOrganizer) {
        const remainingLinkedOrganizers = await countActiveLinkedOrganizers(trip._id, {
          session,
        });
        if (remainingLinkedOrganizers < 1) {
          throw new AppError(
            'Cannot demote or deactivate the sole active linked organizer of the trip.',
            400,
            'SOLE_ORGANIZER'
          );
        }
      }

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'PARTICIPANT_UPDATED',
        entityType: 'PARTICIPANT',
        entityId: participant._id,
        summary: `${freshActor.name} updated participant "${participant.name}".`,
        session,
      });
      txState.loggedActivity = true;

      txState.updatedParticipant = participant;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      await restoreRevokedInviteRecords(txState.revokedInvites);
      await restoreFamilySnapshots(txState.familySnapshots);
      await restoreParticipantSnapshots(txState.participantSnapshots);
    },
  });

  if (!txState.updatedParticipant) {
    throw new AppError('Failed to update participant.', 500, 'INTERNAL_SERVER_ERROR');
  }
  const participant = txState.updatedParticipant;

  sendSuccess(res, {
    participant: formatParticipantDoc(participant),
  });
});

export const removeParticipant = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { participantId } = req.params;

  if (typeof participantId !== 'string' || !mongoose.Types.ObjectId.isValid(participantId)) {
    throw new AppError('Invalid participant identifier format.', 400, 'INVALID_ID');
  }

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    deletedSnapshot?: Record<string, unknown>;
    deletedParticipantStarted: boolean;
    loggedActivity: boolean;
    familySnapshots: FamilyUpdateSnapshot[];
    revokedInvites: RevokedInviteRollbackRecord[];
  } = {
    deletedParticipantStarted: false,
    loggedActivity: false,
    familySnapshots: [],
    revokedInvites: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.deletedSnapshot = undefined;
      txState.deletedParticipantStarted = false;
      txState.loggedActivity = false;
      txState.familySnapshots = [];
      txState.revokedInvites = [];

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);

      const participant = await ParticipantModel.findOne({
        _id: participantId,
        tripId: trip._id,
      }).session(session);
      if (!participant) {
        throw new AppError('Participant not found.', 404, 'PARTICIPANT_NOT_FOUND');
      }

      const wasActiveLinkedOrganizer = isActiveLinkedOrganizer(participant);
      if (participant.role === 'ORGANIZER') {
        const otherLinkedOrganizers = await countActiveLinkedOrganizers(trip._id, {
          excludeParticipantId: participant._id,
          session,
        });
        if (otherLinkedOrganizers === 0) {
          throw new AppError(
            'Cannot remove the sole active linked organizer of the trip.',
            400,
            'SOLE_ORGANIZER'
          );
        }
      }

      // Check if participant has active financial records inside the serialized snapshot
      const [hasPayments, hasShares, hasSettlements] = await Promise.all([
        ExpensePaymentModel.findOne({ tripId: trip._id, participantId: participant._id })
          .select('_id')
          .session(session)
          .lean(),
        ExpenseShareModel.findOne({ tripId: trip._id, participantId: participant._id })
          .select('_id')
          .session(session)
          .lean(),
        SettlementModel.findOne({
          tripId: trip._id,
          $or: [
            { fromParticipantId: participant._id },
            { toParticipantId: participant._id },
          ],
          isDeleted: false,
        })
          .select('_id')
          .session(session)
          .lean(),
      ]);

      if (hasPayments || hasShares || hasSettlements) {
        throw new AppError(
          'Cannot remove a participant who is already included in expenses or settlements.',
          400,
          'PARTICIPANT_HAS_FINANCIAL_RECORDS'
        );
      }

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

      txState.deletedSnapshot = participant.toObject() as unknown as Record<string, unknown>;
      txState.deletedParticipantStarted = true;

      await ParticipantModel.deleteOne(
        { _id: participant._id },
        session ? { session } : undefined
      );

      // Post-write invariant assertion BEFORE finalizing invites/logs
      if (wasActiveLinkedOrganizer) {
        const remainingLinkedOrganizers = await countActiveLinkedOrganizers(trip._id, {
          session,
        });
        if (remainingLinkedOrganizers < 1) {
          throw new AppError(
            'Cannot remove the sole active linked organizer of the trip.',
            400,
            'SOLE_ORGANIZER'
          );
        }
      }

      const revoked = await revokePendingParticipantInvites({
        tripId: trip._id,
        participantIds: [participant._id],
        actorParticipantId: freshActor._id,
        session,
      });
      if (revoked) txState.revokedInvites.push(revoked);

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'PARTICIPANT_REMOVED',
        entityType: 'PARTICIPANT',
        entityId: participant._id,
        summary: `${freshActor.name} removed participant "${participant.name}".`,
        session,
      });
      txState.loggedActivity = true;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      await restoreRevokedInviteRecords(txState.revokedInvites);
      await restoreFamilySnapshots(txState.familySnapshots);
      if (!txState.deletedParticipantStarted || !txState.deletedSnapshot) return;
      const { _id, ...rest } = txState.deletedSnapshot;
      await ParticipantModel.collection.updateOne(
        { _id: _id as mongoose.Types.ObjectId },
        { $setOnInsert: rest },
        { upsert: true }
      );
    },
  });

  sendSuccess(res, { removedId: participantId });
});

export const createFamily = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const parsed = createFamilySchema.parse(req.body);

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    createdFamily?: IFamily;
    loggedActivity: boolean;
    participantSnapshots: ParticipantUpdateSnapshot[];
    revokedInvites: RevokedInviteRollbackRecord[];
  } = {
    loggedActivity: false,
    participantSnapshots: [],
    revokedInvites: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.createdFamily = undefined;
      txState.loggedActivity = false;
      txState.participantSnapshots = [];
      txState.revokedInvites = [];

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);

      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (liveTrip.mode !== 'FAMILY') {
        throw new AppError(
          'Family groups can only be created in Family Mode trips.',
          400,
          'FAMILY_MODE_ONLY'
        );
      }

      const trimmedRepId = parsed.representativeId?.trim() || null;
      let repParticipant: IParticipant | null = null;
      if (trimmedRepId) {
        repParticipant = await assertActiveRepresentativeCandidateInTrip(
          trip._id,
          trimmedRepId,
          session
        );
        await assertParticipantEligibleAsFamilyRepresentative({
          trip: liveTrip,
          participant: repParticipant,
          session,
        });
      }

      const existing = await FamilyModel.findOne({
        tripId: trip._id,
        name: parsed.name,
      }).session(session);
      if (existing) {
        throw new AppError(
          'A family group with this name already exists in this trip.',
          409,
          'FAMILY_EXISTS'
        );
      }

      let family: IFamily;
      try {
        const [created] = await FamilyModel.create(
          [
            {
              tripId: trip._id,
              name: parsed.name,
              representativeId: repParticipant ? repParticipant._id : null,
              defaultWeight: parsed.defaultWeight,
              notes: parsed.notes,
            },
          ],
          session ? { session } : undefined
        );
        family = created;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new AppError(
            'A family group with this name already exists in this trip.',
            409,
            'FAMILY_EXISTS'
          );
        }
        throw err;
      }
      txState.createdFamily = family;

      if (repParticipant) {
        const hadDifferentFamily = !sameObjectId(repParticipant.familyId ?? null, family._id);
        const repSnap = captureParticipantUpdateSnapshot(repParticipant);
        txState.participantSnapshots.push(repSnap);
        repParticipant.familyId = family._id;
        await repParticipant.save(session ? { session } : undefined);
        repSnap.expectedUpdatedAt = repParticipant.updatedAt;

        if (hadDifferentFamily) {
          const revoked = await revokePendingParticipantInvites({
            tripId: trip._id,
            participantIds: [repParticipant._id],
            actorParticipantId: freshActor._id,
            grantedRole: 'FAMILY_REP',
            session,
          });
          if (revoked) txState.revokedInvites.push(revoked);
        }
      }

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'FAMILY_CREATED',
        entityType: 'FAMILY',
        entityId: family._id,
        summary: `${freshActor.name} created family group "${family.name}".`,
        session,
      });
      txState.loggedActivity = true;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      await restoreRevokedInviteRecords(txState.revokedInvites);
      await restoreParticipantSnapshots(txState.participantSnapshots);
      if (txState.createdFamily) {
        await FamilyModel.deleteOne({ _id: txState.createdFamily._id });
      }
    },
  });

  if (!txState.createdFamily) {
    throw new AppError('Failed to create family group.', 500, 'INTERNAL_SERVER_ERROR');
  }
  const family = txState.createdFamily;

  sendSuccess(
    res,
    {
      family: {
        id: family._id.toString(),
        tripId: family.tripId.toString(),
        name: family.name,
        representativeId: family.representativeId ? family.representativeId.toString() : null,
        defaultWeight: family.defaultWeight,
        notes: family.notes,
      },
    },
    201
  );
});

export const updateFamily = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { familyId } = req.params;
  const parsed = updateFamilySchema.parse(req.body);

  if (typeof familyId !== 'string' || !mongoose.Types.ObjectId.isValid(familyId)) {
    throw new AppError('Invalid family identifier format.', 400, 'INVALID_ID');
  }

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    updatedFamily?: IFamily;
    loggedActivity: boolean;
    familySnapshots: FamilyUpdateSnapshot[];
    participantSnapshots: ParticipantUpdateSnapshot[];
    revokedInvites: RevokedInviteRollbackRecord[];
  } = {
    loggedActivity: false,
    familySnapshots: [],
    participantSnapshots: [],
    revokedInvites: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.updatedFamily = undefined;
      txState.loggedActivity = false;
      txState.familySnapshots = [];
      txState.participantSnapshots = [];
      txState.revokedInvites = [];

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);

      const [liveTrip, family] = await Promise.all([
        TripModel.findById(trip._id).session(session),
        FamilyModel.findOne({ _id: familyId, tripId: trip._id }).session(session),
      ]);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (liveTrip.mode !== 'FAMILY') {
        throw new AppError(
          'Family groups are only supported in Family Mode trips.',
          400,
          'FAMILY_MODE_ONLY'
        );
      }
      if (!family) {
        throw new AppError('Family group not found.', 404, 'FAMILY_NOT_FOUND');
      }

      // Check duplicate name BEFORE mutating participants/families or revoking invitations.
      if (parsed.name !== undefined && parsed.name !== family.name) {
        const duplicateFamily = await FamilyModel.findOne({
          _id: { $ne: family._id },
          tripId: trip._id,
          name: parsed.name,
        }).session(session);
        if (duplicateFamily) {
          throw new AppError(
            'A family group with this name already exists in this trip.',
            409,
            'FAMILY_EXISTS'
          );
        }
      }

      let newRepParticipant: IParticipant | null = null;
      let isRepChanging = false;
      let isRehomingNewRep = false;
      let newRepObjectId: mongoose.Types.ObjectId | null = null;
      const previousRepId = family.representativeId ?? null;

      if (parsed.representativeId !== undefined) {
        const trimmedRepId = parsed.representativeId?.trim() || null;
        if (trimmedRepId) {
          newRepParticipant = await assertActiveRepresentativeCandidateInTrip(
            trip._id,
            trimmedRepId,
            session
          );
          await assertParticipantEligibleAsFamilyRepresentative({
            trip: liveTrip,
            participant: newRepParticipant,
            targetFamilyId: family._id,
            session,
          });
        }
        newRepObjectId = newRepParticipant ? newRepParticipant._id : null;
        isRepChanging = !sameObjectId(previousRepId, newRepObjectId);
        isRehomingNewRep =
          Boolean(newRepParticipant) &&
          !sameObjectId(newRepParticipant!.familyId ?? null, family._id);
      }

      const famSnap = captureFamilySnapshot(family);
      txState.familySnapshots.push(famSnap);

      if (parsed.name !== undefined) family.name = parsed.name;
      if (parsed.defaultWeight !== undefined) family.defaultWeight = parsed.defaultWeight;
      if (parsed.notes !== undefined) family.notes = parsed.notes;

      const saveFamilyHandlingDuplicate = async () => {
        try {
          await family.save(session ? { session } : undefined);
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            throw new AppError(
              'A family group with this name already exists in this trip.',
              409,
              'FAMILY_EXISTS'
            );
          }
          throw err;
        }
      };

      const revokeTargets = new Set<string>();

      if (parsed.representativeId !== undefined) {
        if (isRepChanging) {
          const touchedRepIds = new Set<string>();

          if (previousRepId) {
            const prevRep = await ParticipantModel.findOne({
              _id: previousRepId,
              tripId: trip._id,
            }).session(session);
            if (prevRep) {
              touchedRepIds.add(prevRep._id.toString());
              if (prevRep.role === 'FAMILY_REP') {
                const prevSnap = captureParticipantUpdateSnapshot(prevRep);
                txState.participantSnapshots.push(prevSnap);
                prevRep.role = DEFAULT_OPEN_INVITE_ROLE;
                await prevRep.save(session ? { session } : undefined);
                prevSnap.expectedUpdatedAt = prevRep.updatedAt;
              }
              revokeTargets.add(prevRep._id.toString());
            }
          }

          // Clear any other lingering FAMILY_REP holders on this family so at most one rep exists.
          const lingeringFamilyReps = await ParticipantModel.find({
            tripId: trip._id,
            familyId: family._id,
            role: 'FAMILY_REP',
            ...(newRepObjectId ? { _id: { $ne: newRepObjectId } } : {}),
          }).session(session);
          for (const extraRep of lingeringFamilyReps) {
            if (!touchedRepIds.has(extraRep._id.toString())) {
              const extraSnap = captureParticipantUpdateSnapshot(extraRep);
              txState.participantSnapshots.push(extraSnap);
              extraRep.role = DEFAULT_OPEN_INVITE_ROLE;
              await extraRep.save(session ? { session } : undefined);
              extraSnap.expectedUpdatedAt = extraRep.updatedAt;
            }
            revokeTargets.add(extraRep._id.toString());
          }

          // Collect pending FAMILY_REP invite targets for existing family members (excluding same-family nominee).
          const familyMembers = await ParticipantModel.find({
            tripId: trip._id,
            familyId: family._id,
            ...(newRepObjectId ? { _id: { $ne: newRepObjectId } } : {}),
          })
            .select('_id')
            .session(session);
          for (const fm of familyMembers) {
            revokeTargets.add(fm._id.toString());
          }
        }

        if (isRehomingNewRep && newRepObjectId) {
          revokeTargets.add(newRepObjectId.toString());
        }

        // Preserve existing role on newRepParticipant (do NOT auto-grant FAMILY_REP on family PATCH).
        family.representativeId = newRepObjectId;
        await saveFamilyHandlingDuplicate();
        famSnap.expectedUpdatedAt = family.updatedAt;

        if (newRepParticipant && isRehomingNewRep) {
          const repSnap = captureParticipantUpdateSnapshot(newRepParticipant);
          txState.participantSnapshots.push(repSnap);
          newRepParticipant.familyId = family._id;
          await newRepParticipant.save(session ? { session } : undefined);
          repSnap.expectedUpdatedAt = newRepParticipant.updatedAt;
        }
      } else {
        await saveFamilyHandlingDuplicate();
        famSnap.expectedUpdatedAt = family.updatedAt;
      }

      if (revokeTargets.size > 0) {
        const revoked = await revokePendingParticipantInvites({
          tripId: trip._id,
          participantIds: Array.from(revokeTargets).map((id) => new mongoose.Types.ObjectId(id)),
          actorParticipantId: freshActor._id,
          grantedRole: 'FAMILY_REP',
          session,
        });
        if (revoked) txState.revokedInvites.push(revoked);
      }

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'FAMILY_UPDATED',
        entityType: 'FAMILY',
        entityId: family._id,
        summary: `${freshActor.name} updated family group "${family.name}".`,
        session,
      });
      txState.loggedActivity = true;

      txState.updatedFamily = family;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      await restoreRevokedInviteRecords(txState.revokedInvites);
      await restoreParticipantSnapshots(txState.participantSnapshots);
      await restoreFamilySnapshots(txState.familySnapshots);
    },
  });

  if (!txState.updatedFamily) {
    throw new AppError('Failed to update family group.', 500, 'INTERNAL_SERVER_ERROR');
  }
  const family = txState.updatedFamily;

  sendSuccess(res, {
    family: {
      id: family._id.toString(),
      tripId: family.tripId.toString(),
      name: family.name,
      representativeId: family.representativeId ? family.representativeId.toString() : null,
      defaultWeight: family.defaultWeight,
      notes: family.notes,
    },
  });
});

export const deleteFamily = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { familyId } = req.params;

  if (typeof familyId !== 'string' || !mongoose.Types.ObjectId.isValid(familyId)) {
    throw new AppError('Invalid family identifier format.', 400, 'INVALID_ID');
  }

  const activityLogId = new mongoose.Types.ObjectId();
  const txState: {
    deletedFamilySnapshot?: Record<string, unknown>;
    deletedFamilyStarted: boolean;
    loggedActivity: boolean;
    participantSnapshots: ParticipantUpdateSnapshot[];
    revokedInvites: RevokedInviteRollbackRecord[];
  } = {
    deletedFamilyStarted: false,
    loggedActivity: false,
    participantSnapshots: [],
    revokedInvites: [],
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.deletedFamilySnapshot = undefined;
      txState.deletedFamilyStarted = false;
      txState.loggedActivity = false;
      txState.participantSnapshots = [];
      txState.revokedInvites = [];

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);

      const [liveTrip, family] = await Promise.all([
        TripModel.findById(trip._id).session(session),
        FamilyModel.findOne({ _id: familyId, tripId: trip._id }).session(session),
      ]);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }
      if (liveTrip.mode !== 'FAMILY') {
        throw new AppError(
          'Family groups are only supported in Family Mode trips.',
          400,
          'FAMILY_MODE_ONLY'
        );
      }
      if (!family) {
        throw new AppError('Family group not found.', 404, 'FAMILY_NOT_FOUND');
      }

      const members = await ParticipantModel.find({
        tripId: trip._id,
        familyId: family._id,
      }).session(session);
      txState.deletedFamilySnapshot = family.toObject() as unknown as Record<string, unknown>;

      for (const member of members) {
        const snap = captureParticipantUpdateSnapshot(member);
        txState.participantSnapshots.push(snap);
        member.familyId = null;
        if (member.role === 'FAMILY_REP') {
          member.role = DEFAULT_OPEN_INVITE_ROLE;
        }
        await member.save(session ? { session } : undefined);
        snap.expectedUpdatedAt = member.updatedAt;
      }

      const revoked = await revokePendingParticipantInvites({
        tripId: trip._id,
        participantIds: members.map((m) => m._id),
        actorParticipantId: freshActor._id,
        grantedRole: 'FAMILY_REP',
        session,
      });
      if (revoked) txState.revokedInvites.push(revoked);

      txState.deletedFamilyStarted = true;
      await FamilyModel.deleteOne({ _id: family._id }, session ? { session } : undefined);

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'FAMILY_DELETED',
        entityType: 'FAMILY',
        entityId: family._id,
        summary: `${freshActor.name} deleted family group "${family.name}".`,
        session,
      });
      txState.loggedActivity = true;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      await restoreRevokedInviteRecords(txState.revokedInvites);
      if (txState.deletedFamilyStarted && txState.deletedFamilySnapshot) {
        const { _id, ...rest } = txState.deletedFamilySnapshot;
        await FamilyModel.collection.updateOne(
          { _id: _id as mongoose.Types.ObjectId },
          { $setOnInsert: rest },
          { upsert: true }
        );
      }
      await restoreParticipantSnapshots(txState.participantSnapshots);
    },
  });

  sendSuccess(res, { deletedId: familyId });
});

export const updateChecklistItem = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const parsed = updateChecklistItemSchema.parse(req.body);

  let updatedChecklist: ITrip['checklist'] | undefined;

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      updatedChecklist = undefined;
      await assertFreshActiveOrganizerActor(trip._id, actor._id, session);
      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }

      const item = liveTrip.checklist.find((c) => c.category === parsed.category);
      if (!item) {
        throw new AppError('Checklist category not found.', 404, 'CHECKLIST_ITEM_NOT_FOUND');
      }

      if (parsed.checked !== undefined) item.checked = parsed.checked;
      if (parsed.notApplicable !== undefined) item.notApplicable = parsed.notApplicable;
      item.verifiedAt = item.checked || item.notApplicable ? new Date() : null;

      await liveTrip.save(session ? { session } : undefined);
      updatedChecklist = liveTrip.checklist;
    },
    rollback: async () => {
      // Single-document save in transaction or serialized lease requires no separate revert.
    },
  });

  sendSuccess(res, { checklist: updatedChecklist ?? trip.checklist });
});

export const closeTrip = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const forceClose = req.body?.forceClose === true;
  const activityLogId = new mongoose.Types.ObjectId();

  const txState: {
    closedTrip?: ITrip;
    writtenUpdatedAt?: Date;
    loggedActivity: boolean;
    previousCloseState?: {
      status: ITrip['status'];
      closedAt: Date | null;
      inviteEnabled: boolean;
    };
  } = {
    loggedActivity: false,
  };

  await runSerializedTripOrganizerMutation({
    tripId: trip._id,
    work: async (session) => {
      txState.closedTrip = undefined;
      txState.writtenUpdatedAt = undefined;
      txState.loggedActivity = false;
      txState.previousCloseState = undefined;

      const freshActor = await assertFreshActiveOrganizerActor(trip._id, actor._id, session);
      const liveTrip = await TripModel.findById(trip._id).session(session);
      if (!liveTrip) {
        throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
      }

      // Check if there are any unapproved or estimated pending expenses
      const pendingExpensesCount = await ExpenseModel.countDocuments({
        tripId: trip._id,
        isDeleted: false,
        $or: [
          { isEstimated: true },
          { approvalStatus: { $in: ['PENDING_APPROVAL', 'PENDING_CONFIRMATION'] } },
        ],
      }).session(session);

      if (pendingExpensesCount > 0 && !forceClose) {
        throw new AppError(
          `There are ${pendingExpensesCount} pending or estimated expenses that require confirmation or approval before closing the trip.`,
          400,
          'PENDING_EXPENSES_EXIST',
          { pendingExpensesCount }
        );
      }

      const unverifiedChecklist = liveTrip.checklist.filter(
        (c) => !c.checked && !c.notApplicable
      );
      if (unverifiedChecklist.length > 0 && !forceClose) {
        throw new AppError(
          `Please review the Forgotten Expense Protection checklist (${unverifiedChecklist.length} categories remaining) before closing the trip.`,
          400,
          'CHECKLIST_INCOMPLETE',
          { unverifiedCategories: unverifiedChecklist.map((c) => c.label) }
        );
      }

      txState.previousCloseState = {
        status: liveTrip.status,
        closedAt: liveTrip.closedAt ?? null,
        inviteEnabled: liveTrip.inviteEnabled,
      };

      liveTrip.status = 'CLOSED';
      liveTrip.closedAt = new Date();
      liveTrip.inviteEnabled = false;
      await liveTrip.save(session ? { session } : undefined);
      txState.writtenUpdatedAt = liveTrip.updatedAt;
      txState.closedTrip = liveTrip;

      await logTripActivity({
        _id: activityLogId,
        tripId: trip._id,
        actorUserId: req.user?.userId,
        actorParticipantId: freshActor._id,
        actorName: freshActor.name,
        actionType: 'TRIP_CLOSED',
        entityType: 'TRIP',
        entityId: liveTrip._id,
        summary: `${freshActor.name} finalized and closed the trip "${liveTrip.name}".`,
        session,
      });
      txState.loggedActivity = true;
    },
    rollback: async () => {
      if (txState.loggedActivity) {
        await ActivityLogModel.deleteOne({ _id: activityLogId });
      }
      if (txState.closedTrip && txState.previousCloseState) {
        await TripModel.updateOne(
          {
            _id: trip._id,
            ...(txState.writtenUpdatedAt ? { updatedAt: txState.writtenUpdatedAt } : {}),
          },
          { $set: txState.previousCloseState }
        );
      }
    },
  });

  if (!txState.closedTrip) {
    throw new AppError('Failed to close trip.', 500, 'INTERNAL_SERVER_ERROR');
  }

  sendSuccess(res, { trip: formatTripDoc(txState.closedTrip, { includeInviteCode: true }) });
});

export function formatParticipantDoc(participant: IParticipant) {
  return {
    id: participant._id.toString(),
    tripId: participant.tripId.toString(),
    userId: participant.userId ? participant.userId.toString() : null,
    familyId: participant.familyId ? participant.familyId.toString() : null,
    name: participant.name,
    email: participant.email,
    phone: participant.phone,
    role: participant.role,
    memberType: participant.memberType,
    defaultWeight: participant.defaultWeight,
    isActive: participant.isActive,
  };
}

export function formatTripDoc(
  trip: ITrip,
  options: { includeInviteCode?: boolean } = {}
) {
  const includeInviteCode = options.includeInviteCode ?? false;
  return {
    id: trip._id.toString(),
    name: trip.name,
    description: trip.description,
    mode: trip.mode,
    status: trip.status,
    currency: trip.currency,
    budgetPaisa: trip.budgetPaisa,
    startDate: trip.startDate ? trip.startDate.toISOString() : undefined,
    endDate: trip.endDate ? trip.endDate.toISOString() : undefined,
    createdBy: trip.createdBy.toString(),
    ...(includeInviteCode ? { inviteCode: trip.inviteCode } : {}),
    inviteEnabled: trip.inviteEnabled !== false,
    inviteExpiresAt: trip.inviteExpiresAt ? trip.inviteExpiresAt.toISOString() : null,
    inviteCodeRotatedAt: trip.inviteCodeRotatedAt
      ? trip.inviteCodeRotatedAt.toISOString()
      : null,
    defaultInviteRole: trip.defaultInviteRole ?? DEFAULT_OPEN_INVITE_ROLE,
    shareToken: trip.shareToken,
    shareEnabled: trip.shareEnabled,
    checklist: trip.checklist,
    closedAt: trip.closedAt ? trip.closedAt.toISOString() : null,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}
