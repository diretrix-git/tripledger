import mongoose, { Schema, type Document } from 'mongoose';

export interface IActivityLog extends Document {
  _id: mongoose.Types.ObjectId;
  tripId: mongoose.Types.ObjectId;
  actorUserId?: mongoose.Types.ObjectId | null;
  actorParticipantId?: mongoose.Types.ObjectId | null;
  actorName: string;
  actionType: string;
  entityType: 'TRIP' | 'PARTICIPANT' | 'FAMILY' | 'EXPENSE' | 'SETTLEMENT';
  entityId: mongoose.Types.ObjectId;
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorParticipantId: { type: Schema.Types.ObjectId, ref: 'Participant', default: null },
    actorName: { type: String, required: true, trim: true },
    actionType: { type: String, required: true },
    entityType: {
      type: String,
      enum: ['TRIP', 'PARTICIPANT', 'FAMILY', 'EXPENSE', 'SETTLEMENT'],
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true },
    summary: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

activityLogSchema.index({ tripId: 1, createdAt: -1 });

export const ActivityLogModel = mongoose.model<IActivityLog>(
  'ActivityLog',
  activityLogSchema
);
