import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { EMAIL_VERIFICATION_TTL_MINUTES } from '@tripledger/shared';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  userId: string;
  email: string;
  name: string;
}

export interface RefreshTokenPayload {
  userId: string;
  tokenVersion?: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(
    { ...payload, jti: crypto.randomUUID() },
    env.JWT_REFRESH_SECRET,
    {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    }
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateInviteCode(length = 8): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length).toUpperCase();
}

export function generateShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export interface GeneratedEmailVerificationToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface GeneratedParticipantInviteToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateEmailVerificationToken(
  ttlMinutes = EMAIL_VERIFICATION_TTL_MINUTES
): GeneratedEmailVerificationToken {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  return { rawToken, tokenHash, expiresAt };
}

export function generateParticipantInviteToken(
  ttlHours: number
): GeneratedParticipantInviteToken {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  return { rawToken, tokenHash, expiresAt };
}
