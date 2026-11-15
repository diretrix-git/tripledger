import mongoose, { Schema, type Document } from 'mongoose';

export interface IExpenseShare extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  expenseId: mongoose.Types.ObjectId;
  participantId: mongoose.Types.ObjectId;
  familyId?: mongoose.Types.ObjectId | null;
  sharePaisa: number;
  weightUsed?: number;
}

const expenseShareSchema = new Schema<IExpenseShare>({
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  expenseId: { type: Schema.Types.ObjectId, ref: 'Expense', required: true, index: true },
  participantId: {
    type: Schema.Types.ObjectId,
    ref: 'Participant',
    required: true,
    index: true,
  },
  familyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null },
  sharePaisa: {
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: Number.isSafeInteger,
      message: 'sharePaisa must be an integer in paisa',
    },
  },
  weightUsed: { type: Number, default: 1 },
});

expenseShareSchema.index({ tripId: 1, participantId: 1 });

export const ExpenseShareModel = mongoose.model<IExpenseShare>(
  'ExpenseShare',
  expenseShareSchema
);
