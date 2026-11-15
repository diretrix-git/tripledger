import mongoose, { Schema, type Document } from 'mongoose';
import {
  PAYMENT_METHODS,
  SETTLEMENT_MODES,
  SETTLEMENT_STATUSES,
  type PaymentMethod,
  type SettlementMode,
  type SettlementStatus,
} from '@tripledger/shared';

export interface ISettlement extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  settlementMode: SettlementMode;
  fromParticipantId: mongoose.Types.ObjectId;
  toParticipantId: mongoose.Types.ObjectId;
  fromFamilyId?: mongoose.Types.ObjectId | null;
  toFamilyId?: mongoose.Types.ObjectId | null;
  amountPaisa: number;
  paymentMethod: PaymentMethod;
  status: SettlementStatus;
  referenceNote?: string;
  settledAt: Date;
  reportedByParticipantId: mongoose.Types.ObjectId;
  confirmedByParticipantId?: mongoose.Types.ObjectId | null;
  confirmedAt?: Date | null;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const settlementSchema = new Schema<ISettlement>(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    settlementMode: { type: String, enum: SETTLEMENT_MODES, default: 'INDIVIDUAL' },
    fromParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      required: true,
      index: true,
    },
    toParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      required: true,
      index: true,
    },
    fromFamilyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
    toFamilyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
    amountPaisa: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'amountPaisa must be an integer in paisa',
      },
    },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'CASH' },
    status: { type: String, enum: SETTLEMENT_STATUSES, default: 'REPORTED' },
    referenceNote: { type: String, trim: true, maxlength: 300 },
    settledAt: { type: Date, default: Date.now },
    reportedByParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      required: true,
    },
    confirmedByParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      default: null,
    },
    confirmedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

settlementSchema.index({ tripId: 1, status: 1, isDeleted: 1 });

export const SettlementModel = mongoose.model<ISettlement>('Settlement', settlementSchema);
