import mongoose, { Schema, type Document } from 'mongoose';
import {
  isPrivilegedTripRole,
  resolveParticipantInvitePolicy,
  TRIP_ROLES,
  type TripRole,
} from '@tripledger/shared';
import {
  assertQueryUpdatePreservesImmutableFields,
  isMongooseQueryContext,
  isPlainObjectRecord,
  isValidNonNaNDate,
} from './updateGuards.js';

export interface IParticipantInvite extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  participantId: mongoose.Types.ObjectId;
  familyId?: mongoose.Types.ObjectId | null;
  invitedByUserId: mongoose.Types.ObjectId;
  invitedByParticipantId: mongoose.Types.ObjectId;
  tokenHash: string;
  intendedEmail: string | null;
  grantedRole: TripRole;
  requireVerifiedEmail: boolean;
  expiresAt: Date;
  usedAt?: Date | null;
  usedByUserId?: mongoose.Types.ObjectId | null;
  revokedAt?: Date | null;
  revokedByParticipantId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PARTICIPANT_INVITE_TOKEN_INDEX_NAME = 'tokenHash_unique';
export const PARTICIPANT_INVITE_EMAIL_PENDING_INDEX_NAME = 'intendedEmail_pending_idx';

const IMMUTABLE_INVITE_FIELDS = new Set<string>([
  'tripId',
  'participantId',
  'familyId',
  'invitedByUserId',
  'invitedByParticipantId',
  'tokenHash',
  'intendedEmail',
  'grantedRole',
  'requireVerifiedEmail',
  'expiresAt',
]);

const MUTABLE_LIFECYCLE_FIELDS = [
  'usedAt',
  'usedByUserId',
  'revokedAt',
  'revokedByParticipantId',
] as const;

const PERSISTED_INVITE_STATE = Symbol('persistedInviteState');

interface PersistedInviteLifecycleSnapshot {
  usedAtMs: number | null;
  usedByUserId: string | null;
  revokedAtMs: number | null;
  revokedByParticipantId: string | null;
}

function captureLifecycleSnapshot(doc: IParticipantInvite): PersistedInviteLifecycleSnapshot {
  const parsedUsed = parseDateValue(doc.usedAt);
  const parsedRevoked = parseDateValue(doc.revokedAt);
  return {
    usedAtMs: parsedUsed ? parsedUsed.getTime() : null,
    usedByUserId: doc.usedByUserId ? doc.usedByUserId.toString() : null,
    revokedAtMs: parsedRevoked ? parsedRevoked.getTime() : null,
    revokedByParticipantId: doc.revokedByParticipantId
      ? doc.revokedByParticipantId.toString()
      : null,
  };
}

function parseDateValue(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * NOTE ON ENFORCEMENT BOUNDARIES:
 * - Database-enforced (MongoDB indexes): `tokenHash` uniqueness (`tokenHash_unique`).
 * - Application-enforced (Mongoose hooks/validators + `@tripledger/shared`): privileged-role
 *   email & verified-email policy, expiration bounds, SHA-256 hash formatting, immutability,
 *   and single-use/revocation lifecycle consistency. Raw MongoDB collection writes bypass
 *   Mongoose middleware because collections do not carry Mongo `$jsonSchema` rules.
 */
const participantInviteSchema = new Schema<IParticipantInvite>(
  {
    tripId: {
      type: Schema.Types.ObjectId,
      ref: 'Trip',
      required: true,
      immutable: true,
      index: true,
    },
    participantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      required: true,
      immutable: true,
      index: true,
    },
    familyId: {
      type: Schema.Types.ObjectId,
      ref: 'Family',
      default: null,
      immutable: true,
    },
    invitedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    invitedByParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      required: true,
      immutable: true,
    },
    tokenHash: {
      type: String,
      required: true,
      select: false,
      immutable: true,
      validate: {
        validator: (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
        message: 'tokenHash must be a 64-character lowercase SHA-256 hex digest',
      },
    },
    intendedEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      immutable: true,
      validate: {
        validator: function (this: unknown, v: string | null | undefined) {
          // Reject Query contexts explicitly rather than misreading `this.grantedRole` as undefined.
          if (isMongooseQueryContext(this)) {
            return false;
          }
          const doc = this as IParticipantInvite;
          const trimmed = typeof v === 'string' ? v.trim() : '';
          if (!trimmed) {
            return !isPrivilegedTripRole(doc.grantedRole);
          }
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
        },
        message: 'A valid intendedEmail is required for email-bound and privileged invitations',
      },
    },
    grantedRole: {
      type: String,
      enum: TRIP_ROLES,
      required: true,
      immutable: true,
    },
    requireVerifiedEmail: {
      type: Boolean,
      required: true,
      immutable: true,
      validate: {
        validator: function (this: unknown, v: boolean) {
          if (isMongooseQueryContext(this)) {
            return false;
          }
          const doc = this as IParticipantInvite;
          if (isPrivilegedTripRole(doc.grantedRole)) {
            return v === true;
          }
          const hasEmail =
            typeof doc.intendedEmail === 'string' && doc.intendedEmail.trim().length > 0;
          return !hasEmail || v === true;
        },
        message: 'requireVerifiedEmail must be true for privileged or email-bound invitations',
      },
    },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
      validate: {
        validator: function (this: unknown, v: unknown) {
          if (isMongooseQueryContext(this)) {
            return false;
          }
          if (!isValidNonNaNDate(v)) {
            return false;
          }
          if (
            typeof this === 'object' &&
            this !== null &&
            (this as { isNew?: boolean }).isNew === true
          ) {
            return v.getTime() > Date.now();
          }
          return true;
        },
        message: 'expiresAt must be a valid future Date on creation',
      },
    },
    usedAt: { type: Date, default: null },
    usedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    revokedAt: { type: Date, default: null },
    revokedByParticipantId: { type: Schema.Types.ObjectId, ref: 'Participant', default: null },
  },
  { timestamps: true }
);

