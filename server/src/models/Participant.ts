import mongoose, { Schema, type Document } from 'mongoose';
import {
  MEMBER_TYPES,
  TRIP_ROLES,
  type MemberType,
  type TripRole,
} from '@tripledger/shared';

export interface IParticipant extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId | null;
  familyId?: mongoose.Types.ObjectId | null;
  name: string;
  email?: string;
  phone?: string;
  role: TripRole;
  memberType: MemberType;
  defaultWeight: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const participantSchema = new Schema<IParticipant>(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    familyId: { type: Schema.Types.ObjectId, ref: 'Family', default: null, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true, maxlength: 25 },
    role: { type: String, enum: TRIP_ROLES, default: 'PARTICIPANT' },
    memberType: { type: String, enum: MEMBER_TYPES, default: 'ADULT' },
    defaultWeight: { type: Number, default: 1, min: 0.01 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

participantSchema.index({ tripId: 1, isActive: 1 });
participantSchema.index({ tripId: 1, userId: 1 });

export const ParticipantModel = mongoose.model<IParticipant>('Participant', participantSchema);
