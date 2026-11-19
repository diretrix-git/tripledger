import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env, parseTrustProxySetting, type RateLimitStoreType } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { publicSharedRouter } from './routes/settlementAndReportRoutes.js';
import { createTripRouter, dashboardRouter } from './routes/tripRoutes.js';
import type { EmailDeliveryService } from './services/emailService.js';
import {
  createAuthRateLimiters,
  createConfiguredRateLimiter,
  createTripRateLimiters,
  resolveEffectiveRateLimitConfig,
} from './services/rateLimitStore.js';
import { sendSuccess } from './utils/http.js';

export interface CreateAppOptions {
  enableRateLimitInTest?: boolean;
  rateLimitStoreOverride?: RateLimitStoreType;
  apiRateLimitMaxOverride?: number;
  authRateLimitMaxOverrides?: {
    login?: number;
    register?: number;
    verifyEmail?: number;
    resendVerification?: number;
    tripJoin?: number;
  };
  emailDeliveryService?: EmailDeliveryService;
  resendCooldownMs?: number;
  resendWindowMs?: number;
  now?: () => number;
}

function isAllowedDevLanOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    ) {
      return true;
    }
    // RFC 1918 private IPv4 ranges for local Wi-Fi / LAN mobile testing in non-production
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

export function createApp(options: CreateAppOptions = {}): express.Application {
  const app = express();
  const isProduction = env.NODE_ENV === 'production';
  const effectiveRateLimit = resolveEffectiveRateLimitConfig(env, {
    enableInTest: options.enableRateLimitInTest,
    storeTypeOverride: options.rateLimitStoreOverride,
  });

  app.set('trust proxy', parseTrustProxySetting(env.TRUST_PROXY, env.NODE_ENV));
  app.use(
    isProduction
      ? helmet()
      : helmet({
          contentSecurityPolicy: false,
          crossOriginOpenerPolicy: false,
          originAgentCluster: false,
          strictTransportSecurity: false,
        })
  );
  app.use(
    cors({
      origin: isProduction
        ? env.CLIENT_URL
        : (requestOrigin, callback) => {
            if (
              !requestOrigin ||
              requestOrigin === env.CLIENT_URL ||
              isAllowedDevLanOrigin(requestOrigin)
            ) {
              callback(null, requestOrigin ?? env.CLIENT_URL);
              return;
            }
            callback(null, false);
          },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Health probe remains independent of database-backed rate-limit storage.
  app.get('/api/v1/health', (_req, res) => {
    sendSuccess(res, {
      service: 'TripLedger API',
      status: 'healthy',
      currency: 'NPR',
    });
  });

  const apiLimiter = createConfiguredRateLimiter({
    prefix: 'api-global:',
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: options.apiRateLimitMaxOverride ?? env.RATE_LIMIT_MAX_REQUESTS,
    storeType: effectiveRateLimit.storeType,
    enabled: effectiveRateLimit.enabled,
  });
  app.use('/api', apiLimiter);

  const authRateLimiters = createAuthRateLimiters({
    config: env,
    enabled: effectiveRateLimit.enabled,
    storeType: effectiveRateLimit.storeType,
    maxOverrides: options.authRateLimitMaxOverrides,
  });

  const tripRateLimiters = createTripRateLimiters({
    config: env,
    enabled: effectiveRateLimit.enabled,
    storeType: effectiveRateLimit.storeType,
    maxOverride: options.authRateLimitMaxOverrides?.tripJoin,
  });

  app.use(
    '/api/v1/auth',
    createAuthRouter({
      emailDeliveryService: options.emailDeliveryService,
      rateLimiters: authRateLimiters,
      resendCooldownMs: options.resendCooldownMs,
      resendWindowMs: options.resendWindowMs,
      resendMaxPerWindow: options.authRateLimitMaxOverrides?.resendVerification,
      now: options.now,
    })
  );
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use(
    '/api/v1/trips',
    createTripRouter({
      rateLimiters: tripRateLimiters,
      emailDeliveryService: options.emailDeliveryService,
    })
  );
  app.use('/api/v1/shared', publicSharedRouter);

  app.use(errorHandler);

  return app;
}