function applyInviteDocumentPolicyAndLifecycleChecks(
  doc: {
    grantedRole: TripRole;
    intendedEmail?: string | null;
    requireVerifiedEmail?: boolean;
    expiresAt?: unknown;
    isNew?: boolean;
    usedAt?: unknown;
    usedByUserId?: unknown;
    revokedAt?: unknown;
    revokedByParticipantId?: unknown;
    isSelected?: (path: string) => boolean;
    isModified?: (path?: string) => boolean;
    invalidate?: (path: string, msg: string) => void;
  }
): void {
  const fail = (field: string, msg: string) => {
    if (doc.invalidate) {
      doc.invalidate(field, msg);
      return;
    }
    throw new Error(`${field}: ${msg}`);
  };

  const isPresent = (field: string): boolean => {
    if (doc.isNew !== false) return true;
    return Boolean(doc.isSelected?.(field) || doc.isModified?.(field));
  };

  if (
    doc.isNew !== false ||
    (isPresent('grantedRole') && isPresent('intendedEmail') && isPresent('requireVerifiedEmail'))
  ) {
    try {
      const policy = resolveParticipantInvitePolicy({
        role: doc.grantedRole,
        intendedEmail: doc.intendedEmail,
        requireVerifiedEmail: doc.requireVerifiedEmail,
      });
      doc.intendedEmail = policy.intendedEmail;
      doc.requireVerifiedEmail = policy.requireVerifiedEmail;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid participant invite policy';
      if (
        message.includes('require email verification') ||
        message.includes('verified email ownership')
      ) {
        fail('requireVerifiedEmail', message);
      } else {
        fail('intendedEmail', message);
      }
    }
  }

  if (isPresent('expiresAt')) {
    const parsedExpiresAt = parseDateValue(doc.expiresAt);
    if (!parsedExpiresAt) {
      fail('expiresAt', 'expiresAt must be a valid Date');
    } else if (doc.isNew && parsedExpiresAt.getTime() <= Date.now()) {
      fail('expiresAt', 'Invite expiration must be in the future');
    }
  }

  const usedAtPresent = isPresent('usedAt');
  const usedByPresent = isPresent('usedByUserId');
  const revokedAtPresent = isPresent('revokedAt');
  const revokedByPresent = isPresent('revokedByParticipantId');

  const hasUsedAt = usedAtPresent && doc.usedAt !== undefined && doc.usedAt !== null;
  const hasUsedByUserId =
    usedByPresent && doc.usedByUserId !== undefined && doc.usedByUserId !== null;
  const hasRevokedAt = revokedAtPresent && doc.revokedAt !== undefined && doc.revokedAt !== null;
  const hasRevokedBy =
    revokedByPresent &&
    doc.revokedByParticipantId !== undefined &&
    doc.revokedByParticipantId !== null;

  if (hasUsedAt && !parseDateValue(doc.usedAt)) {
    fail('usedAt', 'usedAt must be a valid Date');
  }
  if (usedAtPresent && usedByPresent && hasUsedAt !== hasUsedByUserId) {
    fail('usedAt', 'usedAt and usedByUserId must both be set or both be null');
  }
  if (hasRevokedAt && !parseDateValue(doc.revokedAt)) {
    fail('revokedAt', 'revokedAt must be a valid Date');
  }
  if (revokedAtPresent && revokedByPresent && hasRevokedBy && !hasRevokedAt) {
    fail('revokedByParticipantId', 'revokedByParticipantId requires revokedAt');
  }
  if (usedAtPresent && revokedAtPresent && hasUsedAt && hasRevokedAt) {
    fail('usedAt', 'ParticipantInvite cannot be both used and revoked');
  }
}

