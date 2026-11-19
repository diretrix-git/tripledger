import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPaisaToNPR, nprToPaisa } from '@tripledger/shared';
import { useAuthStore } from '../stores/authStore.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';
import { generateUUID } from '../utils/uuid.js';

describe('TripLedger Client Shared Currency & Offline Expense Queue', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({
      isOnline: true,
      isSyncing: false,
      activeUserId: null,
      queue: [],
      legacyDiscardedCount: 0,
    });
  });

  it('tracks unverified vs verified user state in authStore accurately', () => {
    useAuthStore.getState().setAuth(
      {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        emailVerified: false,
        emailVerifiedAt: null,
        defaultCurrency: 'NPR',
      },
      'access-1',
      'refresh-1'
    );
    expect(useAuthStore.getState().user?.emailVerified).toBe(false);

    useAuthStore.getState().updateUser({
      id: 'u1',
      name: 'Alice',
      email: 'alice@example.com',
      emailVerified: true,
      emailVerifiedAt: '2026-11-16T05:00:00.000Z',
      defaultCurrency: 'NPR',
    });
    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
  });

  it('consumes @tripledger/shared paisa formatting accurately', () => {
    const paisa = nprToPaisa('1500.50');
    expect(paisa).toBe(150050);
    expect(formatPaisaToNPR(paisa)).toBe('NPR 1,500.50');
  });

  it('enqueues offline expenses strictly for the active authenticated user, enforces deduplication, and rejects unauthenticated or mismatched callers', async () => {
    const sampleExpense = {
      userId: 'u1',
      clientMutationId: 'uuid-offline-test-1',
      tripId: 'trip-1',
      tripName: 'Mustang Road Trip',
      payload: {
        title: 'Parking Fee',
        category: 'PARKING_TOLLS' as const,
        amountPaisa: 20000,
        isEstimated: false,
        isPackage: false,
        splitMethod: 'EQUAL' as const,
        paymentMethod: 'CASH' as const,
        incurredAt: new Date().toISOString(),
        payments: [{ participantId: 'p1', amountPaisa: 20000 }],
        clientMutationId: 'uuid-offline-test-1',
      },
    };

    // Unauthenticated enqueue is rejected
    expect(await useOfflineQueueStore.getState().enqueueExpense(sampleExpense)).toBe(false);
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    // Authenticate u1
    useAuthStore.getState().setAuth(
      {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        emailVerified: true,
        emailVerifiedAt: '2026-11-16T05:00:00.000Z',
        defaultCurrency: 'NPR',
      },
      'access-1',
      'refresh-1'
    );

    // Mismatched userId is rejected even while u1 is signed in
    expect(
      await useOfflineQueueStore.getState().enqueueExpense({
        ...sampleExpense,
        userId: 'u2',
        clientMutationId: 'uuid-mismatched-1',
      })
    ).toBe(false);

    expect(await useOfflineQueueStore.getState().enqueueExpense(sampleExpense)).toBe(true);
    expect(await useOfflineQueueStore.getState().enqueueExpense(sampleExpense)).toBe(true); // duplicate call deduplicated

    const queue = useOfflineQueueStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].userId).toBe('u1');
    expect(queue[0].syncStatus).toBe('PENDING');

    await useOfflineQueueStore.getState().removeQueuedExpense('uuid-offline-test-1');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
  });

  it('generates RFC 4122 v4 UUIDs via crypto.randomUUID when available and falls back to crypto.getRandomValues on non-secure HTTP LAN origins without using Math.random', () => {
    const RFC4122_V4_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const mathRandomSpy = vi.spyOn(Math, 'random');

    try {
      // 1. Primary path: native crypto.randomUUID()
      const nativeSpy = vi.fn(() => '12345678-1234-4123-8123-123456789abc');
      const fallbackSpy = vi.fn();
      const idFromNative = generateUUID({
        randomUUID: nativeSpy,
        getRandomValues: fallbackSpy,
      });
      expect(idFromNative).toBe('12345678-1234-4123-8123-123456789abc');
      expect(nativeSpy).toHaveBeenCalledTimes(1);
      expect(fallbackSpy).not.toHaveBeenCalled();

      // 2. Fallback path: non-secure HTTP LAN context where crypto.randomUUID is undefined
      const idFromFallback1 = generateUUID({
        randomUUID: undefined,
        getRandomValues: <T extends ArrayBufferView>(arr: T): T =>
          globalThis.crypto.getRandomValues(arr),
      });
      const idFromFallback2 = generateUUID({
        randomUUID: undefined,
        getRandomValues: <T extends ArrayBufferView>(arr: T): T =>
          globalThis.crypto.getRandomValues(arr),
      });

      expect(idFromFallback1).toMatch(RFC4122_V4_REGEX);
      expect(idFromFallback2).toMatch(RFC4122_V4_REGEX);
      expect(idFromFallback1).not.toBe(idFromFallback2);

      // Verify deterministic RFC 4122 version (4) and variant (10xx) bit masking on known bytes
      const deterministicId = generateUUID({
        getRandomValues: <T extends ArrayBufferView>(arr: T): T => {
          const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
          for (let i = 0; i < view.length; i++) {
            view[i] = 0xff;
          }
          return arr;
        },
      });
      expect(deterministicId).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
      expect(deterministicId).toMatch(RFC4122_V4_REGEX);

      // 3. Fail-closed path when neither CSPRNG method is available
      expect(() => generateUUID(null)).toThrow(
        'Cryptographically secure UUID generation is unavailable in this environment.'
      );
      expect(() => generateUUID({})).toThrow(
        'Cryptographically secure UUID generation is unavailable in this environment.'
      );
      expect(mathRandomSpy).not.toHaveBeenCalled();
    } finally {
      mathRandomSpy.mockRestore();
    }
  });
});
