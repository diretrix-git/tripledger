import mongoose, { Schema, type Document } from 'mongoose';
import { PAYMENT_METHODS, type PaymentMethod } from '@tripledger/shared';

export interface IExpensePayment extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  expenseId: mongoose.Types.ObjectId;
  participantId: mongoose.Types.ObjectId;
  amountPaisa: number;
  paymentMethod: PaymentMethod;
  paidAt: Date;
  notes?: string;
}

const expensePaymentSchema = new Schema<IExpensePayment>({
  tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
  expenseId: { type: Schema.Types.ObjectId, ref: 'Expense', required: true, index: true },
  participantId: {
    type: Schema.Types.ObjectId,
    ref: 'Participant',
    required: true,
    index: true,
  },
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
  paidAt: { type: Date, default: Date.now },
  notes: { type: String, trim: true, maxlength: 200 },
});

expensePaymentSchema.index({ tripId: 1, participantId: 1 });

export const ExpensePaymentModel = mongoose.model<IExpensePayment>(
  'ExpensePayment',
  expensePaymentSchema
);
