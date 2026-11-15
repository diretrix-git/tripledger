import mongoose, { Schema, type Document } from 'mongoose';
import {
  EXPENSE_CATEGORIES,
  TRIP_MODES,
  TRIP_STATUSES,
  type ExpenseCategory,
  type TripMode,
  type TripStatus,
} from '@tripledger/shared';

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
    shareToken: { type: String, required: true, unique: true, index: true },
    shareEnabled: { type: Boolean, default: true },
    checklist: { type: [checklistItemSchema], default: [] },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

tripSchema.index({ createdBy: 1, status: 1 });

export const TripModel = mongoose.model<ITrip>('Trip', tripSchema);
