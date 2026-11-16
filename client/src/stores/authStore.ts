import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const AUTH_STORAGE_KEY = 'tripledger-auth-storage';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  emailVerifiedAt?: string | null;
  phone?: string;
  defaultCurrency: string;
}

interface PersistedAuthSlice {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
}

interface AuthState extends PersistedAuthSlice {
  /** Monotonic per-tab counter incremented on login, logout, or external account changes. */
  sessionGeneration: number;
  setAuth: (user: AuthUser, accessToken: string, refreshToken?: string) => void;
  applyRefreshedAuth: (
    user: AuthUser,
    accessToken: string,
    refreshToken: string | undefined,
    expectedGeneration: number
  ) => boolean;
  updateUser: (user: AuthUser, expectedUserId?: string) => void;
  clearAuth: () => void;
  clearAuthIfGeneration: (expectedGeneration: number) => void;
  applyExternalStorageValue: (rawValue: string | null) => void;
}

function isValidAuthUser(value: unknown): value is AuthUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.defaultCurrency === 'string'
  );
}

function parseExternalAuthPayload(rawValue: string | null): PersistedAuthSlice {
  if (!rawValue) {
    return { user: null, accessToken: null, refreshToken: null };
  }

  try {
    const parsed = JSON.parse(rawValue) as { state?: Record<string, unknown> } | null;
    const rawState = parsed?.state;
    if (!rawState || typeof rawState !== 'object') {
      return { user: null, accessToken: null, refreshToken: null };
    }

    const accessToken =
      typeof rawState.accessToken === 'string' && rawState.accessToken.length > 0
        ? rawState.accessToken
        : null;
    const refreshToken =
      typeof rawState.refreshToken === 'string' && rawState.refreshToken.length > 0
        ? rawState.refreshToken
        : null;
    const user = isValidAuthUser(rawState.user) ? rawState.user : null;

    // Never keep half-populated auth state (user without token or token without valid user).
    if (!accessToken || !user) {
      return { user: null, accessToken: null, refreshToken: null };
    }

    return { user, accessToken, refreshToken };
  } catch {
    return { user: null, accessToken: null, refreshToken: null };
  }
}

function areUsersEqual(a: AuthUser | null, b: AuthUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.email === b.email &&
    a.emailVerified === b.emailVerified &&
    a.emailVerifiedAt === b.emailVerifiedAt &&
    a.phone === b.phone &&
    a.defaultCurrency === b.defaultCurrency
  );
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      sessionGeneration: 0,
      setAuth: (user, accessToken, refreshToken) =>
        set((state) => ({
          user,
          accessToken,
          refreshToken: refreshToken ?? null,
          sessionGeneration: state.sessionGeneration + 1,
        })),
      applyRefreshedAuth: (user, accessToken, refreshToken, expectedGeneration) => {
        let applied = false;
        set((state) => {
          if (
            state.sessionGeneration !== expectedGeneration ||
            !state.accessToken ||
            (state.user && state.user.id !== user.id)
          ) {
            return state;
          }
          applied = true;
          return {
            user,
            accessToken,
            refreshToken: refreshToken ?? state.refreshToken ?? null,
          };
        });
        return applied;
      },
      updateUser: (user, expectedUserId) =>
        set((state) => {
          if (!state.accessToken) return state;
          if (expectedUserId && state.user?.id !== expectedUserId) return state;
          if (state.user && state.user.id !== user.id) return state;
          return { user };
        }),
      clearAuth: () =>
        set((state) => ({
          user: null,
          accessToken: null,
          refreshToken: null,
          sessionGeneration: state.sessionGeneration + 1,
        })),
      clearAuthIfGeneration: (expectedGeneration) =>
        set((state) => {
          if (state.sessionGeneration !== expectedGeneration) return state;
          return {
            user: null,
            accessToken: null,
            refreshToken: null,
            sessionGeneration: state.sessionGeneration + 1,
          };
        }),
      applyExternalStorageValue: (rawValue) =>
        set((state) => {
          const next = parseExternalAuthPayload(rawValue);
          if (
            areUsersEqual(state.user, next.user) &&
            state.accessToken === next.accessToken &&
            state.refreshToken === next.refreshToken
          ) {
            return state;
          }

          const sessionIdentityChanged =
            state.user?.id !== next.user?.id ||
            (state.accessToken !== null) !== (next.accessToken !== null);

          return {
            ...next,
            sessionGeneration: sessionIdentityChanged
              ? state.sessionGeneration + 1
              : state.sessionGeneration,
          };
        }),
    }),
    {
      name: AUTH_STORAGE_KEY,
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
      }),
    }
  )
);

let crossTabSyncRegistered = false;

export function handleAuthStorageEvent(event: StorageEvent): void {
  if (event.storageArea && typeof window !== 'undefined' && event.storageArea !== window.localStorage) {
    return;
  }
  if (event.key !== null && event.key !== AUTH_STORAGE_KEY) {
    return;
  }
  const rawValue = event.key === null ? null : event.newValue;
  useAuthStore.getState().applyExternalStorageValue(rawValue);
}

export function initAuthCrossTabSync(): void {
  if (crossTabSyncRegistered || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  crossTabSyncRegistered = true;
  window.addEventListener('storage', handleAuthStorageEvent);
}

initAuthCrossTabSync();
