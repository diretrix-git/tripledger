import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  loginUserSchema,
  registerUserSchema,
  updateProfileSchema,
} from '@tripledger/shared';
import { env } from '../config/env.js';
import { ParticipantModel, UserModel } from '../models/index.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/tokens.js';

const REFRESH_COOKIE_NAME = 'tripledger_refresh_token';

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth',
  });
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const parsed = registerUserSchema.parse(req.body);

  const existing = await UserModel.findOne({ email: parsed.email });
  if (existing) {
    throw new AppError('An account with this email already exists.', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await bcrypt.hash(parsed.password, env.BCRYPT_SALT_ROUNDS);
  const user = await UserModel.create({
    name: parsed.name,
    email: parsed.email,
    passwordHash,
    phone: parsed.phone,
    defaultCurrency: 'NPR',
  });

  // Automatically link any existing guest participant records that share this email
  await ParticipantModel.updateMany(
    { email: parsed.email, userId: null },
    { $set: { userId: user._id } }
  );

  const accessToken = signAccessToken({
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
  });
  const refreshToken = signRefreshToken({ userId: user._id.toString() });

  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  setRefreshCookie(res, refreshToken);

  sendSuccess(
    res,
    {
      accessToken,
      refreshToken,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        defaultCurrency: user.defaultCurrency,
      },
    },
    201
  );
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const parsed = loginUserSchema.parse(req.body);

  const user = await UserModel.findOne({ email: parsed.email }).select('+passwordHash');
  if (!user) {
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const isValid = await bcrypt.compare(parsed.password, user.passwordHash);
  if (!isValid) {
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  // Link any unlinked guest participant records with matching email
  await ParticipantModel.updateMany(
    { email: user.email, userId: null },
    { $set: { userId: user._id } }
  );

  const accessToken = signAccessToken({
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
  });
  const refreshToken = signRefreshToken({ userId: user._id.toString() });

  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  setRefreshCookie(res, refreshToken);

  sendSuccess(res, {
    accessToken,
    refreshToken,
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      defaultCurrency: user.defaultCurrency,
    },
  });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const rawToken =
    (req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined) ??
    (req.body?.refreshToken as string | undefined);

  if (!rawToken) {
    throw new AppError('Refresh token missing.', 401, 'REFRESH_TOKEN_MISSING');
  }

  let payload: { userId: string };
  try {
    payload = verifyRefreshToken(rawToken);
  } catch {
    throw new AppError('Invalid or expired refresh token.', 401, 'INVALID_REFRESH_TOKEN');
  }

  const user = await UserModel.findById(payload.userId).select('+refreshTokenHash');
  if (!user || !user.refreshTokenHash || user.refreshTokenHash !== hashToken(rawToken)) {
    throw new AppError('Refresh token has been revoked.', 401, 'REVOKED_REFRESH_TOKEN');
  }

  const newAccessToken = signAccessToken({
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
  });
  const newRefreshToken = signRefreshToken({ userId: user._id.toString() });

  user.refreshTokenHash = hashToken(newRefreshToken);
  await user.save();

  setRefreshCookie(res, newRefreshToken);

  sendSuccess(res, {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      defaultCurrency: user.defaultCurrency,
    },
  });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  if (req.user) {
    await UserModel.findByIdAndUpdate(req.user.userId, {
      $set: { refreshTokenHash: null },
    });
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  sendSuccess(res, { loggedOut: true });
});

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const user = await UserModel.findById(req.user.userId);
  if (!user) {
    throw new AppError('User account not found.', 404, 'USER_NOT_FOUND');
  }

  sendSuccess(res, {
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      defaultCurrency: user.defaultCurrency,
      createdAt: user.createdAt,
    },
  });
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
  }

  const parsed = updateProfileSchema.parse(req.body);
  const user = await UserModel.findById(req.user.userId);
  if (!user) {
    throw new AppError('User account not found.', 404, 'USER_NOT_FOUND');
  }

  if (parsed.name !== undefined) user.name = parsed.name;
  if (parsed.phone !== undefined) user.phone = parsed.phone;
  await user.save();

  // Keep linked participant names synchronized
  if (parsed.name !== undefined) {
    await ParticipantModel.updateMany(
      { userId: user._id },
      { $set: { name: parsed.name } }
    );
  }

  sendSuccess(res, {
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone,
      defaultCurrency: user.defaultCurrency,
    },
  });
});
