import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  createFamilySchema,
  createParticipantSchema,
  createTripSchema,
  DEFAULT_OPEN_INVITE_ROLE,
  EXPENSE_CATEGORY_LABELS,
  FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES,
  joinTripSchema,
  updateChecklistItemSchema,
  updateFamilySchema,
  updateParticipantSchema,
  updateTripSchema,
} from '@tripledger/shared';
import {
  ExpenseModel,
  ExpensePaymentModel,
  ExpenseShareModel,
  FamilyModel,
  ParticipantModel,
  SettlementModel,
  TripModel,
  type IParticipant,
  type ITrip,
} from '../models/index.js';
import { loadTripLedgerData, logTripActivity } from '../services/ledgerService.js';
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
      trip: formatTripDoc(trip),
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
        ...formatTripDoc(trip),
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
    trip: formatTripDoc(trip),
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

  const wasClosed = trip.status === 'CLOSED';
  const targetStatus = parsed.status ?? trip.status;

  if (targetStatus === 'CLOSED' && parsed.inviteEnabled === true) {
    throw new AppError(
      'Open invite-code joining cannot be enabled while a trip is closed.',
      400,
      'INVITE_NOT_ALLOWED_ON_CLOSED_TRIP'
    );
  }

  if (parsed.name !== undefined) trip.name = parsed.name;
  if (parsed.description !== undefined) trip.description = parsed.description;
  if (parsed.budgetPaisa !== undefined) trip.budgetPaisa = parsed.budgetPaisa;
  if (parsed.startDate !== undefined) {
    trip.startDate = parsed.startDate ? new Date(parsed.startDate) : undefined;
  }
  if (parsed.endDate !== undefined) {
    trip.endDate = parsed.endDate ? new Date(parsed.endDate) : undefined;
  }
  if (parsed.shareEnabled !== undefined) trip.shareEnabled = parsed.shareEnabled;

  if (parsed.status !== undefined) {
    trip.status = parsed.status;
    if (parsed.status === 'CLOSED') {
      trip.closedAt = trip.closedAt ?? new Date();
      trip.inviteEnabled = false;
    } else if (wasClosed) {
      // Clear archival closure timestamp on organizer reopen; keep inviteEnabled under explicit control.
      trip.closedAt = null;
    }
  }

  if (parsed.inviteEnabled !== undefined && targetStatus !== 'CLOSED') {
    trip.inviteEnabled = parsed.inviteEnabled;
  }
  if (parsed.inviteExpiresAt !== undefined) {
    trip.inviteExpiresAt =
      parsed.inviteExpiresAt === null ? null : new Date(parsed.inviteExpiresAt);
  }

  await trip.save();

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: participant._id,
    actorName: participant.name,
    actionType: 'TRIP_UPDATED',
    entityType: 'TRIP',
    entityId: trip._id,
    summary: `${participant.name} updated trip settings.`,
  });

  sendSuccess(res, { trip: formatTripDoc(trip) });
});

