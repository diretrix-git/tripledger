import rateLimit, {
  type Options,
  type RateLimitRequestHandler,
  type Store,
  type IncrementResponse,
  type ClientRateLimitInfo,
} from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import {
  env,
  type EnvConfig,
  type RateLimitStoreType,
  validateRateLimitTopologyConfig,
} from '../config/env.js';
import { RateLimitBucketModel } from '../models/index.js';
import { AppError } from '../utils/http.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { redactSensitiveText } from '../utils/redact.js';

export class MongoRateLimitStore implements Store {
  public readonly prefix: string;
  public readonly localKeys = false;
  private windowMs = 60_000;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  public init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private getWindowBucket(key: string, nowMs = Date.now()): {
    bucketKey: string;
    resetTime: Date;
  } {
    const windowStartMs = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const resetTime = new Date(windowStartMs + this.windowMs);
    return {
      bucketKey: `${this.prefix}${key}:${windowStartMs}`,
      resetTime,
    };
  }

  public async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const { bucketKey, resetTime } = this.getWindowBucket(key);
    const doc = await RateLimitBucketModel.findOne({ key: bucketKey }).lean();
    if (!doc) {
      return undefined;
    }
    return { totalHits: doc.hits, resetTime };
  }

  public async increment(key: string): Promise<IncrementResponse> {
    const { bucketKey, resetTime } = this.getWindowBucket(key);

    try {
      const doc = await RateLimitBucketModel.findOneAndUpdate(
        { key: bucketKey },
        {
          $inc: { hits: 1 },
          $setOnInsert: { key: bucketKey, expiresAt: resetTime },
        },
        { upsert: true, new: true, lean: true }
      );
      if (doc) {
        return {
          totalHits: doc.hits,
          resetTime,
        };
      }
      throw new AppError(
        'Rate-limit storage is temporarily unavailable. Please try again later.',
        503,
        'SERVICE_UNAVAILABLE'
      );
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      if (isDuplicateKeyError(err)) {
        try {
          const doc = await RateLimitBucketModel.findOneAndUpdate(
            { key: bucketKey },
            { $inc: { hits: 1 } },
            { new: true, lean: true }
          );
          if (doc) {
            return {
              totalHits: doc.hits,
              resetTime,
            };
          }
        } catch (retryErr) {
          const safeRetryReason = redactSensitiveText(
            retryErr instanceof Error ? retryErr.message : 'Rate limit retry failure'
          );
          console.error('[TripLedger RateLimit] Retry failure:', safeRetryReason);
        }
      } else {
        const safeReason = redactSensitiveText(
          err instanceof Error ? err.message : 'Rate limit store failure'
        );
        console.error('[TripLedger RateLimit] Store failure:', safeReason);
      }
      throw new AppError(
        'Rate-limit storage is temporarily unavailable. Please try again later.',
        503,
        'SERVICE_UNAVAILABLE'
      );
    }
  }

  public async decrement(key: string): Promise<void> {
    const { bucketKey } = this.getWindowBucket(key);
    await RateLimitBucketModel.findOneAndUpdate(
      { key: bucketKey, hits: { $gt: 0 } },
      { $inc: { hits: -1 } }
    );
  }

  public async resetKey(key: string): Promise<void> {
    const { bucketKey } = this.getWindowBucket(key);
    await RateLimitBucketModel.deleteOne({ key: bucketKey });
  }

  public async resetAll(): Promise<void> {
    const escapedPrefix = this.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await RateLimitBucketModel.deleteMany({
      key: { $regex: new RegExp(`^${escapedPrefix}`) },
    });
  }
}

export async function ensureRateLimitIndexes(): Promise<void> {
  await RateLimitBucketModel.createIndexes();
}

export function createConfiguredRateLimiter(params: {
  prefix: string;
  windowMs: number;
  limit: number;
  storeType: RateLimitStoreType;
  enabled: boolean;
  message?: string;
  keyGenerator?: (req: Request, res: Response) => string;
}): RateLimitRequestHandler {
  if (!params.enabled) {
    const noopHandler = ((_req: Request, _res: Response, next: NextFunction) => {
      next();
    }) as RateLimitRequestHandler;
    noopHandler.resetKey = () => {};
    noopHandler.getKey = () => undefined;
    return noopHandler;
  }

  const store = params.storeType === 'mongo' ? new MongoRateLimitStore(params.prefix) : undefined;

  return rateLimit({
    windowMs: params.windowMs,
    limit: params.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    ...(params.keyGenerator ? { keyGenerator: params.keyGenerator } : {}),
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: params.message ?? 'Too many requests. Please try again later.',
        },
      });
    },
  });
}

