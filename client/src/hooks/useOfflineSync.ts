import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import {
  useOfflineQueueStore,
  type OfflineQueueStore,
} from '../stores/offlineQueueStore.js';
import {
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
} from '../stores/authStore.js';

/**
 * Monitors browser online/offline state and automatically synchronizes queued
 * offline expenses scoped strictly to the active authenticated user with cross-tab
 * lock coordination (when Web Locks API is available) and server-side `clientMutationId`
 * idempotency.
 */
export function useOfflineSync(queueStore: OfflineQueueStore = useOfflineQueueStore) {
  const queryClient = useQueryClient();
  const inFlightFlushRef = useRef(false);
  const accessToken = useAuthStore((s) => s.accessToken);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const {
    isOnline,
    isSyncing,
    activeUserId,
    queue,
    legacyDiscardedCount,
    setOnlineStatus,
    setSyncing,
    dismissLegacyNotice,
    syncAuthContext,
    markItemStatus,
    removeQueuedExpense,
  } = queueStore();

  useEffect(() => {
    syncAuthContext();
  }, [accessToken, currentUserId, syncAuthContext]);

  const userScopedQueue = useMemo(() => {
    if (!accessToken || !currentUserId || activeUserId !== currentUserId) {
      return [];
    }
    return queue.filter((q) => q.userId === currentUserId);
  }, [accessToken, activeUserId, currentUserId, queue]);

  const flushOfflineQueue = useCallback(async () => {
    if (inFlightFlushRef.current) {
      return;
    }

    queueStore.getState().syncAuthContext();
    const startSession = captureAuthSessionSnapshot();
    if (!startSession.hasAccessToken || !startSession.userId) {
      return;
    }
    const startUserId = startSession.userId;

    const currentState = queueStore.getState();
    if (
      !currentState.isOnline ||
      currentState.isSyncing ||
      currentState.activeUserId !== startUserId
    ) {
      return;
    }

    inFlightFlushRef.current = true;
    try {
      await queueStore.getState().tryWithUserSyncLock(startUserId, async () => {
        let didStartSyncing = false;
        let flushedAnySuccess = false;
        const attemptedIds = new Set<string>();

        try {
          while (
            isSameAuthSession(startSession, { requireAuthenticated: true }) &&
            queueStore.getState().isOnline
          ) {
            const latestQueue = await queueStore
              .getState()
              .refreshUserQueueFromStorage(startUserId);
            const candidates = latestQueue.filter(
              (item) =>
                typeof item.userId === 'string' &&
                item.userId === startUserId &&
                item.syncStatus !== 'SYNCING' &&
                !attemptedIds.has(item.clientMutationId)
            );
            if (candidates.length === 0) {
              if (flushedAnySuccess) {
                flushedAnySuccess = false;
                if (isSameAuthSession(startSession, { requireAuthenticated: true })) {
                  await queryClient.invalidateQueries({ queryKey: ['dashboard', startUserId] });
                  await queryClient.invalidateQueries({ queryKey: ['trips', startUserId] });
                }
                // Re-check storage in case another tab enqueued while queries invalidated.
                continue;
              }
              break;
            }

            if (!didStartSyncing) {
              didStartSyncing = true;
              setSyncing(true);
            }

            for (const item of candidates) {
              attemptedIds.add(item.clientMutationId);
              if (
                !isSameAuthSession(startSession, { requireAuthenticated: true }) ||
                !queueStore.getState().isOnline
              ) {
                break;
              }
              if (typeof item.userId !== 'string' || item.userId !== startUserId) {
                continue;
              }

              await markItemStatus(item.clientMutationId, 'SYNCING', undefined, startUserId);
              if (
                !isSameAuthSession(startSession, { requireAuthenticated: true }) ||
                !queueStore.getState().isOnline
              ) {
                await markItemStatus(item.clientMutationId, 'PENDING', undefined, startUserId);
                break;
              }

              try {
                await apiRequest(`/trips/${item.tripId}/expenses`, {
                  method: 'POST',
                  body: JSON.stringify(item.payload),
                });
                await removeQueuedExpense(item.clientMutationId, startUserId);
                flushedAnySuccess = true;
                if (isSameAuthSession(startSession, { requireAuthenticated: true })) {
                  await queryClient.invalidateQueries({
                    queryKey: ['trip', item.tripId, startUserId],
                  });
                }
              } catch (err) {
                if (isSameAuthSession(startSession, { requireAuthenticated: true })) {
                  await markItemStatus(
                    item.clientMutationId,
                    'FAILED',
                    err instanceof Error ? err.message : 'Sync failed',
                    startUserId
                  );
                } else {
                  // Session changed or logged out mid-request: revert item status in startUserId's
                  // own storage so it is preserved safely for startUserId's next login.
                  await markItemStatus(item.clientMutationId, 'PENDING', undefined, startUserId);
                }
              }
            }
          }
        } finally {
          if (didStartSyncing && isSameAuthSession(startSession)) {
            setSyncing(false);
          }
        }
      });
    } finally {
      inFlightFlushRef.current = false;
    }
  }, [markItemStatus, queryClient, queueStore, removeQueuedExpense, setSyncing]);

  useEffect(() => {
    const handleOnline = () => {
      setOnlineStatus(true);
      void flushOfflineQueue();
    };
    const handleOffline = () => {
      setOnlineStatus(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [flushOfflineQueue, setOnlineStatus]);

  useEffect(() => {
    if (
      isOnline &&
      accessToken &&
      currentUserId &&
      activeUserId === currentUserId &&
      userScopedQueue.some((q) => q.syncStatus === 'PENDING')
    ) {
      void flushOfflineQueue();
    }
  }, [
    isOnline,
    accessToken,
    activeUserId,
    currentUserId,
    userScopedQueue,
    flushOfflineQueue,
  ]);

  return {
    isOnline,
    isSyncing,
    queue: userScopedQueue,
    legacyDiscardedCount,
    dismissLegacyNotice,
    flushOfflineQueue,
  };
}
