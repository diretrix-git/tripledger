import dotenv from 'dotenv';
import path from 'path';
import {
  EMAIL_DELIVERY_PROVIDERS,
  type EmailDeliveryProvider,
} from '@tripledger/shared';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config();

export const DEV_PLACEHOLDER_ACCESS_SECRET =
  'tripledger-dev-access-secret-do-not-use-in-prod-998877';
export const DEV_PLACEHOLDER_REFRESH_SECRET =
  'tripledger-dev-refresh-secret-do-not-use-in-prod-112233';

export type RateLimitStoreType = 'mongo' | 'memory';
export type DeploymentTopology = 'multi-instance' | 'single-instance';

export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  CLIENT_URL: string;
  MONGODB_URI: string;
  USE_IN_MEMORY_DB: boolean;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_EXPIRES_IN: string;
  JWT_REFRESH_EXPIRES_IN: string;
  BCRYPT_SALT_ROUNDS: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  RATE_LIMIT_STORE: RateLimitStoreType;
  DEPLOYMENT_TOPOLOGY: DeploymentTopology;
  TRUST_PROXY: string | undefined;
  AUTH_RATE_LIMIT_WINDOW_MS: number;
  AUTH_LOGIN_RATE_LIMIT_MAX: number;
  AUTH_REGISTER_RATE_LIMIT_MAX: number;
  AUTH_VERIFY_EMAIL_RATE_LIMIT_MAX: number;
  AUTH_RESEND_VERIFICATION_RATE_LIMIT_MAX: number;
  TRIP_JOIN_RATE_LIMIT_MAX: number;
  EMAIL_PROVIDER: EmailDeliveryProvider;
  EMAIL_FROM: string;
  EMAIL_DELIVERY_TIMEOUT_MS: number;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASS: string;
  EMAIL_WEBHOOK_URL: string;
  EMAIL_WEBHOOK_API_KEY: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveDefaultEmailProvider(raw: string | undefined, nodeEnv: string): EmailDeliveryProvider {
  const normalized = raw?.trim().toUpperCase();
  if (normalized) {
    return normalized as EmailDeliveryProvider;
  }
  return nodeEnv === 'production' ? 'DISABLED' : 'MEMORY';
}

function resolveDefaultRateLimitStore(raw: string | undefined, nodeEnv: string): RateLimitStoreType {
  const normalized = raw?.trim().toLowerCase();
  if (normalized) {
    return normalized as RateLimitStoreType;
  }
  return nodeEnv === 'production' ? 'mongo' : 'memory';
}

function resolveDeploymentTopology(raw: string | undefined): DeploymentTopology {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return 'multi-instance';
  return normalized as DeploymentTopology;
}

export function buildEnvConfig(rawEnv: NodeJS.ProcessEnv = process.env): EnvConfig {
  const nodeEnv = (rawEnv.NODE_ENV ?? 'development').trim() || 'development';
  const defaultFrom =
    nodeEnv === 'production' ? '' : 'TripLedger <no-reply@tripledger.local>';

  return {
    NODE_ENV: nodeEnv,
    PORT: parsePositiveInt(rawEnv.PORT, 5000),
    CLIENT_URL: (rawEnv.CLIENT_URL ?? 'http://localhost:5173').trim(),
    MONGODB_URI: (rawEnv.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/tripledger').trim(),
    USE_IN_MEMORY_DB: rawEnv.USE_IN_MEMORY_DB === 'true',
    JWT_ACCESS_SECRET: rawEnv.JWT_ACCESS_SECRET ?? DEV_PLACEHOLDER_ACCESS_SECRET,
    JWT_REFRESH_SECRET: rawEnv.JWT_REFRESH_SECRET ?? DEV_PLACEHOLDER_REFRESH_SECRET,
    JWT_ACCESS_EXPIRES_IN: (rawEnv.JWT_ACCESS_EXPIRES_IN ?? '15m').trim(),
    JWT_REFRESH_EXPIRES_IN: (rawEnv.JWT_REFRESH_EXPIRES_IN ?? '7d').trim(),
    BCRYPT_SALT_ROUNDS: parsePositiveInt(rawEnv.BCRYPT_SALT_ROUNDS, 10),
    RATE_LIMIT_WINDOW_MS: parsePositiveInt(rawEnv.RATE_LIMIT_WINDOW_MS, 900_000),
    RATE_LIMIT_MAX_REQUESTS: parsePositiveInt(rawEnv.RATE_LIMIT_MAX_REQUESTS, 500),
    RATE_LIMIT_STORE: resolveDefaultRateLimitStore(rawEnv.RATE_LIMIT_STORE, nodeEnv),
    DEPLOYMENT_TOPOLOGY: resolveDeploymentTopology(rawEnv.DEPLOYMENT_TOPOLOGY),
    TRUST_PROXY: rawEnv.TRUST_PROXY?.trim() || undefined,
    AUTH_RATE_LIMIT_WINDOW_MS: parsePositiveInt(rawEnv.AUTH_RATE_LIMIT_WINDOW_MS, 900_000),
    AUTH_LOGIN_RATE_LIMIT_MAX: parsePositiveInt(rawEnv.AUTH_LOGIN_RATE_LIMIT_MAX, 15),
    AUTH_REGISTER_RATE_LIMIT_MAX: parsePositiveInt(rawEnv.AUTH_REGISTER_RATE_LIMIT_MAX, 10),
    AUTH_VERIFY_EMAIL_RATE_LIMIT_MAX: parsePositiveInt(
      rawEnv.AUTH_VERIFY_EMAIL_RATE_LIMIT_MAX,
      20
    ),
    AUTH_RESEND_VERIFICATION_RATE_LIMIT_MAX: parsePositiveInt(
      rawEnv.AUTH_RESEND_VERIFICATION_RATE_LIMIT_MAX,
      5
    ),
    TRIP_JOIN_RATE_LIMIT_MAX: parsePositiveInt(rawEnv.TRIP_JOIN_RATE_LIMIT_MAX, 10),
    EMAIL_PROVIDER: resolveDefaultEmailProvider(rawEnv.EMAIL_PROVIDER, nodeEnv),
    EMAIL_FROM: (rawEnv.EMAIL_FROM ?? defaultFrom).trim(),
    EMAIL_DELIVERY_TIMEOUT_MS: parsePositiveInt(rawEnv.EMAIL_DELIVERY_TIMEOUT_MS, 10_000),
    SMTP_HOST: (rawEnv.SMTP_HOST ?? '').trim(),
    SMTP_PORT: parsePositiveInt(rawEnv.SMTP_PORT, 587),
    SMTP_SECURE: rawEnv.SMTP_SECURE === 'true',
    SMTP_USER: (rawEnv.SMTP_USER ?? '').trim(),
    SMTP_PASS: rawEnv.SMTP_PASS ?? '',
    EMAIL_WEBHOOK_URL: (rawEnv.EMAIL_WEBHOOK_URL ?? '').trim(),
    EMAIL_WEBHOOK_API_KEY: (rawEnv.EMAIL_WEBHOOK_API_KEY ?? '').trim(),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]' ||
    lower === '0.0.0.0' ||
    lower.endsWith('.localhost')
  );
}