export interface AuthRateLimiters {
  login: RateLimitRequestHandler;
  register: RateLimitRequestHandler;
  verifyEmail: RateLimitRequestHandler;
  resendVerification: RateLimitRequestHandler;
}

export interface TripRateLimiters {
  joinByUser: RateLimitRequestHandler;
  joinByIp: RateLimitRequestHandler;
}

export function createTripRateLimiters(params: {
  config?: EnvConfig;
  enabled: boolean;
  storeType: RateLimitStoreType;
  maxOverride?: number;
}): TripRateLimiters {
  const cfg = params.config ?? env;
  const windowMs = cfg.AUTH_RATE_LIMIT_WINDOW_MS;
  const maxPerUser = params.maxOverride ?? cfg.TRIP_JOIN_RATE_LIMIT_MAX;

  return {
    joinByUser: createConfiguredRateLimiter({
      prefix: 'trip-join-user:',
      windowMs,
      limit: maxPerUser,
      storeType: params.storeType,
      enabled: params.enabled,
      keyGenerator: (req) =>
        req.user?.userId ? `user:${req.user.userId}` : `ip:${req.ip ?? 'anonymous'}`,
      message: 'Too many trip join attempts. Please try again later.',
    }),
    joinByIp: createConfiguredRateLimiter({
      prefix: 'trip-join-ip:',
      windowMs,
      limit: Math.max(maxPerUser * 2, maxPerUser),
      storeType: params.storeType,
      enabled: params.enabled,
      message: 'Too many trip join attempts from this address. Please try again later.',
    }),
  };
}

export function resolveEffectiveRateLimitConfig(
  config: EnvConfig = env,
  overrides: {
    enableInTest?: boolean;
    storeTypeOverride?: RateLimitStoreType;
  } = {}
): { enabled: boolean; storeType: RateLimitStoreType } {
  const effectiveConfig: EnvConfig = overrides.storeTypeOverride
    ? { ...config, RATE_LIMIT_STORE: overrides.storeTypeOverride }
    : config;

  validateRateLimitTopologyConfig(effectiveConfig);

  const enabled = effectiveConfig.NODE_ENV !== 'test' || Boolean(overrides.enableInTest);
  return {
    enabled,
    storeType: effectiveConfig.RATE_LIMIT_STORE,
  };
}

export function createAuthRateLimiters(params: {
  config?: EnvConfig;
  enabled: boolean;
  storeType: RateLimitStoreType;
  maxOverrides?: {
    login?: number;
    register?: number;
    verifyEmail?: number;
    resendVerification?: number;
  };
}): AuthRateLimiters {
  const cfg = params.config ?? env;
  const windowMs = cfg.AUTH_RATE_LIMIT_WINDOW_MS;

  return {
    login: createConfiguredRateLimiter({
      prefix: 'auth-login:',
      windowMs,
      limit: params.maxOverrides?.login ?? cfg.AUTH_LOGIN_RATE_LIMIT_MAX,
      storeType: params.storeType,
      enabled: params.enabled,
      message: 'Too many login attempts. Please try again later.',
    }),
    register: createConfiguredRateLimiter({
      prefix: 'auth-register:',
      windowMs: windowMs * 4,
      limit: params.maxOverrides?.register ?? cfg.AUTH_REGISTER_RATE_LIMIT_MAX,
      storeType: params.storeType,
      enabled: params.enabled,
      message: 'Too many registration attempts. Please try again later.',
    }),
    verifyEmail: createConfiguredRateLimiter({
      prefix: 'auth-verify-email:',
      windowMs,
      limit: params.maxOverrides?.verifyEmail ?? cfg.AUTH_VERIFY_EMAIL_RATE_LIMIT_MAX,
      storeType: params.storeType,
      enabled: params.enabled,
      message: 'Too many email verification attempts. Please try again later.',
    }),
    resendVerification: createConfiguredRateLimiter({
      prefix: 'auth-resend-verification:',
      windowMs,
      limit: Math.max(
        (params.maxOverrides?.resendVerification ?? cfg.AUTH_RESEND_VERIFICATION_RATE_LIMIT_MAX) * 4,
        20
      ),
      storeType: params.storeType,
      enabled: params.enabled,
      keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : 'anonymous'),
      message: 'Too many verification email requests. Please wait before trying again.',
    }),
  };
}