export const joinTripByInviteCode = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  joinTripSchema.parse(req.body ?? {});

  const rawInviteCode = req.params.inviteCode;
  const inviteCode = typeof rawInviteCode === 'string' ? rawInviteCode.trim().toUpperCase() : '';
  const trip = inviteCode ? await TripModel.findOne({ inviteCode }) : null;
  if (!trip) {
    throw new AppError('Invalid or unavailable invite code.', 404, 'TRIP_NOT_FOUND');
  }

  if (trip.status === 'CLOSED') {
    throw new AppError(
      'This trip is closed and no longer accepting new members.',
      403,
      'TRIP_CLOSED'
    );
  }

  if (trip.inviteEnabled === false) {
    throw new AppError(
      'Open invite-code joining is disabled for this trip.',
      403,
      'INVITE_DISABLED'
    );
  }

  if (trip.inviteExpiresAt && trip.inviteExpiresAt.getTime() <= Date.now()) {
    throw new AppError('This invite code has expired.', 403, 'INVITE_EXPIRED');
  }

  // Existing membership check: never reactivate deactivated members via open invite code.
  const existingParticipant = await ParticipantModel.findOne({
    tripId: trip._id,
    userId: req.user.userId,
  });

  if (existingParticipant) {
    if (!existingParticipant.isActive) {
      throw new AppError(
        'Your membership in this trip has been deactivated by an organizer.',
        403,
        'PARTICIPANT_DEACTIVATED'
      );
    }
    sendSuccess(res, {
      trip: formatTripDoc(trip),
      participantId: existingParticipant._id.toString(),
      alreadyJoined: true,
      role: existingParticipant.role,
    });
    return;
  }

  // Open invite-code joins ALWAYS enroll a fresh low-privilege PARTICIPANT record and NEVER
  // auto-link or claim existing guest participant rows by ID or email.
  let participant: IParticipant;
  try {
    participant = await ParticipantModel.create({
      tripId: trip._id,
      userId: req.user.userId,
      name: req.user.name,
      email: req.user.email,
      role: DEFAULT_OPEN_INVITE_ROLE,
      memberType: 'ADULT',
      defaultWeight: 1,
      isActive: true,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const concurrent = await ParticipantModel.findOne({
        tripId: trip._id,
        userId: req.user.userId,
      });
      if (concurrent) {
        if (!concurrent.isActive) {
          throw new AppError(
            'Your membership in this trip has been deactivated by an organizer.',
            403,
            'PARTICIPANT_DEACTIVATED'
          );
        }
        sendSuccess(res, {
          trip: formatTripDoc(trip),
          participantId: concurrent._id.toString(),
          alreadyJoined: true,
          role: concurrent.role,
        });
        return;
      }
    }
    throw err;
  }

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user.userId,
    actorParticipantId: participant._id,
    actorName: req.user.name,
    actionType: 'PARTICIPANT_JOINED',
    entityType: 'PARTICIPANT',
    entityId: participant._id,
    summary: `${req.user.name} joined the trip via invite code.`,
  });

  sendSuccess(res, {
    trip: formatTripDoc(trip),
    participantId: participant._id.toString(),
    alreadyJoined: false,
    role: participant.role,
  });
});

async function assertValidFamilyInTrip(
  tripId: mongoose.Types.ObjectId,
  familyId: string
): Promise<mongoose.Types.ObjectId> {
  if (!mongoose.Types.ObjectId.isValid(familyId)) {
    throw new AppError('Invalid family identifier format.', 400, 'INVALID_ID');
  }
  const family = await FamilyModel.findOne({ _id: familyId, tripId });
  if (!family) {
    throw new AppError(
      'Specified family group does not exist in this trip.',
      404,
      'FAMILY_NOT_FOUND'
    );
  }
  return family._id;
}

async function assertActiveRepresentativeInTrip(
  tripId: mongoose.Types.ObjectId,
  participantId: string
): Promise<mongoose.Types.ObjectId> {
  if (!mongoose.Types.ObjectId.isValid(participantId)) {
    throw new AppError('Invalid representative participant identifier format.', 400, 'INVALID_ID');
  }
  const participant = await ParticipantModel.findOne({
    _id: participantId,
    tripId,
  });
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
  return participant._id;
}

export const addParticipant = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const parsed = createParticipantSchema.parse(req.body);

  const familyObjectId = parsed.familyId
    ? await assertValidFamilyInTrip(trip._id, parsed.familyId)
    : null;

  // Organizers always create unlinked guest records (userId: null); never auto-link by email.
  const participant = await ParticipantModel.create({
    tripId: trip._id,
    userId: null,
    familyId: familyObjectId,
    name: parsed.name,
    email: parsed.email || undefined,
    phone: parsed.phone,
    role: parsed.role,
    memberType: parsed.memberType,
    defaultWeight: parsed.defaultWeight,
    isActive: true,
  });

  // If added as FAMILY_REP and family has no representative yet, assign automatically
  if (parsed.familyId && parsed.role === 'FAMILY_REP') {
    await FamilyModel.findOneAndUpdate(
      { _id: parsed.familyId, tripId: trip._id },
      { $set: { representativeId: participant._id } }
    );
  }

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'PARTICIPANT_ADDED',
    entityType: 'PARTICIPANT',
    entityId: participant._id,
    summary: `${actor.name} added participant "${participant.name}" (${participant.role}).`,
  });

  sendSuccess(
    res,
    {
      participant: {
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
      },
    },
    201
  );
});

