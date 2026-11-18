import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';
import {
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
} from '../stores/authStore.js';

/**
 * Monitors browser online/offline state and automatically synchronizes queued
 * offline expenses scoped strictly to the active authenticated user with server-side
 * idempotency (`clientMutationId`) when connectivity returns.
 */
export function useOfflineSync() {
  const queryClient = useQueryClient();
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
  } = useOfflineQueueStore();

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
    useOfflineQueueStore.getState().syncAuthContext();
    const startSession = captureAuthSessionSnapshot();
    if (!startSession.hasAccessToken || !startSession.userId) {
      return;
    }
    const startUserId = startSession.userId;

    const currentState = useOfflineQueueStore.getState();
    if (
      !currentState.isOnline ||
      currentState.isSyncing ||
      currentState.activeUserId !== startUserId ||
      currentState.queue.length === 0
    ) {
      return;
    }

    const candidates = currentState.queue.filter(
      (item) => typeof item.userId === 'string' && item.userId === startUserId && item.syncStatus !== 'SYNCING'
    );
    if (candidates.length === 0) {
      return;
    }

    setSyncing(true);
    try {
      for (const item of candidates) {
        if (
          !isSameAuthSession(startSession, { requireAuthenticated: true }) ||
          !useOfflineQueueStore.getState().isOnline
        ) {
          break;
        }
        if (typeof item.userId !== 'string' || item.userId !== startUserId) {
          continue;
        }

        markItemStatus(item.clientMutationId, 'SYNCING', undefined, startUserId);
        try {
          await apiRequest(`/trips/${item.tripId}/expenses`, {
            method: 'POST',
            body: JSON.stringify(item.payload),
          });
          removeQueuedExpense(item.clientMutationId, startUserId);
          if (isSameAuthSession(startSession, { requireAuthenticated: true })) {
            await queryClient.invalidateQueries({
              queryKey: ['trip', item.tripId, startUserId],
            });
          }
        } catch (err) {
          if (isSameAuthSession(startSession, { requireAuthenticated: true })) {
            markItemStatus(
              item.clientMutationId,
              'FAILED',
              err instanceof Error ? err.message : 'Sync failed',
              startUserId
            );
          } else {
            // Session changed or logged out mid-request: revert item status in startUserId's
            // own storage so it is preserved safely for startUserId's next login.
            markItemStatus(item.clientMutationId, 'PENDING', undefined, startUserId);
          }
        }
      }

      if (isSameAuthSession(startSession, { requireAuthenticated: true })) {
        await queryClient.invalidateQueries({ queryKey: ['dashboard', startUserId] });
        await queryClient.invalidateQueries({ queryKey: ['trips', startUserId] });
      }
    } finally {
      if (isSameAuthSession(startSession)) {
        setSyncing(false);
      }
    }
  }, [markItemStatus, queryClient, removeQueuedExpense, setSyncing]);

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
  }, [isOnline, accessToken, activeUserId, currentUserId, userScopedQueue, flushOfflineQueue]);

  return {
    isOnline,
    isSyncing,
    queue: userScopedQueue,
    legacyDiscardedCount,
    dismissLegacyNotice,
    flushOfflineQueue,
  };
}
