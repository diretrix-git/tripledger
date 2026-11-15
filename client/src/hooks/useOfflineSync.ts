import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';
import { useAuthStore } from '../stores/authStore.js';

/**
 * Monitors browser online/offline state and automatically synchronizes queued
 * offline expenses with server-side idempotency (`clientMutationId`) when connectivity returns.
 */
export function useOfflineSync() {
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const {
    isOnline,
    isSyncing,
    queue,
    setOnlineStatus,
    setSyncing,
    markItemStatus,
    removeQueuedExpense,
  } = useOfflineQueueStore();

  const flushOfflineQueue = useCallback(async () => {
    const currentState = useOfflineQueueStore.getState();
    if (!currentState.isOnline || currentState.isSyncing || currentState.queue.length === 0) {
      return;
    }
    if (!useAuthStore.getState().accessToken) {
      return;
    }

    setSyncing(true);
    try {
      for (const item of currentState.queue) {
        markItemStatus(item.clientMutationId, 'SYNCING');
        try {
          await apiRequest(`/trips/${item.tripId}/expenses`, {
            method: 'POST',
            body: JSON.stringify(item.payload),
          });
          removeQueuedExpense(item.clientMutationId);
          await queryClient.invalidateQueries({ queryKey: ['trip', item.tripId] });
        } catch (err) {
          markItemStatus(
            item.clientMutationId,
            'FAILED',
            err instanceof Error ? err.message : 'Sync failed'
          );
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      await queryClient.invalidateQueries({ queryKey: ['trips'] });
    } finally {
      setSyncing(false);
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
    if (isOnline && accessToken && queue.some((q) => q.syncStatus === 'PENDING')) {
      void flushOfflineQueue();
    }
  }, [isOnline, accessToken, queue, flushOfflineQueue]);

  return {
    isOnline,
    isSyncing,
    queue,
    flushOfflineQueue,
  };
}
