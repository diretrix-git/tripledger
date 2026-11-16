import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  EMAIL_VERIFICATION_TTL_MINUTES,
  loginUserSchema,
  registerUserSchema,
  updateProfileSchema,
  verifyEmailSchema,
  type AuthUserEntity,
} from '@tripledger/shared';
import { env } from '../config/env.js';
import { ParticipantModel, UserModel, type IUser } from '../models/index.js';
import {
  defaultEmailDeliveryService,
  type EmailDeliveryService,
} from '../services/emailService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/http.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import {
  generateEmailVerificationToken,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/tokens.js';

const REFRESH_COOKIE_NAME = 'tripledger_refresh_token';
const DUMMY_BCRYPT_HASH =
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth',
  });
}

export function formatAuthUser(user: IUser): AuthUserEntity {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    phone: user.phone,
    defaultCurrency: user.defaultCurrency,
  };
}

export interface AuthHandlersOptions {
  emailDeliveryService?: EmailDeliveryService;
  resendCooldownMs?: number;
  resendWindowMs?: number;
  resendMaxPerWindow?: number;
  now?: () => number;
}

function resolveAuthHandlerOptions(
  emailDeliveryOrOptions?: EmailDeliveryService | AuthHandlersOptions
): Required<Omit<AuthHandlersOptions, 'emailDeliveryService'>> & {
  emailDelivery: EmailDeliveryService;
} {
  const isServiceInstance =
    emailDeliveryOrOptions !== undefined &&
    typeof (emailDeliveryOrOptions as EmailDeliveryService).sendVerificationEmail === 'function';
  const opts: AuthHandlersOptions = isServiceInstance
    ? { emailDeliveryService: emailDeliveryOrOptions as EmailDeliveryService }
    : ((emailDeliveryOrOptions as AuthHandlersOptions | undefined) ?? {});

  return {
    emailDelivery: opts.emailDeliveryService ?? defaultEmailDeliveryService,
    resendCooldownMs:
      opts.resendCooldownMs ?? EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000,
    resendWindowMs: opts.resendWindowMs ?? env.AUTH_RATE_LIMIT_WINDOW_MS,
    resendMaxPerWindow:
      opts.resendMaxPerWindow ?? env.AUTH_RESEND_VERIFICATION_RATE_LIMIT_MAX,
    now: opts.now ?? (() => Date.now()),
  };
}

