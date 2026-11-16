import mongoose, { Schema, type Document } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  emailVerified: boolean;
  emailVerifiedAt?: Date | null;
  emailVerificationTokenHash?: string | null;
  emailVerificationExpiresAt?: Date | null;
  emailVerificationLastSentAt?: Date | null;
  emailVerificationResendWindowStart?: Date | null;
  emailVerificationResendCount?: number;
  passwordHash: string;
  phone?: string;
  defaultCurrency: string;
  refreshTokenHash?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME =
  'emailVerificationTokenHash_partial_unique';

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    emailVerificationTokenHash: {
      type: String,
      select: false,
      default: null,
      validate: {
        validator: (v: string | null | undefined) =>
          v === undefined || v === null || /^[a-f0-9]{64}$/.test(v),
        message: 'emailVerificationTokenHash must be a 64-character lowercase SHA-256 hex digest',
      },
    },
    emailVerificationExpiresAt: { type: Date, select: false, default: null },
    emailVerificationLastSentAt: { type: Date, select: false, default: null },
    emailVerificationResendWindowStart: { type: Date, select: false, default: null },
    emailVerificationResendCount: { type: Number, select: false, default: 0, min: 0 },
    passwordHash: { type: String, required: true, select: false },
    phone: { type: String, trim: true, maxlength: 25 },
    defaultCurrency: { type: String, default: 'NPR' },
    refreshTokenHash: { type: String, select: false, default: null },
  },
  { timestamps: true }
);

userSchema.index(
  { emailVerificationTokenHash: 1 },
  {
    name: USER_EMAIL_VERIFICATION_TOKEN_INDEX_NAME,
    unique: true,
    partialFilterExpression: { emailVerificationTokenHash: { $type: 'string', $gt: '' } },
  }
);

export const UserModel = mongoose.model<IUser>('User', userSchema);
