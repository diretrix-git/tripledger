import mongoose, { Schema, type Document } from 'mongoose';

export interface IFamily extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  name: string;
  representativeId?: mongoose.Types.ObjectId | null;
  defaultWeight: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const familySchema = new Schema<IFamily>(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    representativeId: { type: Schema.Types.ObjectId, ref: 'Participant', default: null },
    defaultWeight: { type: Number, default: 1, min: 0.01 },
    notes: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

familySchema.index({ tripId: 1, name: 1 }, { unique: true });

export const FamilyModel = mongoose.model<IFamily>('Family', familySchema);
