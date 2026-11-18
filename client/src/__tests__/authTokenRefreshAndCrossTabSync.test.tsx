// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { apiRequest, ApiClientError, shouldAttemptTokenRefresh } from '../api/client.js';
import { App } from '../App.js';
import { AppShell } from '../components/layout/AppShell.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { TripDetailPage } from '../pages/TripDetailPage.js';
import { AUTH_STORAGE_KEY, useAuthStore, type AuthUser } from '../stores/authStore.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-a',
    name: 'Alice Example',
    email: 'alice@example.com',
    emailVerified: false,
    emailVerifiedAt: null,
    defaultCurrency: 'NPR',
    ...overrides,
  };
}

function dispatchCrossTabStorage(newValue: string | null, key: string | null = AUTH_STORAGE_KEY) {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      newValue,
      storageArea: window.localStorage,
    })
  );
}

describe('F-01: Token refresh exclusions, single-flight deduplication, and cross-tab auth synchronization', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({ isOnline: true, isSyncing: false, queue: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('1. refreshes expired access token transparently on /auth/me without skipping /auth/ endpoints', async () => {
    const userA = makeUser({ id: 'user-a', emailVerified: false });
    const refreshedUserA = makeUser({
      id: 'user-a',
      emailVerified: true,
      emailVerifiedAt: '2026-11-16T06:00:00.000Z',
    });
    useAuthStore.getState().setAuth(userA, 'expired-access-1', 'refresh-1');

    let meCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authHeader = new Headers(init?.headers).get('Authorization');

      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        if (authHeader === 'Bearer expired-access-1') {
          return jsonResponse(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Token expired' } },
            401
          );
        }
        expect(authHeader).toBe('Bearer fresh-access-2');
        return jsonResponse({ success: true, data: { user: refreshedUserA } });
      }

      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-1' });
        return jsonResponse({
          success: true,
          data: {
            user: refreshedUserA,
            accessToken: 'fresh-access-2',
            refreshToken: 'refresh-2',
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiRequest<{ user: AuthUser }>('/auth/me');
    expect(res.user.emailVerified).toBe(true);
    expect(meCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(useAuthStore.getState().accessToken).toBe('fresh-access-2');
    expect(useAuthStore.getState().refreshToken).toBe('refresh-2');
  });

  it('2. refreshes expired access token on /auth/resend-verification and /auth/logout', async () => {
    const userA = makeUser({ id: 'user-a', emailVerified: false });
    useAuthStore.getState().setAuth(userA, 'expired-access', 'refresh-r1');

    let resendCalls = 0;
    let logoutCalls = 0;
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authHeader = new Headers(init?.headers).get('Authorization');

      if (url.endsWith('/auth/resend-verification')) {
        resendCalls += 1;
        if (authHeader === 'Bearer expired-access') {
          return jsonResponse(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Expired' } },
            401
          );
        }
        expect(authHeader).toBe('Bearer fresh-access-resend');
        return jsonResponse({
          success: true,
          data: { sent: true, alreadyVerified: false, emailVerified: false },
        });
      }

      if (url.endsWith('/auth/logout')) {
        logoutCalls += 1;
        if (authHeader === 'Bearer fresh-access-resend') {
          return jsonResponse(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Expired again' } },
            401
          );
        }
        expect(authHeader).toBe('Bearer fresh-access-logout');
        return jsonResponse({ success: true, data: { loggedOut: true } });
      }

      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return jsonResponse({
            success: true,
            data: {
              user: userA,
              accessToken: 'fresh-access-resend',
              refreshToken: 'refresh-r2',
            },
          });
        }
        return jsonResponse({
          success: true,
          data: {
            user: userA,
            accessToken: 'fresh-access-logout',
            refreshToken: 'refresh-r3',
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const resendRes = await apiRequest<{ sent: boolean }>('/auth/resend-verification', {
      method: 'POST',
    });
    expect(resendRes.sent).toBe(true);
    expect(resendCalls).toBe(2);

    const logoutRes = await apiRequest<{ loggedOut: boolean }>('/auth/logout', {
      method: 'POST',
    });
    expect(logoutRes.loggedOut).toBe(true);
    expect(logoutCalls).toBe(2);
    expect(refreshCalls).toBe(2);
  });

  it('3. excludes /auth/login, /auth/register, /auth/refresh, and /auth/verify-email from 401 refresh', async () => {
    expect(shouldAttemptTokenRefresh('/auth/login')).toBe(false);
    expect(shouldAttemptTokenRefresh('/auth/login/')).toBe(false);
    expect(shouldAttemptTokenRefresh('/auth/register')).toBe(false);
    expect(shouldAttemptTokenRefresh('/auth/refresh')).toBe(false);
    expect(shouldAttemptTokenRefresh('/auth/verify-email?token=abc')).toBe(false);
    expect(shouldAttemptTokenRefresh('/auth/me')).toBe(true);
    expect(shouldAttemptTokenRefresh('/auth/resend-verification')).toBe(true);
    expect(shouldAttemptTokenRefresh('/auth/logout')).toBe(true);

    const userA = makeUser({ id: 'user-a' });
    useAuthStore.getState().setAuth(userA, 'existing-access', 'existing-refresh');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh') && init?.body === JSON.stringify({ refreshToken: 'existing-refresh' })) {
        throw new Error('Refresh must NOT be called as a retry for excluded auth routes');
      }
      return jsonResponse(
        { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid login' } },
        401
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    for (const excludedPath of [
      '/auth/login',
      '/auth/register',
      '/auth/refresh',
      '/auth/verify-email?token=bad',
    ]) {
      await expect(
        apiRequest(excludedPath, { method: 'POST', body: JSON.stringify({ probe: true }) })
      ).rejects.toBeInstanceOf(ApiClientError);
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Excluded 401 responses (e.g. failed login/verify attempt) must not wipe active valid store
    expect(useAuthStore.getState().accessToken).toBe('existing-access');
  });

  it('4. deduplicates concurrent 401s into a single /auth/refresh request and avoids replay after rotation', async () => {
    const userA = makeUser({ id: 'user-a' });
    useAuthStore.getState().setAuth(userA, 'expired-concurrent', 'refresh-single-1');

    let refreshCalls = 0;
    let releaseRefresh!: (res: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authHeader = new Headers(init?.headers).get('Authorization');

      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return pendingRefresh;
      }

      if (authHeader === 'Bearer expired-concurrent') {
        return jsonResponse(
          { success: false, error: { code: 'UNAUTHORIZED', message: 'Expired' } },
          401
        );
      }

      expect(authHeader).toBe('Bearer rotated-access-2');
      if (url.endsWith('/auth/me')) {
        return jsonResponse({ success: true, data: { user: userA } });
      }
      if (url.endsWith('/trips')) {
        return jsonResponse({ success: true, data: { trips: [] } });
      }
      if (url.endsWith('/auth/resend-verification')) {
        return jsonResponse({
          success: true,
          data: { sent: true, alreadyVerified: false, emailVerified: false },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const p1 = apiRequest<{ user: AuthUser }>('/auth/me');
    const p2 = apiRequest<{ trips: unknown[] }>('/trips');
    const p3 = apiRequest<{ sent: boolean }>('/auth/resend-verification', { method: 'POST' });

    await waitFor(() => {
      expect(refreshCalls).toBe(1);
    });

    releaseRefresh(
      jsonResponse({
        success: true,
        data: {
          user: userA,
          accessToken: 'rotated-access-2',
          refreshToken: 'refresh-single-2',
        },
      })
    );

    const [meRes, tripsRes, resendRes] = await Promise.all([p1, p2, p3]);
    expect(meRes.user.id).toBe('user-a');
    expect(tripsRes.trips).toEqual([]);
    expect(resendRes.sent).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(useAuthStore.getState().refreshToken).toBe('refresh-single-2');
  });

  it('5. synchronizes cross-tab logout via storage events, clears query cache, and blocks in-flight refresh resurrection', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice Tab' });
    useAuthStore.getState().setAuth(userA, 'expired-a', 'refresh-a');

    const queryClient = new QueryClient();
    queryClient.setQueryData(['trips'], [{ id: 'trip-1', name: 'Private Trip' }]);

    let resolveRefresh!: (res: Response) => void;
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) {
          return jsonResponse(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Expired' } },
            401
          );
        }
        if (url.endsWith('/auth/refresh')) {
          return refreshPromise;
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<div>Main App</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Wait until /auth/refresh is in flight for User A
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        expect.anything()
      );
    });

    // Another tab logs out (persists cleared auth state to localStorage and emits storage event)
    dispatchCrossTabStorage(
      JSON.stringify({
        state: { user: null, accessToken: null, refreshToken: null },
        version: 0,
      })
    );

    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().user).toBeNull();
      expect(queryClient.getQueryData(['trips'])).toBeUndefined();
    });

    // In-flight User A refresh now finishes late: MUST NOT re-authenticate logged-out tab!
    resolveRefresh(
      jsonResponse({
        success: true,
        data: {
          user: userA,
          accessToken: 'stale-resurrected-access',
          refreshToken: 'stale-resurrected-refresh',
        },
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();

    // Also test storage clear event (key: null)
    useAuthStore.getState().setAuth(userA, 'access-temp', 'refresh-temp');
    dispatchCrossTabStorage(null, null);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('6. synchronizes cross-tab account switch atomically without mixing user profile and tokens, even during in-flight refresh failure/success', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice UserA', email: 'alice@example.com' });
    const userB = makeUser({
      id: 'user-b',
      name: 'Bob UserB',
      email: 'bob@example.com',
      emailVerified: true,
    });
    useAuthStore.getState().setAuth(userA, 'expired-a', 'refresh-a');

    let resolveRefreshA!: (res: Response) => void;
    const refreshAPromise = new Promise<Response>((resolve) => {
      resolveRefreshA = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        return refreshAPromise;
      }
      return jsonResponse(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Expired' } },
        401
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    // Fire request for User A that hits 401 and awaits /auth/refresh
    const pendingUserARequest = apiRequest('/trips').catch((err) => err);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        expect.anything()
      );
    });

    // Meanwhile another tab switches account to User B
    dispatchCrossTabStorage(
      JSON.stringify({
        state: {
          user: userB,
          accessToken: 'access-b',
          refreshToken: 'refresh-b',
        },
        version: 0,
      })
    );

    expect(useAuthStore.getState().user?.id).toBe('user-b');
    expect(useAuthStore.getState().accessToken).toBe('access-b');
    expect(useAuthStore.getState().refreshToken).toBe('refresh-b');

    // Suppose User A's in-flight /auth/refresh FAILS with 401 -> MUST NOT clear User B's active session!
    resolveRefreshA(
      jsonResponse(
        { success: false, error: { code: 'TOKEN_REVOKED', message: 'Revoked' } },
        401
      )
    );
    const reqErr = await pendingUserARequest;
    expect(reqErr).toBeInstanceOf(ApiClientError);

    expect(useAuthStore.getState().user).toEqual(userB);
    expect(useAuthStore.getState().accessToken).toBe('access-b');
    expect(useAuthStore.getState().refreshToken).toBe('refresh-b');
  });

  it('7. prevents delayed /auth/me response for User A from overwriting User B or logged-out state across AppShell & SettingsPage', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice Old', emailVerified: false });
    const userB = makeUser({
      id: 'user-b',
      name: 'Bob New',
      email: 'bob@example.com',
      emailVerified: true,
    });
    useAuthStore.getState().setAuth(userA, 'access-a', 'refresh-a');

    let resolveDelayedMeA!: (res: Response) => void;
    const delayedMeAPromise = new Promise<Response>((resolve) => {
      resolveDelayedMeA = resolve;
    });

    let callsForMe = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = new Headers(init?.headers).get('Authorization');
        if (url.endsWith('/auth/me')) {
          callsForMe += 1;
          if (auth === 'Bearer access-a') {
            return delayedMeAPromise;
          }
          if (auth === 'Bearer access-b') {
            return jsonResponse({ success: true, data: { user: userB } });
          }
        }
        throw new Error(`Unexpected fetch: ${url} (${auth})`);
      })
    );

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(callsForMe).toBe(1);
    });

    // Cross-tab account switch to User B before User A's /auth/me resolves
    dispatchCrossTabStorage(
      JSON.stringify({
        state: { user: userB, accessToken: 'access-b', refreshToken: 'refresh-b' },
        version: 0,
      })
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('Bob New')).toBeInTheDocument();
    });

    // Delayed /auth/me for User A finally arrives
    resolveDelayedMeA(
      jsonResponse({
        success: true,
        data: { user: { ...userA, name: 'Alice Late Overwrite', emailVerified: true } },
      })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(useAuthStore.getState().user?.id).toBe('user-b');
    expect(useAuthStore.getState().user?.name).toBe('Bob New');
    expect(screen.getByDisplayValue('Bob New')).toBeInTheDocument();

    // Direct store unit check: updateUser rejects delayed mismatch and logged-out updates
    useAuthStore.getState().updateUser({ ...userA, name: 'Should Fail' }, 'user-a');
    expect(useAuthStore.getState().user?.id).toBe('user-b');

    useAuthStore.getState().clearAuth();
    useAuthStore.getState().updateUser(userB, 'user-b');
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('8. clears invalid auth state cleanly on /auth/refresh failure without leaking tokens in error messages', async () => {
    const userA = makeUser({ id: 'user-a' });
    useAuthStore.getState().setAuth(userA, 'secret-expired-jwt-token', 'secret-refresh-token-xyz');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/auth/me')) {
          return jsonResponse(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Access token expired' } },
            401
          );
        }
        if (url.endsWith('/auth/refresh')) {
          return jsonResponse(
            { success: false, error: { code: 'REFRESH_REVOKED', message: 'Session expired' } },
            401
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    let caughtError: unknown;
    try {
      await apiRequest('/auth/me');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiClientError);
    expect((caughtError as ApiClientError).statusCode).toBe(401);
    expect((caughtError as ApiClientError).message).not.toContain('secret-expired-jwt-token');
    expect((caughtError as ApiClientError).message).not.toContain('secret-refresh-token-xyz');

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();

    // Subsequent 401 when refreshToken is missing also clears stale accessToken cleanly
    useAuthStore.getState().setAuth(userA, 'orphan-access-only');
    await expect(apiRequest('/auth/me')).rejects.toBeInstanceOf(ApiClientError);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('9. (M-01) clears React Query cache synchronously across ProtectedRoute unmount, /login account switch, and cross-tab switch, and binds FAMILY_REP UI to userId', async () => {
    const userA = makeUser({
      id: 'user-a',
      name: 'Alice OrgRep',
      email: 'alice@example.com',
      emailVerified: true,
    });
    const userB = makeUser({
      id: 'user-b',
      name: 'Bob Member',
      email: 'bob@example.com',
      emailVerified: true,
    });
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');

    const buildTripPayload = (forUserId: 'user-a' | 'user-b') => ({
      trip: {
        id: 'trip-1',
        name: 'Mustang Isolation Trip',
        mode: 'FAMILY',
        status: 'ACTIVE',
        currency: 'NPR',
        ...(forUserId === 'user-a' ? { inviteCode: 'SECRET-A' } : {}),
        shareToken: 'share-1',
        shareEnabled: true,
        checklist: [],
      },
      myParticipant:
        forUserId === 'user-a'
          ? { id: 'p-a', name: 'Alice OrgRep', role: 'ORGANIZER', familyId: 'fam-1' }
          : { id: 'p-b', name: 'Bob Member', role: 'PARTICIPANT', familyId: 'fam-1' },
      participants: [
        {
          id: 'p-a',
          tripId: 'trip-1',
          userId: 'user-a',
          familyId: 'fam-1',
          name: 'Alice OrgRep',
          email: 'alice@example.com',
          role: 'ORGANIZER',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
        {
          id: 'p-b',
          tripId: 'trip-1',
          userId: 'user-b',
          familyId: 'fam-1',
          name: 'Bob Member',
          email: 'bob@example.com',
          role: 'PARTICIPANT',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
      ],
      families: [
        {
          id: 'fam-1',
          tripId: 'trip-1',
          name: 'Alpha Fam',
          representativeId: 'p-a',
          defaultWeight: 1,
        },
      ],
      expenses: [],
      settlements: [],
      ledger: {
        totalApprovedExpensePaisa: 0,
        totalPackageExpensePaisa: 0,
        totalAdditionalExpensePaisa: 0,
        totalPendingExpensePaisa: 0,
        totalConfirmedSettlementPaisa: 0,
        individualBalances: [],
        familyBalances: [],
        ungroupedParticipantBalances: [],
      },
      individualSettlementSuggestions: [],
      familySettlementSuggestions: [],
    });

    let userBTripFetches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const auth = new Headers(init?.headers).get('Authorization');

        if (url.endsWith('/auth/login') && method === 'POST') {
          return jsonResponse({
            success: true,
            data: { user: userB, accessToken: 'tok-b', refreshToken: 'ref-b' },
          });
        }
        if (url.endsWith('/auth/me')) {
          return jsonResponse({
            success: true,
            data: { user: auth === 'Bearer tok-a' ? userA : userB },
          });
        }
        if (url.endsWith('/dashboard/summary')) {
          return jsonResponse({
            success: true,
            data: {
              metrics: {
                activeTripsCount: 1,
                closedTripsCount: 0,
                totalActiveTripExpensePaisa: 0,
                totalOwedToMePaisa: 0,
                totalIOwePaisa: 0,
                netOverallBalancePaisa: 0,
              },
              trips: [],
              recentActivities: [],
            },
          });
        }
        if (url.endsWith('/trips/invites/pending')) {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        if (url.endsWith('/trips/trip-1')) {
          if (auth === 'Bearer tok-a') {
            return jsonResponse({ success: true, data: buildTripPayload('user-a') });
          }
          if (auth === 'Bearer tok-b') {
            userBTripFetches += 1;
            return jsonResponse({ success: true, data: buildTripPayload('user-b') });
          }
        }
        if (url.endsWith('/trips/trip-1/invites')) {
          if (auth === 'Bearer tok-a') {
            return jsonResponse({ success: true, data: { invites: [] } });
          }
          throw new Error('Unauthorized invites fetch by non-organizer user-b');
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 10_000, retry: false } },
    });

    function TestNavControls() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate('/trips/trip-1')}>
          Open Trip 1 Nav
        </button>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <TestNavControls />
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Code: SECRET-A/i)).toBeInTheDocument();
    });
    expect(queryClient.getQueryData(['trip', 'trip-1', 'user-a'])).toBeDefined();

    // Cross-tab logout while inside <ProtectedRoute>: ProtectedRoute redirects to /login and
    // AuthCacheBoundary synchronously clears queryClient even though AppShell unmounts before effect.
    dispatchCrossTabStorage(
      JSON.stringify({
        state: { user: null, accessToken: null, refreshToken: null },
        version: 0,
      })
    );

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sign in to TripLedger/i })).toBeInTheDocument();
    });

    // User B signs in through AuthPage within 10s staleTime
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: userB.email },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'Password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Sign In$/i }));

    await waitFor(() => {
      expect(useAuthStore.getState().user?.id).toBe('user-b');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Trip 1 Nav' }));
    await waitFor(() => {
      expect(screen.getByText(/Mustang Isolation Trip/i)).toBeInTheDocument();
    });
    expect(userBTripFetches).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Code: SECRET-A/i)).not.toBeInTheDocument();

    // Direct cross-tab switch back to User A immediately wipes User B's query cache
    dispatchCrossTabStorage(
      JSON.stringify({
        state: { user: userA, accessToken: 'tok-a', refreshToken: 'ref-a' },
        version: 0,
      })
    );
    expect(queryClient.getQueryData(['trip', 'trip-1', 'user-b'])).toBeUndefined();
    await waitFor(() => {
      expect(screen.getByText(/Code: SECRET-A/i)).toBeInTheDocument();
    });

    // Designated FAMILY_REP UI additionally verifies currentUser.id matches participant.userId
    cleanup();
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    const mismatchedRepPayload = {
      ...buildTripPayload('user-a'),
      myParticipant: { id: 'p-a', name: 'Alice Rep', role: 'FAMILY_REP', familyId: 'fam-1' },
      participants: [
        {
          ...buildTripPayload('user-a').participants[0]!,
          role: 'FAMILY_REP',
        },
        {
          id: 'p-recv',
          tripId: 'trip-1',
          userId: 'user-other',
          familyId: 'fam-1',
          name: 'Other Member',
          email: 'other@example.com',
          role: 'PARTICIPANT',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
      ],
      settlements: [
        {
          id: 's-fam-rep-check',
          tripId: 'trip-1',
          settlementMode: 'FAMILY',
          fromParticipantId: 'p-recv',
          toParticipantId: 'p-recv',
          fromFamilyId: 'fam-1',
          toFamilyId: 'fam-1',
          amountPaisa: 10000,
          paymentMethod: 'ESEWA',
          status: 'REPORTED',
          settledAt: '2026-11-16T07:00:00.000Z',
          createdAt: '2026-11-16T07:00:00.000Z',
          updatedAt: '2026-11-16T07:00:00.000Z',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/trips/trip-1')) {
          return jsonResponse({ success: true, data: mismatchedRepPayload });
        }
        throw new Error(`Unexpected mismatched fetch: ${String(input)}`);
      })
    );
    const qcMismatch = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcMismatch}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Mustang Isolation Trip/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(screen.getByText('REPORTED')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Confirm settlement/i })).not.toBeInTheDocument();
  });
});
