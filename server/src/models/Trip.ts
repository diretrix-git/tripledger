import mongoose, { Schema, type Document } from 'mongoose';
import {
  DEFAULT_OPEN_INVITE_ROLE,
  EXPENSE_CATEGORIES,
  TRIP_MODES,
  TRIP_STATUSES,
  type ExpenseCategory,
  type TripMode,
  type TripStatus,
} from '@tripledger/shared';
import {
  assertAllowedQueryOptions,
  assertQueryUpdatePreservesImmutableFields,
  isPlainObjectRecord,
} from './updateGuards.js';

export interface IChecklistItem {
  category: ExpenseCategory;
  label: string;
  checked: boolean;
  notApplicable: boolean;
  verifiedAt?: Date | null;
}

export interface ITrip extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  mode: TripMode;
  status: TripStatus;
  currency: string;
  budgetPaisa?: number;
  startDate?: Date;
  endDate?: Date;
  createdBy: mongoose.Types.ObjectId;
  inviteCode: string;
  inviteEnabled: boolean;
  inviteExpiresAt?: Date | null;
  inviteCodeRotatedAt?: Date | null;
  defaultInviteRole: 'PARTICIPANT';
  shareToken: string;
  shareEnabled: boolean;
  checklist: IChecklistItem[];
  closedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const checklistItemSchema = new Schema<IChecklistItem>(
  {
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    label: { type: String, required: true },
    checked: { type: Boolean, default: false },
    notApplicable: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false }
);

const tripSchema = new Schema<ITrip>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    mode: { type: String, enum: TRIP_MODES, required: true, immutable: true },
    status: { type: String, enum: TRIP_STATUSES, default: 'ACTIVE' },
    currency: { type: String, default: 'NPR' },
    budgetPaisa: {
      type: Number,
      min: 0,
      validate: {
        validator: (v: number | undefined) => v === undefined || Number.isSafeInteger(v),
        message: 'budgetPaisa must be an integer in paisa',
      },
    },
    startDate: { type: Date },
    endDate: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    inviteCode: { type: String, required: true, unique: true, index: true },
    inviteEnabled: { type: Boolean, default: true },
    inviteExpiresAt: { type: Date, default: null },
    inviteCodeRotatedAt: { type: Date, default: null },
    defaultInviteRole: {
      type: String,
      enum: [DEFAULT_OPEN_INVITE_ROLE],
      default: DEFAULT_OPEN_INVITE_ROLE,
      immutable: true,
    },
    shareToken: { type: String, required: true, unique: true, index: true },
    shareEnabled: { type: Boolean, default: true },
    checklist: { type: [checklistItemSchema], default: [] },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

tripSchema.index({ createdBy: 1, status: 1 });

const IMMUTABLE_TRIP_SECURITY_FIELDS = new Set<string>(['defaultInviteRole']);

tripSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function (next) {
  try {
    assertQueryUpdatePreservesImmutableFields(
      this as unknown as mongoose.Query<unknown, unknown>,
      IMMUTABLE_TRIP_SECURITY_FIELDS,
      'Trip'
    );
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error('Invalid Trip update'));
  }
});

tripSchema.pre(['replaceOne', 'findOneAndReplace'], function (next) {
  try {
    const query = this as unknown as mongoose.Query<unknown, unknown>;
    assertAllowedQueryOptions(query, 'Trip');
    const replacement = query.getUpdate();
    if (!isPlainObjectRecord(replacement)) {
      throw new Error('Invalid Trip replacement payload.');
    }
    if (replacement.defaultInviteRole === undefined) {
      query.setUpdate({
        ...replacement,
        defaultInviteRole: DEFAULT_OPEN_INVITE_ROLE,
      });
    } else if (replacement.defaultInviteRole !== DEFAULT_OPEN_INVITE_ROLE) {
      throw new Error(
        `Trip defaultInviteRole must remain ${DEFAULT_OPEN_INVITE_ROLE}.`
      );
    }
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error('Invalid Trip replacement'));
  }
});

tripSchema.pre('save', async function () {
  if (!this.isNew && this.isModified('defaultInviteRole')) {
    throw new Error(
      `Trip defaultInviteRole is immutable and must remain ${DEFAULT_OPEN_INVITE_ROLE}.`
    );
  }
  if (
    (this.isNew || this.isSelected('defaultInviteRole') || this.isModified('defaultInviteRole')) &&
    this.defaultInviteRole !== DEFAULT_OPEN_INVITE_ROLE
  ) {
    throw new Error(`Trip defaultInviteRole must remain ${DEFAULT_OPEN_INVITE_ROLE}.`);
  }
});

tripSchema.pre('insertMany', function (next, docs: unknown[]) {
  try {
    if (!Array.isArray(docs)) {
      throw new Error('Invalid insertMany payload for Trip.');
    }
    for (const doc of docs) {
      if (isPlainObjectRecord(doc) && doc.defaultInviteRole !== undefined) {
        if (doc.defaultInviteRole !== DEFAULT_OPEN_INVITE_ROLE) {
          throw new Error(
            `Trip defaultInviteRole must be ${DEFAULT_OPEN_INVITE_ROLE}, received ${String(
              doc.defaultInviteRole
            )}.`
          );
        }
      }
    }
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error('Invalid Trip insertMany'));
  }
});

export const TripModel = mongoose.model<ITrip>('Trip', tripSchema);