export const updateParticipant = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const { participantId } = req.params;
  const parsed = updateParticipantSchema.parse(req.body);

  const participant = await ParticipantModel.findOne({
    _id: participantId,
    tripId: trip._id,
  });
  if (!participant) {
    throw new AppError('Participant not found in this trip.', 404, 'PARTICIPANT_NOT_FOUND');
  }

  let validatedFamilyId: mongoose.Types.ObjectId | null | undefined;
  if (parsed.familyId !== undefined) {
    validatedFamilyId = parsed.familyId
      ? await assertValidFamilyInTrip(trip._id, parsed.familyId)
      : null;
  }

  if (parsed.email !== undefined) {
    const nextEmail = parsed.email || undefined;
    if (participant.userId && nextEmail !== (participant.email || undefined)) {
      throw new AppError(
        'Cannot change email on an already-linked participant record.',
        409,
        'PARTICIPANT_EMAIL_IMMUTABLE_WHILE_LINKED'
      );
    }
    participant.email = nextEmail;
  }

  const nextRole = parsed.role ?? participant.role;
  const nextIsActive = parsed.isActive ?? participant.isActive;
  if (participant.role === 'ORGANIZER' && participant.isActive) {
    if (nextRole !== 'ORGANIZER' || !nextIsActive) {
      const otherActiveOrganizers = await ParticipantModel.countDocuments({
        tripId: trip._id,
        role: 'ORGANIZER',
        _id: { $ne: participant._id },
        isActive: true,
      });
      if (otherActiveOrganizers === 0) {
        throw new AppError(
          'Cannot demote or deactivate the sole active organizer of the trip.',
          400,
          'SOLE_ORGANIZER'
        );
      }
    }
  }

  if (parsed.name !== undefined) participant.name = parsed.name;
  if (parsed.phone !== undefined) participant.phone = parsed.phone;
  if (parsed.role !== undefined) participant.role = parsed.role;
  if (parsed.memberType !== undefined) participant.memberType = parsed.memberType;
  if (parsed.defaultWeight !== undefined) participant.defaultWeight = parsed.defaultWeight;
  if (parsed.isActive !== undefined) participant.isActive = parsed.isActive;
  if (validatedFamilyId !== undefined) {
    participant.familyId = validatedFamilyId;
  }

  await participant.save();

  sendSuccess(res, {
    participant: {
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
    },
  });

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'PARTICIPANT_UPDATED',
    entityType: 'PARTICIPANT',
    entityId: participant._id,
    summary: `${actor.name} updated participant "${participant.name}".`,
  });
});

export const removeParticipant = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const { participantId } = req.params;

  const participant = await ParticipantModel.findOne({
    _id: participantId,
    tripId: trip._id,
  });
  if (!participant) {
    throw new AppError('Participant not found.', 404, 'PARTICIPANT_NOT_FOUND');
  }

  if (participant.role === 'ORGANIZER') {
    const otherOrganizers = await ParticipantModel.countDocuments({
      tripId: trip._id,
      role: 'ORGANIZER',
      _id: { $ne: participant._id },
      isActive: true,
    });
    if (otherOrganizers === 0) {
      throw new AppError('Cannot remove the sole organizer of the trip.', 400, 'SOLE_ORGANIZER');
    }
  }

  // Check if participant has active financial records
  const [hasPayments, hasShares, hasSettlements] = await Promise.all([
    ExpensePaymentModel.exists({ tripId: trip._id, participantId: participant._id }),
    ExpenseShareModel.exists({ tripId: trip._id, participantId: participant._id }),
    SettlementModel.exists({
      tripId: trip._id,
      $or: [
        { fromParticipantId: participant._id },
        { toParticipantId: participant._id },
      ],
      isDeleted: false,
    }),
  ]);

  if (hasPayments || hasShares || hasSettlements) {
    throw new AppError(
      'Cannot remove a participant who is already included in expenses or settlements.',
      400,
      'PARTICIPANT_HAS_FINANCIAL_RECORDS'
    );
  }

  await ParticipantModel.deleteOne({ _id: participant._id });
  sendSuccess(res, { removedId: participantId });
});

