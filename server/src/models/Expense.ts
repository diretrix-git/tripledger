import mongoose, { Schema, type Document } from 'mongoose';
import {
  EXPENSE_APPROVAL_STATUSES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  SPLIT_METHODS,
  type ExpenseApprovalStatus,
  type ExpenseCategory,
  type PaymentMethod,
  type SplitMethod,
} from '@tripledger/shared';

export interface IExpense extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  category: ExpenseCategory;
  amountPaisa: number;
  isEstimated: boolean;
  isPackage: boolean;
  packageConfig?: {
    ratePerUnitPaisa: number;
    unitCount: number;
  };
  splitMethod: SplitMethod;
  paymentMethod: PaymentMethod;
  approvalStatus: ExpenseApprovalStatus;
  incurredAt: Date;
  createdByParticipantId: mongoose.Types.ObjectId;
  approvedByParticipantId?: mongoose.Types.ObjectId | null;
  clientMutationId?: string;
  isDeleted: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 500 },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amountPaisa: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'amountPaisa must be an integer in paisa',
      },
    },
    isEstimated: { type: Boolean, default: false },
    isPackage: { type: Boolean, default: false },
    packageConfig: {
      ratePerUnitPaisa: { type: Number },
      unitCount: { type: Number },
    },
    splitMethod: { type: String, enum: SPLIT_METHODS, required: true },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'CASH' },
    approvalStatus: {
      type: String,
      enum: EXPENSE_APPROVAL_STATUSES,
      default: 'APPROVED',
    },
    incurredAt: { type: Date, default: Date.now },
    createdByParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      required: true,
    },
    approvedByParticipantId: {
      type: Schema.Types.ObjectId,
      ref: 'Participant',
      default: null,
    },
    clientMutationId: { type: String, trim: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

expenseSchema.index({ tripId: 1, isDeleted: 1, incurredAt: -1 });
expenseSchema.index(
  { tripId: 1, clientMutationId: 1 },
  { unique: true, sparse: true }
);

export const ExpenseModel = mongoose.model<IExpense>('Expense', expenseSchema);