function isValidEmailFrom(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const bracketMatch = trimmed.match(/^[^<>]+<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/);
  if (bracketMatch) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bracketMatch[1]);
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function validateClientUrl(clientUrl: string, nodeEnv: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    throw new Error(`Invalid CLIENT_URL: "${clientUrl}". Must be a valid absolute URL.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('CLIENT_URL must not contain embedded user credentials.');
  }

  if (nodeEnv === 'production') {
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `CLIENT_URL must use https:// in production for verification links (received ${parsed.protocol}).`
      );
    }
    if (isLoopbackHost(parsed.hostname)) {
      throw new Error(
        `CLIENT_URL hostname "${parsed.hostname}" cannot be localhost or loopback in production.`
      );
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`CLIENT_URL must use http:// or https:// (received ${parsed.protocol}).`);
  }

  return parsed;
}

export function parseTrustProxySetting(
  rawTrustProxy: string | undefined,
  nodeEnv: string
): boolean | number | string | string[] {
  if (!rawTrustProxy || rawTrustProxy.trim() === '') {
    return false;
  }

  const trimmed = rawTrustProxy.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'false' || lower === '0') {
    return false;
  }

  if (lower === 'true' || lower === 'yes' || lower === 'all' || trimmed === '*') {
    if (nodeEnv === 'production') {
      throw new Error(
        'TRUST_PROXY="true" / wildcard is prohibited in production because any client could spoof IP rate-limit headers. Specify hop count (e.g. "1") or trusted proxy preset/subnets (e.g. "loopback").'
      );
    }
    return true;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const parts = trimmed
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid TRUST_PROXY setting: "${rawTrustProxy}".`);
  }
  return parts.length === 1 ? parts[0] : parts;
}

export function validateEmailConfig(config: EnvConfig): void {
  if (!(EMAIL_DELIVERY_PROVIDERS as readonly string[]).includes(config.EMAIL_PROVIDER)) {
    throw new Error(
      `Invalid EMAIL_PROVIDER "${String(config.EMAIL_PROVIDER)}". Expected one of: ${EMAIL_DELIVERY_PROVIDERS.join(', ')}.`
    );
  }

  const isProd = config.NODE_ENV === 'production';
  if (isProd && (config.EMAIL_PROVIDER === 'DISABLED' || config.EMAIL_PROVIDER === 'MEMORY')) {
    throw new Error(
      `EMAIL_PROVIDER="${config.EMAIL_PROVIDER}" is prohibited in production. Configure SMTP or WEBHOOK before starting the server.`
    );
  }

  if (config.EMAIL_PROVIDER === 'DISABLED') {
    return;
  }

  if (!isValidEmailFrom(config.EMAIL_FROM)) {
    throw new Error(
      'EMAIL_FROM must be configured as a valid email or "Sender Name <email@domain>" when email delivery is enabled.'
    );
  }

  if (config.EMAIL_PROVIDER === 'SMTP') {
    if (!config.SMTP_HOST) {
      throw new Error('SMTP_HOST is required when EMAIL_PROVIDER is SMTP.');
    }
    if (!Number.isFinite(config.SMTP_PORT) || config.SMTP_PORT < 1 || config.SMTP_PORT > 65535) {
      throw new Error('SMTP_PORT must be a valid TCP port (1-65535).');
    }
    if (isProd && (!config.SMTP_USER || !config.SMTP_PASS)) {
      throw new Error('SMTP_USER and SMTP_PASS are required for SMTP in production.');
    }
    return;
  }

  if (config.EMAIL_PROVIDER === 'WEBHOOK') {
    let webhookUrl: URL;
    try {
      webhookUrl = new URL(config.EMAIL_WEBHOOK_URL);
    } catch {
      throw new Error('EMAIL_WEBHOOK_URL must be a valid URL when EMAIL_PROVIDER is WEBHOOK.');
    }
    if (webhookUrl.username || webhookUrl.password) {
      throw new Error('EMAIL_WEBHOOK_URL must not contain embedded credentials.');
    }
    if (isProd && webhookUrl.protocol !== 'https:') {
      throw new Error('EMAIL_WEBHOOK_URL must use https:// in production.');
    }
    if (!isProd && webhookUrl.protocol !== 'http:' && webhookUrl.protocol !== 'https:') {
      throw new Error('EMAIL_WEBHOOK_URL must use http:// or https://.');
    }
    if (!config.EMAIL_WEBHOOK_API_KEY) {
      throw new Error('EMAIL_WEBHOOK_API_KEY is required when EMAIL_PROVIDER is WEBHOOK.');
    }
  }
}

export function validateRateLimitTopologyConfig(config: EnvConfig): void {
  if (config.RATE_LIMIT_STORE !== 'mongo' && config.RATE_LIMIT_STORE !== 'memory') {
    throw new Error(
      `Invalid RATE_LIMIT_STORE "${String(config.RATE_LIMIT_STORE)}". Expected "mongo" or "memory".`
    );
  }
  if (
    config.DEPLOYMENT_TOPOLOGY !== 'multi-instance' &&
    config.DEPLOYMENT_TOPOLOGY !== 'single-instance'
  ) {
    throw new Error(
      `Invalid DEPLOYMENT_TOPOLOGY "${String(config.DEPLOYMENT_TOPOLOGY)}". Expected "multi-instance" or "single-instance".`
    );
  }

  if (config.NODE_ENV === 'production' && config.RATE_LIMIT_STORE === 'memory') {
    if (config.DEPLOYMENT_TOPOLOGY !== 'single-instance') {
      throw new Error(
        'RATE_LIMIT_STORE="memory" cannot protect multi-instance production deployments. Use RATE_LIMIT_STORE="mongo" (default) or explicitly set DEPLOYMENT_TOPOLOGY="single-instance" if running a single process.'
      );
    }
  }
}

export function validateMongoUri(mongoUri: string, nodeEnv: string): void {
  const trimmed = mongoUri.trim();
  if (
    !trimmed ||
    (!trimmed.startsWith('mongodb://') && !trimmed.startsWith('mongodb+srv://'))
  ) {
    throw new Error(
      'MONGODB_URI must be a valid mongodb:// or mongodb+srv:// connection string.'
    );
  }

  if (nodeEnv === 'production') {
    const hostMatch = trimmed.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?([^/?,]+)/i);
    const firstHost = (hostMatch?.[1] ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (!firstHost || isLoopbackHost(firstHost)) {
      throw new Error(
        `MONGODB_URI host "${firstHost || 'empty'}" cannot be localhost or loopback in production. Configure a MongoDB Atlas or remote replica-set connection string.`
      );
    }
  }
}

export function validateProductionStartupConfig(config: EnvConfig): void {
  validateClientUrl(config.CLIENT_URL, config.NODE_ENV);
  validateMongoUri(config.MONGODB_URI, config.NODE_ENV);
  parseTrustProxySetting(config.TRUST_PROXY, config.NODE_ENV);
  validateEmailConfig(config);
  validateRateLimitTopologyConfig(config);

  if (config.NODE_ENV === 'production') {
    if (
      config.JWT_ACCESS_SECRET === DEV_PLACEHOLDER_ACCESS_SECRET ||
      config.JWT_ACCESS_SECRET.length < 32
    ) {
      throw new Error(
        'JWT_ACCESS_SECRET must be set to a strong secret (>= 32 chars) in production.'
      );
    }
    if (
      config.JWT_REFRESH_SECRET === DEV_PLACEHOLDER_REFRESH_SECRET ||
      config.JWT_REFRESH_SECRET.length < 32
    ) {
      throw new Error(
        'JWT_REFRESH_SECRET must be set to a strong secret (>= 32 chars) in production.'
      );
    }
  }
}

export const env: EnvConfig = buildEnvConfig(process.env);
