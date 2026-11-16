import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_INVITE_ROLE,
  DEFAULT_PARTICIPANT_INVITE_TTL_HOURS,
  MAX_PARTICIPANT_INVITE_TTL_HOURS,
  PRIVILEGED_TRIP_ROLES,
  isPrivilegedTripRole,
} from '../../constants/index.js';
import {
  claimParticipantInviteSchema,
  createParticipantInviteSchema,
  createParticipantSchema,
  joinTripSchema,
  resolveParticipantInvitePolicy,
  updateProfileSchema,
  updateTripSchema,
  verifyEmailSchema,
} from '../index.js';
import type { TripSummaryEntity } from '../../types/index.js';

describe('Shared security contracts: invite roles, schemas, and policy', () => {
  it('defaults open invite-code joins strictly to PARTICIPANT and defines privileged roles', () => {
    expect(DEFAULT_OPEN_INVITE_ROLE).toBe('PARTICIPANT');
    expect(PRIVILEGED_TRIP_ROLES).toEqual(['ORGANIZER', 'FAMILY_REP']);
    expect(isPrivilegedTripRole('ORGANIZER')).toBe(true);
    expect(isPrivilegedTripRole('FAMILY_REP')).toBe(true);
    expect(isPrivilegedTripRole('CONTRIBUTOR')).toBe(false);
    expect(isPrivilegedTripRole('PARTICIPANT')).toBe(false);
  });

  it('requires verified matching intendedEmail for ORGANIZER and FAMILY_REP invitations', () => {
    expect(() =>
      resolveParticipantInvitePolicy({ role: 'ORGANIZER', intendedEmail: null })
    ).toThrow(/intendedEmail/i);
    expect(() =>
      resolveParticipantInvitePolicy({ role: 'FAMILY_REP', intendedEmail: '   ' })
    ).toThrow(/intendedEmail/i);
    expect(() =>
      resolveParticipantInvitePolicy({ role: 'ORGANIZER', intendedEmail: 'bad-email' })
    ).toThrow();
    expect(() =>
      resolveParticipantInvitePolicy({
        role: 'ORGANIZER',
        intendedEmail: 'org@example.com',
        requireVerifiedEmail: false,
      })
    ).toThrow(/require email verification/i);
    expect(() =>
      resolveParticipantInvitePolicy({
        role: 'FAMILY_REP',
        intendedEmail: 'rep@example.com',
        requireVerifiedEmail: false,
      })
    ).toThrow(/require email verification/i);

    expect(
      resolveParticipantInvitePolicy({
        role: 'ORGANIZER',
        intendedEmail: '  Org.User@Example.COM ',
      })
    ).toEqual({
      intendedEmail: 'org.user@example.com',
      requireVerifiedEmail: true,
    });

    expect(
      resolveParticipantInvitePolicy({
        role: 'FAMILY_REP',
        intendedEmail: 'Rep.User@Example.COM',
      })
    ).toEqual({
      intendedEmail: 'rep.user@example.com',
      requireVerifiedEmail: true,
    });
  });

  it('allows capability invites without email for non-privileged roles and enforces verification when email-bound', () => {
    expect(
      resolveParticipantInvitePolicy({
        role: 'PARTICIPANT',
        intendedEmail: null,
      })
    ).toEqual({
      intendedEmail: null,
      requireVerifiedEmail: false,
    });

    expect(
      resolveParticipantInvitePolicy({
        role: 'CONTRIBUTOR',
        intendedEmail: null,
        requireVerifiedEmail: true,
      })
    ).toEqual({
      intendedEmail: null,
      requireVerifiedEmail: true,
    });

    expect(() =>
      resolveParticipantInvitePolicy({
        role: 'CONTRIBUTOR',
        intendedEmail: 'friend@example.com',
        requireVerifiedEmail: false,
      })
    ).toThrow(/verified email ownership/i);

    expect(
      resolveParticipantInvitePolicy({
        role: 'PARTICIPANT',
        intendedEmail: 'Guest@Example.com',
      })
    ).toEqual({
      intendedEmail: 'guest@example.com',
      requireVerifiedEmail: true,
    });
  });

  it('validates invite creation, claim, email verification, joinTrip, and updateTrip schemas', () => {
    const defaultInvite = createParticipantInviteSchema.parse({});
    expect(defaultInvite.intendedEmail).toBeUndefined();
    expect(defaultInvite.expiresInHours).toBe(DEFAULT_PARTICIPANT_INVITE_TTL_HOURS);

    const emailInvite = createParticipantInviteSchema.parse({
      intendedEmail: '  Test@Example.COM ',
      expiresInHours: MAX_PARTICIPANT_INVITE_TTL_HOURS,
    });
    expect(emailInvite.intendedEmail).toBe('test@example.com');
    expect(emailInvite.expiresInHours).toBe(168);

    const emptyEmailInvite = createParticipantInviteSchema.parse({ intendedEmail: '' });
    expect(emptyEmailInvite.intendedEmail).toBeUndefined();

    expect(() =>
      createParticipantInviteSchema.parse({ expiresInHours: MAX_PARTICIPANT_INVITE_TTL_HOURS + 1 })
    ).toThrow();
    expect(() => createParticipantInviteSchema.parse({ expiresInHours: 0 })).toThrow();

    expect(claimParticipantInviteSchema.parse({ token: '  abc123def456ghi789  ' }).token).toBe(
      'abc123def456ghi789'
    );
    expect(() => claimParticipantInviteSchema.parse({ token: 'short' })).toThrow();

    expect(verifyEmailSchema.parse({ token: '  verify-token-12345678  ' }).token).toBe(
      'verify-token-12345678'
    );
    expect(() => verifyEmailSchema.parse({ token: 'tiny' })).toThrow();

    // Profile updates forbid changing account email
    expect(updateProfileSchema.parse({ name: 'New Name', phone: '9841000000' })).toEqual({
      name: 'New Name',
      phone: '9841000000',
    });
    expect(() =>
      updateProfileSchema.parse({ name: 'New Name', email: 'other@example.com' })
    ).toThrow();

    expect(joinTripSchema.parse({})).toEqual({});
    expect(() => joinTripSchema.parse({ guestParticipantId: '507f1f77bcf86cd799439011' })).toThrow();

    expect(
      updateTripSchema.parse({
        inviteEnabled: false,
        inviteExpiresAt: '2026-12-01T12:00:00.000Z',
      })
    ).toEqual({
      inviteEnabled: false,
      inviteExpiresAt: '2026-12-01T12:00:00.000Z',
    });
    expect(
      updateTripSchema.parse({
        inviteExpiresAt: '2026-12-01T12:00:00+05:45',
      })
    ).toEqual({
      inviteExpiresAt: '2026-12-01T12:00:00+05:45',
    });
    expect(updateTripSchema.parse({ inviteExpiresAt: null })).toEqual({ inviteExpiresAt: null });
    expect(() => updateTripSchema.parse({ inviteExpiresAt: 'not-a-date' })).toThrow();
    expect(() => updateTripSchema.parse({ inviteExpiresAt: '' })).toThrow();
    expect(() => updateTripSchema.parse({ inviteExpiresAt: '1' })).toThrow();
    expect(() => updateTripSchema.parse({ inviteExpiresAt: '2026' })).toThrow();
    expect(() => updateTripSchema.parse({ inviteExpiresAt: '2026-12-01T12:00:00' })).toThrow();
    expect(() => updateTripSchema.parse({ inviteExpiresAt: '2026-02-31T12:00:00Z' })).toThrow();
  });

  it('preserves compatibility with existing API/frontend trip and offline guest payloads', () => {
    // Existing Trip update payloads without Phase 1 fields continue passing
    expect(
      updateTripSchema.parse({
        name: 'Mustang Road Trip',
        budgetPaisa: 500000,
        shareEnabled: false,
      })
    ).toEqual({
      name: 'Mustang Road Trip',
      budgetPaisa: 500000,
      shareEnabled: false,
    });

    // Offline FAMILY_REP guest placeholders without email still pass createParticipantSchema
    expect(
      createParticipantSchema.parse({
        name: 'Dipesh Thapa',
        role: 'FAMILY_REP',
        memberType: 'ADULT',
        familyId: 'fam-1',
      })
    ).toMatchObject({
      name: 'Dipesh Thapa',
      role: 'FAMILY_REP',
      memberType: 'ADULT',
    });

    // Existing TripSummaryEntity shape remains structurally compatible with frontend expectations
    const legacyTripSummary: TripSummaryEntity = {
      id: 'trip-1',
      name: 'Pokhara Trip',
      mode: 'FRIENDS',
      status: 'ACTIVE',
      currency: 'NPR',
      inviteCode: 'PKR12345',
      shareToken: 'share-123',
      shareEnabled: true,
      checklist: [],
    };
    expect(legacyTripSummary.inviteCode).toBe('PKR12345');
  });
});