export const createFamily = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const parsed = createFamilySchema.parse(req.body);

  const trimmedRepId = parsed.representativeId?.trim() || null;
  const representativeObjectId = trimmedRepId
    ? await assertActiveRepresentativeInTrip(trip._id, trimmedRepId)
    : null;

  const existing = await FamilyModel.findOne({
    tripId: trip._id,
    name: parsed.name,
  });
  if (existing) {
    throw new AppError('A family group with this name already exists in this trip.', 409, 'FAMILY_EXISTS');
  }

  const family = await FamilyModel.create({
    tripId: trip._id,
    name: parsed.name,
    representativeId: representativeObjectId,
    defaultWeight: parsed.defaultWeight,
    notes: parsed.notes,
  });

  if (representativeObjectId) {
    await ParticipantModel.findOneAndUpdate(
      { _id: representativeObjectId, tripId: trip._id },
      { $set: { familyId: family._id } }
    );
  }

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'FAMILY_CREATED',
    entityType: 'FAMILY',
    entityId: family._id,
    summary: `${actor.name} created family group "${family.name}".`,
  });

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
  const { familyId } = req.params;
  const parsed = updateFamilySchema.parse(req.body);

  const family = await FamilyModel.findOne({ _id: familyId, tripId: trip._id });
  if (!family) {
    throw new AppError('Family group not found.', 404, 'FAMILY_NOT_FOUND');
  }

  if (parsed.name !== undefined) family.name = parsed.name;
  if (parsed.defaultWeight !== undefined) family.defaultWeight = parsed.defaultWeight;
  if (parsed.notes !== undefined) family.notes = parsed.notes;
  if (parsed.representativeId !== undefined) {
    const trimmedRepId = parsed.representativeId?.trim() || null;
    const representativeObjectId = trimmedRepId
      ? await assertActiveRepresentativeInTrip(trip._id, trimmedRepId)
      : null;

    family.representativeId = representativeObjectId;
    await family.save();

    if (representativeObjectId) {
      await ParticipantModel.findOneAndUpdate(
        { _id: representativeObjectId, tripId: trip._id },
        { $set: { familyId: family._id } }
      );
    }
  } else {
    await family.save();
  }

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
  const { familyId } = req.params;

  const family = await FamilyModel.findOne({ _id: familyId, tripId: trip._id });
  if (!family) {
    throw new AppError('Family group not found.', 404, 'FAMILY_NOT_FOUND');
  }

  // Unassign any members in this family rather than deleting them
  await ParticipantModel.updateMany(
    { tripId: trip._id, familyId: family._id },
    { $set: { familyId: null } }
  );

  await FamilyModel.deleteOne({ _id: family._id });
  sendSuccess(res, { deletedId: familyId });
});

export const updateChecklistItem = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const parsed = updateChecklistItemSchema.parse(req.body);

  const item = trip.checklist.find((c) => c.category === parsed.category);
  if (!item) {
    throw new AppError('Checklist category not found.', 404, 'CHECKLIST_ITEM_NOT_FOUND');
  }

  if (parsed.checked !== undefined) item.checked = parsed.checked;
  if (parsed.notApplicable !== undefined) item.notApplicable = parsed.notApplicable;
  item.verifiedAt = item.checked || item.notApplicable ? new Date() : null;

  await trip.save();

  sendSuccess(res, { checklist: trip.checklist });
});

export const closeTrip = asyncHandler(async (req: Request, res: Response) => {
  const trip = req.trip!;
  const actor = req.participant!;
  const forceClose = req.body?.forceClose === true;

  // Check if there are any unapproved or estimated pending expenses
  const pendingExpensesCount = await ExpenseModel.countDocuments({
    tripId: trip._id,
    isDeleted: false,
    $or: [
      { isEstimated: true },
      { approvalStatus: { $in: ['PENDING_APPROVAL', 'PENDING_CONFIRMATION'] } },
    ],
  });

  if (pendingExpensesCount > 0 && !forceClose) {
    throw new AppError(
      `There are ${pendingExpensesCount} pending or estimated expenses that require confirmation or approval before closing the trip.`,
      400,
      'PENDING_EXPENSES_EXIST',
      { pendingExpensesCount }
    );
  }

  const unverifiedChecklist = trip.checklist.filter(
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

  trip.status = 'CLOSED';
  trip.closedAt = new Date();
  trip.inviteEnabled = false;
  await trip.save();

  await logTripActivity({
    tripId: trip._id,
    actorUserId: req.user?.userId,
    actorParticipantId: actor._id,
    actorName: actor.name,
    actionType: 'TRIP_CLOSED',
    entityType: 'TRIP',
    entityId: trip._id,
    summary: `${actor.name} finalized and closed the trip "${trip.name}".`,
  });

  sendSuccess(res, { trip: formatTripDoc(trip) });
});

export function formatTripDoc(trip: ITrip) {
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
    inviteCode: trip.inviteCode,
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
