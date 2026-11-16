import { useAuthStore, type AuthUser } from '../stores/authStore.js';

const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ??
  '/api/v1';

const NON_REFRESHABLE_AUTH_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/verify-email',
]);

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'API_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizePathWithoutQuery(path: string): string {
  const queryStart = path.indexOf('?');
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function shouldAttemptTokenRefresh(path: string): boolean {
  return !NON_REFRESHABLE_AUTH_PATHS.has(normalizePathWithoutQuery(path));
}

interface InflightRefresh {
  generation: number;
  refreshToken: string;
  promise: Promise<boolean>;
}

let inflightRefresh: InflightRefresh | null = null;

/**
 * Single-flight `/auth/refresh` coordinator per session generation and refresh token.
 * Deduplicates concurrent 401 refreshes so refresh-token rotation cannot race itself,
 * and aborts cleanly without mutating state if the user logged out or switched accounts
 * in this or another tab while refresh was in flight.
 */
async function refreshSessionSingleFlight(
  usedAccessToken: string | null,
  usedRefreshToken: string,
  requestGeneration: number
): Promise<boolean> {
  const current = useAuthStore.getState();

  if (current.sessionGeneration !== requestGeneration || !current.accessToken) {
    return false;
  }

  // A sibling request or another tab already rotated tokens for this exact session.
  if (
    (current.refreshToken && current.refreshToken !== usedRefreshToken) ||
    (usedAccessToken && current.accessToken !== usedAccessToken)
  ) {
    return true;
  }

  if (
    inflightRefresh &&
    inflightRefresh.generation === requestGeneration &&
    inflightRefresh.refreshToken === usedRefreshToken
  ) {
    return inflightRefresh.promise;
  }

  const refreshOperation = (async (): Promise<boolean> => {
    try {
      const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: usedRefreshToken }),
        credentials: 'include',
      });

      if (!refreshRes.ok) {
        useAuthStore.getState().clearAuthIfGeneration(requestGeneration);
        return false;
      }

      const refreshData = (await refreshRes.json().catch(() => null)) as {
        data?: {
          user?: AuthUser;
          accessToken?: string;
          refreshToken?: string;
        };
      } | null;

      const payload = refreshData?.data;
      if (!payload?.user || typeof payload.accessToken !== 'string' || !payload.accessToken) {
        useAuthStore.getState().clearAuthIfGeneration(requestGeneration);
        return false;
      }

      return useAuthStore
        .getState()
        .applyRefreshedAuth(
          payload.user,
          payload.accessToken,
          payload.refreshToken,
          requestGeneration
        );
    } catch {
      useAuthStore.getState().clearAuthIfGeneration(requestGeneration);
      return false;
    }
  })();

  const entry: InflightRefresh = {
    generation: requestGeneration,
    refreshToken: usedRefreshToken,
    promise: refreshOperation.finally(() => {
      if (inflightRefresh === entry) {
        inflightRefresh = null;
      }
    }),
  };

  inflightRefresh = entry;
  return entry.promise;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  retryOn401 = true
): Promise<T> {
  const initialState = useAuthStore.getState();
  const requestAccessToken = initialState.accessToken;
  const requestRefreshToken = initialState.refreshToken;
  const requestGeneration = initialState.sessionGeneration;

  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (requestAccessToken) {
    headers.set('Authorization', `Bearer ${requestAccessToken}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && shouldAttemptTokenRefresh(path)) {
    if (retryOn401 && requestRefreshToken) {
      const refreshed = await refreshSessionSingleFlight(
        requestAccessToken,
        requestRefreshToken,
        requestGeneration
      );
      if (refreshed) {
        return apiRequest<T>(path, options, false);
      }
    } else if (requestAccessToken) {
      useAuthStore.getState().clearAuthIfGeneration(requestGeneration);
    }
  }

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiClientError(
      json?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      json?.error?.code ?? 'REQUEST_FAILED'
    );
  }

  return (json?.data ?? json) as T;
}
