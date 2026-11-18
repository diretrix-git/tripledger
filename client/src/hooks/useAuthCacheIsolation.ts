import { useContext, useEffect, useRef } from 'react';
import { type QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore.js';

interface AuthIdentitySnapshot {
  sessionGeneration: number;
  userId: string | null;
  hasToken: boolean;
}

function captureAuthSnapshot(): AuthIdentitySnapshot {
  const state = useAuthStore.getState();
  return {
    sessionGeneration: state.sessionGeneration,
    userId: state.user?.id ?? null,
    hasToken: Boolean(state.accessToken),
  };
}

function hasSessionTransitioned(a: AuthIdentitySnapshot, b: AuthIdentitySnapshot): boolean {
  return (
    a.sessionGeneration !== b.sessionGeneration ||
    a.userId !== b.userId ||
    a.hasToken !== b.hasToken
  );
}

/**
 * Cancels in-flight queries and synchronously evicts cached React Query data so
 * authenticated data from one session can never leak into a subsequent session.
 */
export function clearAuthQueryCache(queryClient: QueryClient | null | undefined): void {
  if (!queryClient) return;
  void queryClient.cancelQueries();
  queryClient.clear();
}

/**
 * Attaches a synchronous Zustand subscriber that clears `queryClient` immediately
 * whenever the authenticated user, token presence, or session generation changes.
 */
export function bindQueryClientAuthIsolation(queryClient: QueryClient): () => void {
  return useAuthStore.subscribe((state, prev) => {
    const transitioned =
      state.sessionGeneration !== prev.sessionGeneration ||
      (state.user?.id ?? null) !== (prev.user?.id ?? null) ||
      Boolean(state.accessToken) !== Boolean(prev.accessToken);
    if (transitioned) {
      clearAuthQueryCache(queryClient);
    }
  });
}

/**
 * Ensures React Query cache isolation across login, logout, and cross-tab account switches.
 * Safe when rendered without a QueryClientProvider (e.g. isolated unit tests).
 */
export function useAuthCacheIsolation(): void {
  const queryClient = useContext(QueryClientContext);
  const lastObservedRef = useRef<AuthIdentitySnapshot>(captureAuthSnapshot());

  useEffect(() => {
    if (!queryClient) return;

    const current = captureAuthSnapshot();
    if (hasSessionTransitioned(lastObservedRef.current, current)) {
      clearAuthQueryCache(queryClient);
    }
    lastObservedRef.current = current;

    return useAuthStore.subscribe((state) => {
      const next: AuthIdentitySnapshot = {
        sessionGeneration: state.sessionGeneration,
        userId: state.user?.id ?? null,
        hasToken: Boolean(state.accessToken),
      };
      if (hasSessionTransitioned(lastObservedRef.current, next)) {
        lastObservedRef.current = next;
        clearAuthQueryCache(queryClient);
      }
    });
  }, [queryClient]);
}
