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
  splitConfig?: {
    includedFamilyIds?: string[];
    familyWeights?: Array<{ familyId: string; weight?: number }>;
  };
  splitMethod: SplitMethod;
  paymentMethod: PaymentMethod;
  approvalStatus: ExpenseApprovalStatus;
  incurredAt: Date;
  createdByParticipantId: mongoose.Types.ObjectId;
  approvedByParticipantId?: mongoose.Types.ObjectId | null;
  clientMutationId?: string;
  idempotencyHash?: string;
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
    splitConfig: {
      type: new Schema(
        {
          includedFamilyIds: { type: [String], default: undefined },
          familyWeights: {
            type: [
              new Schema(
                { familyId: { type: String, required: true }, weight: { type: Number } },
                { _id: false }
              ),
            ],
            default: undefined,
          },
        },
        { _id: false }
      ),
      default: undefined,
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
    idempotencyHash: { type: String },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const EXPENSE_MUTATION_ID_INDEX_NAME = 'tripId_1_clientMutationId_partial_unique';

expenseSchema.index({ tripId: 1, isDeleted: 1, incurredAt: -1 });
expenseSchema.index(
  { tripId: 1, clientMutationId: 1 },
  {
    name: EXPENSE_MUTATION_ID_INDEX_NAME,
    unique: true,
    // Partial index (unlike compound sparse: true) skips documents when clientMutationId is
    // omitted, null, or empty even though tripId is always present.
    partialFilterExpression: { clientMutationId: { $type: 'string', $gt: '' } },
  }
);

export const ExpenseModel = mongoose.model<IExpense>('Expense', expenseSchema);
