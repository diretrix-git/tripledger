import mongoose, { Schema, type Document } from 'mongoose';

export interface IRateLimitBucket extends Document {
  key: string;
  hits: number;
  expiresAt: Date;
}

const rateLimitBucketSchema = new Schema<IRateLimitBucket>(
  {
    key: { type: String, required: true, unique: true },
    hits: { type: Number, required: true, default: 0, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  {
    versionKey: false,
    collection: 'rate_limit_buckets',
  }
);

rateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitBucketModel = mongoose.model<IRateLimitBucket>(
  'RateLimitBucket',
  rateLimitBucketSchema
);