export function createAuthHandlers(
  emailDeliveryOrOptions?: EmailDeliveryService | AuthHandlersOptions
) {
  const {
    emailDelivery,
    resendCooldownMs,
    resendWindowMs,
    resendMaxPerWindow,
    now: nowProvider,
  } = resolveAuthHandlerOptions(emailDeliveryOrOptions);

  const register = asyncHandler(async (req: Request, res: Response) => {
    const parsed = registerUserSchema.parse(req.body);

    const existing = await UserModel.findOne({ email: parsed.email });
    if (existing) {
      throw new AppError('An account with this email already exists.', 409, 'EMAIL_EXISTS');
    }

    const passwordHash = await bcrypt.hash(parsed.password, env.BCRYPT_SALT_ROUNDS);
    const { rawToken, tokenHash, expiresAt } = generateEmailVerificationToken();

    let user: IUser;
    try {
      user = await UserModel.create({
        name: parsed.name,
        email: parsed.email,
        emailVerified: false,
        emailVerifiedAt: null,
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: expiresAt,
        emailVerificationLastSentAt: null,
        emailVerificationResendWindowStart: null,
        emailVerificationResendCount: 0,
        passwordHash,
        phone: parsed.phone,
        defaultCurrency: 'NPR',
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new AppError('An account with this email already exists.', 409, 'EMAIL_EXISTS');
      }
      throw err;
    }

    // On delivery failure, preserve the created unverified user and its hashed, expiring token so
    // the user can still log in and call resend-verification to recover once delivery recovers.
    await emailDelivery.sendVerificationEmail({
      to: user.email,
      recipientName: user.name,
      rawToken,
      expiresInMinutes: EMAIL_VERIFICATION_TTL_MINUTES,
    });

    const accessToken = signAccessToken({
      userId: user._id.toString(),
      email: user.email,
      name: user.name,
    });
    const refreshToken = signRefreshToken({ userId: user._id.toString() });

    // Record successful verification send timestamp for the 60-second resend cooldown only AFTER delivery succeeds.
    user.emailVerificationLastSentAt = new Date(nowProvider());
    user.refreshTokenHash = hashToken(refreshToken);
    await user.save();

    setRefreshCookie(res, refreshToken);

    sendSuccess(
      res,
      {
        accessToken,
        refreshToken,
        user: formatAuthUser(user),
      },
      201
    );
  });

  const login = asyncHandler(async (req: Request, res: Response) => {
    const parsed = loginUserSchema.parse(req.body);

    const user = await UserModel.findOne({ email: parsed.email }).select('+passwordHash');
    if (!user) {
      await bcrypt.compare(parsed.password, DUMMY_BCRYPT_HASH);
      throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

    const isValid = await bcrypt.compare(parsed.password, user.passwordHash);
    if (!isValid) {
      throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
    }

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
      user: formatAuthUser(user),
    });
  });

  const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
    const parsed = verifyEmailSchema.parse(req.body);
    const tokenHash = hashToken(parsed.token);
    const now = new Date();

    const verifiedUser = await UserModel.findOneAndUpdate(
      {
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: { $gt: now },
      },
      {
        $set: {
          emailVerified: true,
          emailVerifiedAt: now,
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
        },
      },
      { new: true }
    );

    if (!verifiedUser) {
      throw new AppError(
        'Verification token is invalid or has expired.',
        400,
        'INVALID_OR_EXPIRED_VERIFICATION_TOKEN'
      );
    }

    sendSuccess(res, {
      verified: true,
      emailVerified: true,
      emailVerifiedAt: verifiedUser.emailVerifiedAt
        ? verifiedUser.emailVerifiedAt.toISOString()
        : now.toISOString(),
    });
  });

  const resendVerification = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
      throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
    }

    const user = await UserModel.findById(req.user.userId).select(
      '+emailVerificationTokenHash +emailVerificationExpiresAt +emailVerificationLastSentAt +emailVerificationResendWindowStart +emailVerificationResendCount'
    );
    if (!user) {
      throw new AppError('User account not found.', 404, 'USER_NOT_FOUND');
    }

    if (user.emailVerified === true) {
      sendSuccess(res, {
        sent: false,
        alreadyVerified: true,
        emailVerified: true,
      });
      return;
    }

    const nowMs = nowProvider();
    const nowDate = new Date(nowMs);
    const prevHash = user.emailVerificationTokenHash ?? null;
    const prevExpiresAt = user.emailVerificationExpiresAt ?? null;
    const prevLastSentAt = user.emailVerificationLastSentAt ?? null;
    const prevWindowStart = user.emailVerificationResendWindowStart ?? null;
    const prevCount =
      typeof user.emailVerificationResendCount === 'number'
        ? user.emailVerificationResendCount
        : 0;

    if (prevLastSentAt !== null) {
      const elapsedMs = nowMs - prevLastSentAt.getTime();
      if (elapsedMs < resendCooldownMs) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((resendCooldownMs - elapsedMs) / 1000)
        );
        res.setHeader('Retry-After', String(retryAfterSeconds));
        throw new AppError(
          `Please wait ${retryAfterSeconds} seconds before requesting another verification email.`,
          429,
          'VERIFICATION_RESEND_COOLDOWN',
          { retryAfterSeconds }
        );
      }
    }

    const isWindowActive =
      prevWindowStart !== null && nowMs - prevWindowStart.getTime() < resendWindowMs;
    const currentWindowCount = isWindowActive ? prevCount : 0;
    if (currentWindowCount >= resendMaxPerWindow) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((prevWindowStart!.getTime() + resendWindowMs - nowMs) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new AppError(
        'Too many verification email requests. Please try again later.',
        429,
        'RATE_LIMITED',
        { retryAfterSeconds }
      );
    }

    const { rawToken, tokenHash, expiresAt } = generateEmailVerificationToken();
    const cooldownCutoff = new Date(nowMs - resendCooldownMs);
    const windowCutoff = new Date(nowMs - resendWindowMs);
    const nextWindowStart = isWindowActive ? prevWindowStart! : nowDate;
    const nextWindowCount = currentWindowCount + 1;

    const swapped = await UserModel.findOneAndUpdate(
      {
        _id: user._id,
        emailVerified: false,
        emailVerificationTokenHash: prevHash,
        emailVerificationLastSentAt: prevLastSentAt,
        $and: [
          {
            $or: [
              { emailVerificationLastSentAt: null },
              { emailVerificationLastSentAt: { $lte: cooldownCutoff } },
            ],
          },
          {
            $or: [
              { emailVerificationResendWindowStart: null },
              { emailVerificationResendWindowStart: { $lte: windowCutoff } },
              { emailVerificationResendCount: { $exists: false } },
              { emailVerificationResendCount: { $lt: resendMaxPerWindow } },
            ],
          },
        ],
      },
      {
        $set: {
          emailVerificationTokenHash: tokenHash,
          emailVerificationExpiresAt: expiresAt,
          emailVerificationLastSentAt: nowDate,
          emailVerificationResendWindowStart: nextWindowStart,
          emailVerificationResendCount: nextWindowCount,
        },
      },
      { new: true }
    );

    if (!swapped) {
      const latest = await UserModel.findById(user._id).select(
        '+emailVerificationLastSentAt +emailVerificationResendWindowStart +emailVerificationResendCount'
      );
      if (latest?.emailVerified === true) {
        sendSuccess(res, {
          sent: false,
          alreadyVerified: true,
          emailVerified: true,
        });
        return;
      }
      if (latest?.emailVerificationLastSentAt) {
        const elapsedMs = nowMs - latest.emailVerificationLastSentAt.getTime();
        if (elapsedMs < resendCooldownMs) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((resendCooldownMs - elapsedMs) / 1000)
          );
          res.setHeader('Retry-After', String(retryAfterSeconds));
          throw new AppError(
            `Please wait ${retryAfterSeconds} seconds before requesting another verification email.`,
            429,
            'VERIFICATION_RESEND_COOLDOWN',
            { retryAfterSeconds }
          );
        }
      }
      if (
        latest?.emailVerificationResendWindowStart &&
        nowMs - latest.emailVerificationResendWindowStart.getTime() < resendWindowMs &&
        (latest.emailVerificationResendCount ?? 0) >= resendMaxPerWindow
      ) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(
            (latest.emailVerificationResendWindowStart.getTime() + resendWindowMs - nowMs) / 1000
          )
        );
        res.setHeader('Retry-After', String(retryAfterSeconds));
        throw new AppError(
          'Too many verification email requests. Please try again later.',
          429,
          'RATE_LIMITED',
          { retryAfterSeconds }
        );
      }
      throw new AppError(
        'Verification request conflicted with a concurrent update. Please try again.',
        409,
        'VERIFICATION_STATE_CONFLICT'
      );
    }

    try {
      await emailDelivery.sendVerificationEmail({
        to: user.email,
        recipientName: user.name,
        rawToken,
        expiresInMinutes: EMAIL_VERIFICATION_TTL_MINUTES,
      });
    } catch (err) {
      // Conditionally roll back token AND cooldown/quota ONLY if no newer resend superseded this tokenHash.
      await UserModel.updateOne(
        {
          _id: user._id,
          emailVerified: false,
          emailVerificationTokenHash: tokenHash,
        },
        {
          $set: {
            emailVerificationTokenHash: prevHash,
            emailVerificationExpiresAt: prevExpiresAt,
            emailVerificationLastSentAt: prevLastSentAt,
            emailVerificationResendWindowStart: prevWindowStart,
            emailVerificationResendCount: prevCount,
          },
        }
      );
      throw err;
    }

    sendSuccess(res, {
      sent: true,
      alreadyVerified: false,
      emailVerified: false,
    });
  });

  const refresh = asyncHandler(async (req: Request, res: Response) => {
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
      user: formatAuthUser(user),
    });
  });

  const logout = asyncHandler(async (req: Request, res: Response) => {
    if (req.user) {
      await UserModel.findByIdAndUpdate(req.user.userId, {
        $set: { refreshTokenHash: null },
      });
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
    sendSuccess(res, { loggedOut: true });
  });

  const getMe = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
      throw new AppError('Authentication required.', 401, 'UNAUTHORIZED');
    }

    const user = await UserModel.findById(req.user.userId);
    if (!user) {
      throw new AppError('User account not found.', 404, 'USER_NOT_FOUND');
    }

    sendSuccess(res, {
      user: {
        ...formatAuthUser(user),
        createdAt: user.createdAt,
      },
    });
  });

  const updateMe = asyncHandler(async (req: Request, res: Response) => {
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
      user: formatAuthUser(user),
    });
  });

  return {
    register,
    login,
    verifyEmail,
    resendVerification,
    refresh,
    logout,
    getMe,
    updateMe,
  };
}

const defaultHandlers = createAuthHandlers();
export const {
  register,
  login,
  verifyEmail,
  resendVerification,
  refresh,
  logout,
  getMe,
  updateMe,
} = defaultHandlers;
