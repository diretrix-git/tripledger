import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import {
  hasWebLocksSupport,
  useOfflineQueueStore,
  type OfflineQueueStore,
} from '../stores/offlineQueueStore.js';
import {
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
  type AuthSessionSnapshot,
} from '../stores/authStore.js';

/**
 * Monitors browser online/offline state and automatically synchronizes queued
 * offline expenses scoped strictly to the active authenticated user with cross-tab
 * lock coordination (when Web Locks API is available), orphaned SYNCING recovery,
 * and server-side `clientMutationId` idempotency.
 */
export function useOfflineSync(queueStore: OfflineQueueStore = useOfflineQueueStore) {
  const queryClient = useQueryClient();
  const isMountedRef = useRef(true);
  const inFlightFlushRef = useRef(false);
  const isHoldingSyncLockRef = useRef(false);
  const recoveryWatchKeyRef = useRef<string | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const {
    isOnline,
    isSyncing,
    activeUserId,
    queue,
    legacyDiscardedCount,
    crossTabCoordinationDegraded,
    syncError,
    setOnlineStatus,
    setSyncing,
    dismissLegacyNotice,
    dismissSyncError,
    syncAuthContext,
    markItemStatus,
    removeQueuedExpense,
  } = queueStore();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    syncAuthContext();
  }, [accessToken, currentUserId, syncAuthContext]);

  const userScopedQueue = useMemo(() => {
    if (!accessToken || !currentUserId || activeUserId !== currentUserId) {
      return [];
    }
    return queue.filter((q) => q.userId === currentUserId);
  }, [accessToken, activeUserId, currentUserId, queue]);

  const hasPendingItem = useMemo(
    () => userScopedQueue.some((q) => q.syncStatus === 'PENDING'),
    [userScopedQueue]
  );
  const hasSyncingItem = useMemo(
    () => userScopedQueue.some((q) => q.syncStatus === 'SYNCING'),
    [userScopedQueue]
  );

  const runLockedSyncWork = useCallback(
    async (
      startSession: AuthSessionSnapshot,
      startUserId: string,
      exclusiveCrossTab: boolean,
      includeFailed: boolean
    ) => {
      let didStartSyncing = false;
      let flushedAnySuccess = false;
      const attemptedIds = new Set<string>();
      isHoldingSyncLockRef.current = true;

      try {
        while (
          isSameAuthSession(startSession, { requireAuthenticated: true }) &&
          queueStore.getState().isOnline
        ) {
          // Recover orphaned SYNCING entries strictly under exclusive cross-tab sync lock ownership
          // so another active tab's in-flight request is never reset mid-flight.
          const latestQueue = await queueStore
            .getState()
            .refreshUserQueueFromStorage(startUserId, {
              recoverOrphanedSyncing: exclusiveCrossTab,
            });
          const candidates = latestQueue.filter(
            (item) =>
              typeof item.userId === 'string' &&
              item.userId === startUserId &&
              (item.syncStatus === 'PENDING' ||
                (includeFailed && item.syncStatus === 'FAILED')) &&
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
        isHoldingSyncLockRef.current = false;
        if (didStartSyncing && isSameAuthSession(startSession)) {
          setSyncing(false);
        }
      }
    },
    [markItemStatus, queryClient, queueStore, removeQueuedExpense, setSyncing]
  );

  const flushWithOptions = useCallback(
    async (includeFailed: boolean) => {
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
        await queueStore.getState().tryWithUserSyncLock(
          startUserId,
          async ({ exclusiveCrossTab }) => {
            await runLockedSyncWork(startSession, startUserId, exclusiveCrossTab, includeFailed);
          },
          { waitForLock: false }
        );
      } catch (err) {
        console.warn('[TripLedger] Offline queue flush terminated cleanly with error:', err);
      } finally {
        inFlightFlushRef.current = false;
      }
    },
    [queueStore, runLockedSyncWork]
  );

  const flushOfflineQueue = useCallback(() => flushWithOptions(true), [flushWithOptions]);

  useEffect(() => {
    const handleOnline = () => {
      setOnlineStatus(true);
      void flushWithOptions(true);
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
  }, [flushWithOptions, setOnlineStatus]);

  useEffect(() => {
    if (
      isOnline &&
      accessToken &&
      currentUserId &&
      activeUserId === currentUserId &&
      hasPendingItem
    ) {
      void flushWithOptions(false);
    }
  }, [
    isOnline,
    accessToken,
    activeUserId,
    currentUserId,
    hasPendingItem,
    userScopedQueue,
    flushWithOptions,
  ]);

  useEffect(() => {
    if (
      !isOnline ||
      !accessToken ||
      !currentUserId ||
      activeUserId !== currentUserId ||
      !hasSyncingItem ||
      isHoldingSyncLockRef.current ||
      !hasWebLocksSupport()
    ) {
      return;
    }

    const startSession = captureAuthSessionSnapshot();
    if (!startSession.hasAccessToken || startSession.userId !== currentUserId) {
      return;
    }
    const watchKey = `${currentUserId}:${startSession.sessionGeneration}`;
    if (recoveryWatchKeyRef.current === watchKey) {
      return;
    }

    recoveryWatchKeyRef.current = watchKey;
    let cancelled = false;

    void queueStore
      .getState()
      .tryWithUserSyncLock(
        currentUserId,
        async ({ exclusiveCrossTab }) => {
          if (
            cancelled ||
            !isMountedRef.current ||
            inFlightFlushRef.current ||
            !exclusiveCrossTab ||
            !isSameAuthSession(startSession, { requireAuthenticated: true }) ||
            !queueStore.getState().isOnline
          ) {
            return;
          }

          inFlightFlushRef.current = true;
          try {
            await runLockedSyncWork(startSession, currentUserId, true, false);
          } finally {
            inFlightFlushRef.current = false;
          }
        },
        { waitForLock: true }
      )
      .catch((err) => {
        console.warn('[TripLedger] Orphaned SYNCING recovery watcher exited safely:', err);
      })
      .finally(() => {
        if (recoveryWatchKeyRef.current === watchKey) {
          recoveryWatchKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
      if (recoveryWatchKeyRef.current === watchKey) {
        recoveryWatchKeyRef.current = null;
      }
    };
  }, [
    isOnline,
    accessToken,
    activeUserId,
    currentUserId,
    sessionGeneration,
    hasSyncingItem,
    queueStore,
    runLockedSyncWork,
  ]);

  return {
    isOnline,
    isSyncing,
    queue: userScopedQueue,
    legacyDiscardedCount,
    crossTabCoordinationDegraded,
    syncError,
    dismissLegacyNotice,
    dismissSyncError,
    flushOfflineQueue,
  };
}