participantInviteSchema.pre('validate', function (next) {
  applyInviteDocumentPolicyAndLifecycleChecks(this);
  next();
});

participantInviteSchema.post('init', function (doc: IParticipantInvite) {
  (doc as unknown as Record<symbol, PersistedInviteLifecycleSnapshot>)[PERSISTED_INVITE_STATE] =
    captureLifecycleSnapshot(doc);
});

participantInviteSchema.post('save', function (doc: IParticipantInvite) {
  (doc as unknown as Record<symbol, PersistedInviteLifecycleSnapshot>)[PERSISTED_INVITE_STATE] =
    captureLifecycleSnapshot(doc);
});

participantInviteSchema.pre('save', async function () {
  if (this.isNew) {
    return;
  }

  const model = this.constructor as mongoose.Model<IParticipantInvite>;
  const session = this.$session();
  const dbQuery = model.findOne({ _id: this._id }).select('+tokenHash').lean();
  if (session) {
    dbQuery.session(session);
  }
  const dbRow = await dbQuery;
  const snapshot = (
    this as unknown as Record<symbol, PersistedInviteLifecycleSnapshot | undefined>
  )[PERSISTED_INVITE_STATE];

  if (!dbRow) {
    throw new Error('Cannot save ParticipantInvite: target document no longer exists.');
  }

  // Block immutable security-field changes even via `.set(..., { overwriteImmutable: true })`
  // or `.overwrite(...)`.
  const objectIdImmutableFields = [
    'tripId',
    'participantId',
    'familyId',
    'invitedByUserId',
    'invitedByParticipantId',
  ] as const;
  for (const field of objectIdImmutableFields) {
    if (
      this.isModified(field) ||
      (this.isSelected(field) && String(this[field] ?? '') !== String(dbRow[field] ?? ''))
    ) {
      throw new Error(`Cannot modify immutable ParticipantInvite security field: ${field}.`);
    }
  }
  if (
    this.isModified('tokenHash') ||
    (this.isSelected('tokenHash') && this.tokenHash !== dbRow.tokenHash)
  ) {
    throw new Error('Cannot modify immutable ParticipantInvite security field: tokenHash.');
  }
  if (
    this.isModified('grantedRole') ||
    (this.isSelected('grantedRole') && this.grantedRole !== dbRow.grantedRole)
  ) {
    throw new Error('Cannot modify immutable ParticipantInvite security field: grantedRole.');
  }
  if (
    this.isModified('requireVerifiedEmail') ||
    (this.isSelected('requireVerifiedEmail') &&
      this.requireVerifiedEmail !== dbRow.requireVerifiedEmail)
  ) {
    throw new Error(
      'Cannot modify immutable ParticipantInvite security field: requireVerifiedEmail.'
    );
  }
  const docIntended = this.intendedEmail ?? null;
  const dbIntended = dbRow.intendedEmail ?? null;
  if (
    this.isModified('intendedEmail') ||
    (this.isSelected('intendedEmail') && docIntended !== dbIntended)
  ) {
    throw new Error('Cannot modify immutable ParticipantInvite security field: intendedEmail.');
  }
  const docExpMs = parseDateValue(this.expiresAt)?.getTime() ?? null;
  const dbExpMs = parseDateValue(dbRow.expiresAt)?.getTime() ?? null;
  if (
    this.isModified('expiresAt') ||
    (this.isSelected('expiresAt') && docExpMs !== dbExpMs)
  ) {
    throw new Error('Cannot modify immutable ParticipantInvite security field: expiresAt.');
  }

  // Enforce terminal lifecycle immutability across both DB state and loaded snapshot.
  const dbUsedAtMs = parseDateValue(dbRow.usedAt)?.getTime() ?? null;
  const dbUsedBy = dbRow.usedByUserId ? String(dbRow.usedByUserId) : null;
  const dbRevokedAtMs = parseDateValue(dbRow.revokedAt)?.getTime() ?? null;
  const dbRevokedBy = dbRow.revokedByParticipantId
    ? String(dbRow.revokedByParticipantId)
    : null;

  const persistedUsedAtMs = dbUsedAtMs ?? snapshot?.usedAtMs ?? null;
  const persistedUsedBy = dbUsedBy ?? snapshot?.usedByUserId ?? null;
  const persistedRevokedAtMs = dbRevokedAtMs ?? snapshot?.revokedAtMs ?? null;
  const persistedRevokedBy = dbRevokedBy ?? snapshot?.revokedByParticipantId ?? null;

  const currentUsedAtMs = parseDateValue(this.usedAt)?.getTime() ?? null;
  const currentUsedBy = this.usedByUserId ? String(this.usedByUserId) : null;
  const currentRevokedAtMs = parseDateValue(this.revokedAt)?.getTime() ?? null;
  const currentRevokedBy = this.revokedByParticipantId
    ? String(this.revokedByParticipantId)
    : null;

  if (persistedUsedAtMs !== null) {
    if (
      this.isModified('usedAt') ||
      this.isModified('usedByUserId') ||
      this.isModified('revokedAt') ||
      this.isModified('revokedByParticipantId') ||
      (this.isSelected('usedAt') && currentUsedAtMs !== persistedUsedAtMs) ||
      (this.isSelected('usedByUserId') && currentUsedBy !== persistedUsedBy) ||
      (this.isSelected('revokedAt') && currentRevokedAtMs !== null) ||
      (this.isSelected('revokedByParticipantId') && currentRevokedBy !== null)
    ) {
      throw new Error(
        'Redeemed ParticipantInvite is terminal and cannot be reopened, reassigned, or revoked.'
      );
    }
  }

  if (persistedRevokedAtMs !== null) {
    if (
      this.isModified('revokedAt') ||
      this.isModified('revokedByParticipantId') ||
      this.isModified('usedAt') ||
      this.isModified('usedByUserId') ||
      (this.isSelected('revokedAt') && currentRevokedAtMs !== persistedRevokedAtMs) ||
      (this.isSelected('revokedByParticipantId') && currentRevokedBy !== persistedRevokedBy) ||
      (this.isSelected('usedAt') && currentUsedAtMs !== null) ||
      (this.isSelected('usedByUserId') && currentUsedBy !== null)
    ) {
      throw new Error('Revoked ParticipantInvite is terminal and cannot be reopened or redeemed.');
    }
  }

  // Validate merged lifecycle consistency even for partial-projection saves on unused docs.
  const effectiveUsedAt =
    this.isSelected('usedAt') || this.isModified('usedAt') ? this.usedAt : dbRow.usedAt;
  const effectiveUsedBy =
    this.isSelected('usedByUserId') || this.isModified('usedByUserId')
      ? this.usedByUserId
      : dbRow.usedByUserId;
  const effectiveRevokedAt =
    this.isSelected('revokedAt') || this.isModified('revokedAt')
      ? this.revokedAt
      : dbRow.revokedAt;
  const effectiveRevokedBy =
    this.isSelected('revokedByParticipantId') || this.isModified('revokedByParticipantId')
      ? this.revokedByParticipantId
      : dbRow.revokedByParticipantId;

  const hasEffUsedAt = effectiveUsedAt !== undefined && effectiveUsedAt !== null;
  const hasEffUsedBy = effectiveUsedBy !== undefined && effectiveUsedBy !== null;
  const hasEffRevokedAt = effectiveRevokedAt !== undefined && effectiveRevokedAt !== null;
  const hasEffRevokedBy = effectiveRevokedBy !== undefined && effectiveRevokedBy !== null;

  if (hasEffUsedAt !== hasEffUsedBy) {
    throw new Error('usedAt and usedByUserId must both be set or both be null.');
  }
  if (hasEffRevokedBy && !hasEffRevokedAt) {
    throw new Error('revokedByParticipantId requires revokedAt.');
  }
  if (hasEffUsedAt && hasEffRevokedAt) {
    throw new Error('ParticipantInvite cannot be both used and revoked.');
  }
});

