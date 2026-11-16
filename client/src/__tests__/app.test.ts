import { beforeEach, describe, expect, it } from 'vitest';
import { formatPaisaToNPR, nprToPaisa } from '@tripledger/shared';
import { useAuthStore } from '../stores/authStore.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';

describe('TripLedger Client Shared Currency & Offline Expense Queue', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({
      isOnline: true,
      isSyncing: false,
      queue: [],
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

  it('enqueues offline expenses with clientMutationId and prevents duplicate queue entries', () => {
    const sampleExpense = {
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

    useOfflineQueueStore.getState().enqueueExpense(sampleExpense);
    useOfflineQueueStore.getState().enqueueExpense(sampleExpense); // duplicate call

    const queue = useOfflineQueueStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].syncStatus).toBe('PENDING');

    useOfflineQueueStore.getState().removeQueuedExpense('uuid-offline-test-1');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
  });
});
