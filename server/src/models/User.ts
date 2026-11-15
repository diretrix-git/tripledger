import mongoose, { Schema, type Document } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  phone?: string;
  defaultCurrency: string;
  refreshTokenHash?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
    passwordHash: { type: String, required: true, select: false },
    phone: { type: String, trim: true, maxlength: 25 },
    defaultCurrency: { type: String, default: 'NPR' },
    refreshTokenHash: { type: String, select: false, default: null },
  },
  { timestamps: true }
);

export const UserModel = mongoose.model<IUser>('User', userSchema);