participantInviteSchema.pre('insertMany', function (next, docs: unknown[]) {
  try {
    if (!Array.isArray(docs)) {
      throw new Error('Invalid insertMany payload for ParticipantInvite.');
    }
    for (const rawDoc of docs) {
      if (!isPlainObjectRecord(rawDoc)) {
        throw new Error('Invalid ParticipantInvite document in insertMany.');
      }
      if (typeof rawDoc.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawDoc.tokenHash)) {
        throw new Error('tokenHash must be a 64-character lowercase SHA-256 hex digest.');
      }
      if (
        typeof rawDoc.grantedRole !== 'string' ||
        !(TRIP_ROLES as readonly string[]).includes(rawDoc.grantedRole)
      ) {
        throw new Error(`Invalid grantedRole "${String(rawDoc.grantedRole)}" in insertMany.`);
      }
      const draft = {
        grantedRole: rawDoc.grantedRole as TripRole,
        intendedEmail: rawDoc.intendedEmail as string | null | undefined,
        requireVerifiedEmail: rawDoc.requireVerifiedEmail as boolean | undefined,
        expiresAt: rawDoc.expiresAt,
        isNew: true,
        usedAt: rawDoc.usedAt,
        usedByUserId: rawDoc.usedByUserId,
        revokedAt: rawDoc.revokedAt,
        revokedByParticipantId: rawDoc.revokedByParticipantId,
      };
      applyInviteDocumentPolicyAndLifecycleChecks(draft);
      rawDoc.intendedEmail = draft.intendedEmail;
      rawDoc.requireVerifiedEmail = draft.requireVerifiedEmail;
    }
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error('Invalid ParticipantInvite insertMany'));
  }
});

participantInviteSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function (next) {
  try {
    const query = this as unknown as mongoose.Query<unknown, unknown>;
    const { unsetFields, setValues, nonSetTouchedFields } =
      assertQueryUpdatePreservesImmutableFields(
        query,
        IMMUTABLE_INVITE_FIELDS,
        'ParticipantInvite'
      );

    for (const lifecycleField of MUTABLE_LIFECYCLE_FIELDS) {
      if (unsetFields.has(lifecycleField)) {
        throw new Error(
          `Cannot unset ${lifecycleField}; invite redemption and revocation state are append-only.`
        );
      }
      if (nonSetTouchedFields.has(lifecycleField)) {
        throw new Error(
          `Lifecycle field ${lifecycleField} can only be transitioned via top-level $set updates on ParticipantInvite.`
        );
      }
    }

    const setsUsedAt = setValues.has('usedAt');
    const setsUsedBy = setValues.has('usedByUserId');
    const setsRevokedAt = setValues.has('revokedAt');
    const setsRevokedBy = setValues.has('revokedByParticipantId');

    const usedAtVal = setValues.get('usedAt');
    const usedByVal = setValues.get('usedByUserId');
    const revokedAtVal = setValues.get('revokedAt');

    if (setsUsedAt && (usedAtVal === null || usedAtVal === undefined || !parseDateValue(usedAtVal))) {
      throw new Error('usedAt must be set to a valid Date and cannot be cleared.');
    }
    if (setsUsedBy && (usedByVal === null || usedByVal === undefined)) {
      throw new Error('usedByUserId cannot be cleared to null.');
    }
    if (setsUsedAt !== setsUsedBy) {
      throw new Error('Updates setting usedAt must also set usedByUserId (and vice versa).');
    }

    if (
      setsRevokedAt &&
      (revokedAtVal === null || revokedAtVal === undefined || !parseDateValue(revokedAtVal))
    ) {
      throw new Error('revokedAt must be set to a valid Date and cannot be cleared.');
    }
    if (setsRevokedBy && !setsRevokedAt) {
      throw new Error('Setting or clearing revokedByParticipantId requires setting revokedAt.');
    }

    if (setsUsedAt && setsRevokedAt) {
      throw new Error('ParticipantInvite update cannot mark an invite both used and revoked.');
    }

    // Enforce single-use & revocation exclusivity on every Mongoose update transition.
    if (setsUsedAt || setsRevokedAt) {
      query.where({ usedAt: null, revokedAt: null });
    }

    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error('Invalid ParticipantInvite update'));
  }
});

participantInviteSchema.pre(['replaceOne', 'findOneAndReplace'], function (next) {
  next(
    new Error(
      'replaceOne and findOneAndReplace are prohibited on ParticipantInvite; create a new invite instead.'
    )
  );
});

participantInviteSchema.index(
  { tokenHash: 1 },
  { name: PARTICIPANT_INVITE_TOKEN_INDEX_NAME, unique: true }
);
participantInviteSchema.index({ participantId: 1, usedAt: 1, revokedAt: 1 });
participantInviteSchema.index(
  { intendedEmail: 1, usedAt: 1, revokedAt: 1, expiresAt: 1 },
  { name: PARTICIPANT_INVITE_EMAIL_PENDING_INDEX_NAME }
);
participantInviteSchema.index({ tripId: 1, participantId: 1, createdAt: -1 });

export const ParticipantInviteModel = mongoose.model<IParticipantInvite>(
  'ParticipantInvite',
  participantInviteSchema
);
