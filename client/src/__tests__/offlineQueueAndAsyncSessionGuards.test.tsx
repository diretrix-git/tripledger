// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { App } from '../App.js';
import { QuickAddExpenseModal } from '../components/expenses/QuickAddExpenseModal.js';
import { AppShell } from '../components/layout/AppShell.js';
import { AcceptInvitePage } from '../pages/AcceptInvitePage.js';
import { CreateTripPage } from '../pages/CreateTripPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { VerifyEmailPage } from '../pages/VerifyEmailPage.js';
import { AUTH_STORAGE_KEY, useAuthStore, type AuthUser } from '../stores/authStore.js';
import {
  getOfflineQueueStorageKey,
  LEGACY_OFFLINE_QUEUE_STORAGE_KEY,
  useOfflineQueueStore,
  type QueuedOfflineExpense,
} from '../stores/offlineQueueStore.js';

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
    emailVerified: true,
    emailVerifiedAt: '2026-11-16T06:00:00.000Z',
    defaultCurrency: 'NPR',
    ...overrides,
  };
}

function makeTripPayload(userId: string, tripId = 'trip-1', tripName = 'Mustang Trip') {
  return {
    trip: {
      id: tripId,
      name: tripName,
      mode: 'FRIENDS' as const,
      status: 'ACTIVE' as const,
      currency: 'NPR',
      shareToken: 'share-1',
      shareEnabled: true,
      checklist: [],
    },
    myParticipant: {
      id: userId === 'user-a' ? 'p-a' : 'p-b',
      name: userId === 'user-a' ? 'Alice Example' : 'Bob Example',
      role: 'ORGANIZER' as const,
      familyId: null,
    },
    participants: [
      {
        id: 'p-a',
        tripId,
        userId: 'user-a',
        familyId: null,
        name: 'Alice Example',
        email: 'alice@example.com',
        role: 'ORGANIZER' as const,
        memberType: 'ADULT' as const,
        defaultWeight: 1,
        isActive: true,
      },
      {
        id: 'p-b',
        tripId,
        userId: 'user-b',
        familyId: null,
        name: 'Bob Example',
        email: 'bob@example.com',
        role: 'ORGANIZER' as const,
        memberType: 'ADULT' as const,
        defaultWeight: 1,
        isActive: true,
      },
    ],
    families: [],
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
  };
}

function makeQueuedEntry(
  overrides: Partial<QueuedOfflineExpense> & { clientMutationId: string; userId: string }
): QueuedOfflineExpense {
  return {
    tripId: 'trip-1',
    tripName: 'Mustang Trip',
    queuedAt: '2026-11-18T06:00:00.000Z',
    syncStatus: 'PENDING',
    ...overrides,
    payload: {
      title: 'Mountain Tea',
      category: 'FOOD_DRINKS',
      amountPaisa: 25000,
      isEstimated: false,
      isPackage: false,
      splitMethod: 'EQUAL',
      paymentMethod: 'CASH',
      incurredAt: '2026-11-18T06:00:00.000Z',
      payments: [{ participantId: 'p-a', amountPaisa: 25000 }],
      clientMutationId: overrides.clientMutationId,
      ...(overrides.payload ?? {}),
    },
  };
}

function PathProbe() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

describe('Phase 3.1.6: Offline queue account isolation (L-01) and async session guards (L-02)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({
      isOnline: true,
      isSyncing: false,
      activeUserId: null,
      queue: [],
      legacyDiscardedCount: 0,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('L-01: isolates offline queued expenses by user across logout/login, prevents foreign replay, and resumes same-user queue safely', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    const submittedByToken: Array<{ token: string | null; title: string; clientMutationId: string }> =
      [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const auth = new Headers(init?.headers).get('Authorization');

        if (url.endsWith('/auth/me')) {
          return jsonResponse({
            success: true,
            data: { user: auth === 'Bearer tok-b' ? userB : userA },
          });
        }
        if (url.endsWith('/auth/logout') && method === 'POST') {
          return jsonResponse({ success: true, data: {} });
        }
        if (url.endsWith('/trips/trip-1') && method === 'GET') {
          return jsonResponse({
            success: true,
            data: makeTripPayload(auth === 'Bearer tok-b' ? 'user-b' : 'user-a'),
          });
        }
        if (url.endsWith('/trips/trip-1/invites') && method === 'GET') {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        if (url.endsWith('/trips/trip-1/expenses') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as {
            title: string;
            clientMutationId: string;
          };
          submittedByToken.push({
            token: auth,
            title: body.title,
            clientMutationId: body.clientMutationId,
          });
          return jsonResponse({ success: true, data: { expense: { id: 'exp-1' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    // 1. User A signs in while offline and queues an expense via QuickAddExpenseModal
    useOfflineQueueStore.getState().setOnlineStatus(false);
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Mustang Trip/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Quick-Add Expense/i }));
    fireEvent.change(screen.getByPlaceholderText(/Highway Fuel/i), {
      target: { value: 'User A Offline Jeep' },
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\., 5000/i), {
      target: { value: '1200' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Queue Expense Offline/i }));

    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue).toHaveLength(1);
    });
    const queuedItem = useOfflineQueueStore.getState().queue[0]!;
    expect(queuedItem.userId).toBe('user-a');
    expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toContain(
      'User A Offline Jeep'
    );
    expect(window.localStorage.getItem(LEGACY_OFFLINE_QUEUE_STORAGE_KEY)).toBeNull();
    expect(screen.getAllByText(/1 queued/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Expenses \(1\)/i })).toBeInTheDocument();

    // 1b. Cross-tab direct account switch A -> B while offline keeps User A's queue out of User B's state
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: AUTH_STORAGE_KEY,
        newValue: JSON.stringify({
          state: { user: userB, accessToken: 'tok-b', refreshToken: 'ref-b' },
          version: 0,
        }),
        storageArea: window.localStorage,
      })
    );
    expect(useOfflineQueueStore.getState().activeUserId).toBe('user-b');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    // Switch back to User A and verify logout -> User B online login isolation too
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(1);

    // 2. User A logs out, then User B logs in while online
    fireEvent.click(screen.getByTitle('Log out'));
    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBeNull();
    });
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    useOfflineQueueStore.getState().setOnlineStatus(true);
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');

    cleanup();
    const qcB = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcB}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Mustang Trip/i)).toBeInTheDocument();
    });

    // User B cannot see or replay User A's offline expense
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expenses \(0\)/i })).toBeInTheDocument();
    expect(submittedByToken).toHaveLength(0);

    // 3. Same-user refresh simulation & User A logs back in -> queue restores and syncs under User A
    useAuthStore.getState().clearAuth();
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    useAuthStore.getState().setAuth(userA, 'tok-a-resumed', 'ref-a-resumed');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(1);

    // Silent token refresh keeps User A's queue intact
    expect(
      useAuthStore
        .getState()
        .applyRefreshedAuth(
          userA,
          'tok-a-refreshed',
          'ref-a-refreshed',
          useAuthStore.getState().sessionGeneration
        )
    ).toBe(true);

    cleanup();
    const qcA2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcA2}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(submittedByToken).toHaveLength(1);
    });
    expect(submittedByToken[0]!.token).toBe('Bearer tok-a-refreshed');
    expect(submittedByToken[0]!.title).toBe('User A Offline Jeep');
    expect(submittedByToken[0]!.clientMutationId).toBe(queuedItem.clientMutationId);

    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
      expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toBeNull();
    });
  });

  it('L-01: safely discards legacy unscoped entries without submitting them, and recovers SYNCING items only for owning user', async () => {
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    // Pre-populate legacy pre-3.1.6 queue entry lacking userId
    window.localStorage.setItem(
      LEGACY_OFFLINE_QUEUE_STORAGE_KEY,
      JSON.stringify({
        state: {
          queue: [
            {
              clientMutationId: 'legacy-no-user-1',
              tripId: 'trip-1',
              tripName: 'Confidential Alpha Trip',
              queuedAt: '2026-11-17T10:00:00.000Z',
              syncStatus: 'PENDING',
              payload: {
                title: 'Legacy Private Receipt',
                category: 'FOOD_DRINKS',
                amountPaisa: 90000,
                isEstimated: false,
                isPackage: false,
                splitMethod: 'EQUAL',
                paymentMethod: 'CASH',
                incurredAt: '2026-11-17T10:00:00.000Z',
                payments: [{ participantId: 'p-a', amountPaisa: 90000 }],
                clientMutationId: 'legacy-no-user-1',
              },
            },
          ],
        },
        version: 0,
      })
    );

    // Also inject a tampered foreign entry inside User B's scoped storage key
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-b'),
      JSON.stringify({
        version: 1,
        userId: 'user-b',
        queue: [
          makeQueuedEntry({ clientMutationId: 'tampered-foreign', userId: 'user-a' }),
          makeQueuedEntry({
            clientMutationId: 'bob-interrupted-sync',
            userId: 'user-b',
            syncStatus: 'SYNCING',
            payload: {
              title: 'Bob Resumed Expense',
              category: 'FOOD_DRINKS',
              amountPaisa: 30000,
              isEstimated: false,
              isPackage: false,
              splitMethod: 'EQUAL',
              paymentMethod: 'CASH',
              incurredAt: '2026-11-18T06:00:00.000Z',
              payments: [{ participantId: 'p-b', amountPaisa: 30000 }],
              clientMutationId: 'bob-interrupted-sync',
            },
          }),
        ],
      })
    );

    const submittedMutationIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/auth/me')) {
          return jsonResponse({ success: true, data: { user: userB } });
        }
        if (url.endsWith('/dashboard/summary')) {
          return jsonResponse({
            success: true,
            data: {
              metrics: {
                activeTripsCount: 0,
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
        if (url.endsWith('/trips/trip-1/expenses') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
          submittedMutationIds.push(body.clientMutationId);
          return jsonResponse({ success: true, data: { expense: { id: 'exp-b' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(submittedMutationIds).toEqual(['bob-interrupted-sync']);
    });

    // Legacy & foreign entries were never submitted and legacy key was purged without leaking details
    expect(submittedMutationIds).not.toContain('legacy-no-user-1');
    expect(submittedMutationIds).not.toContain('tampered-foreign');
    expect(window.localStorage.getItem(LEGACY_OFFLINE_QUEUE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByText(/Legacy Private Receipt/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Confidential Alpha Trip/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/1 legacy unattributed offline expense item\(s\).*discarded without submission/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useOfflineQueueStore.getState().legacyDiscardedCount).toBe(0);
  });

  it('L-01: halts in-flight flush immediately when session switches mid-sync and preserves unsent items for original user', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    useOfflineQueueStore.getState().setOnlineStatus(false);
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'mut-1', userId: 'user-a' }));
    useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'mut-2', userId: 'user-a' }));

    let rejectFirstPost!: (err: Error) => void;
    const postCalls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const auth = new Headers(init?.headers).get('Authorization');
        if (url.endsWith('/auth/me')) {
          return jsonResponse({
            success: true,
            data: { user: auth === 'Bearer tok-b' ? userB : userA },
          });
        }
        if (url.endsWith('/trips/trip-1/expenses') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
          postCalls.push(`${auth ?? 'none'}:${body.clientMutationId}`);
          return new Promise<Response>((_resolve, reject) => {
            rejectFirstPost = reject;
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<div>Home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Go online to begin flushing mut-1
    useOfflineQueueStore.getState().setOnlineStatus(true);
    await waitFor(() => {
      expect(postCalls).toEqual(['Bearer tok-a:mut-1']);
    });

    // Switch session to User B while mut-1 is in flight
    invalidateSpy.mockClear();
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    expect(useOfflineQueueStore.getState().isSyncing).toBe(false);
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    // Simulate network abort on mut-1 after switch
    rejectFirstPost(new TypeError('Aborted due to session switch'));
    await new Promise((r) => setTimeout(r, 25));

    // mut-2 must NEVER be sent under User B, User B cache must not be invalidated, and mut-1/mut-2 remain PENDING for User A
    expect(postCalls).toEqual(['Bearer tok-a:mut-1']);
    expect(invalidateSpy).not.toHaveBeenCalled();

    useAuthStore.getState().setAuth(userA, 'tok-a2', 'ref-a2');
    const restoredA = useOfflineQueueStore.getState().queue;
    expect(restoredA.map((q) => [q.clientMutationId, q.syncStatus])).toEqual([
      ['mut-1', 'PENDING'],
      ['mut-2', 'PENDING'],
    ]);
  });

  it('L-02: prevents stale QuickAddExpenseModal responses and TypeError offline fallback after account switch', async () => {
    const userA = makeUser({ id: 'user-a', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', email: 'bob@example.com' });
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');

    let resolveSubmit!: (res: Response) => void;
    let rejectSubmit!: (err: Error) => void;
    let callCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/trips/trip-1/expenses') && init?.method === 'POST') {
          callCount += 1;
          if (callCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveSubmit = resolve;
            });
          }
          return new Promise<Response>((_resolve, reject) => {
            rejectSubmit = reject;
          });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );

    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <QuickAddExpenseModal
          tripId="trip-1"
          tripName="Mustang Trip"
          tripMode="FRIENDS"
          myParticipantId="p-a"
          participants={makeTripPayload('user-a').participants}
          families={[]}
          onClose={onClose}
        />
      </QueryClientProvider>
    );

    // 1. Account switches before online 201 resolves
    fireEvent.change(screen.getByPlaceholderText(/Highway Fuel/i), {
      target: { value: 'Stale Fuel' },
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\., 5000/i), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Expense/i }));

    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    resolveSubmit(jsonResponse({ success: true, data: { expense: { id: 'e-stale' } } }, 201));
    await new Promise((r) => setTimeout(r, 25));

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    // 2. Network TypeError arrives after account switch -> must NOT enqueue into User B or User A
    cleanup();
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    onClose.mockClear();
    invalidateSpy.mockClear();

    render(
      <QueryClientProvider client={qc}>
        <QuickAddExpenseModal
          tripId="trip-1"
          tripName="Mustang Trip"
          tripMode="FRIENDS"
          myParticipantId="p-a"
          participants={makeTripPayload('user-a').participants}
          families={[]}
          onClose={onClose}
        />
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Highway Fuel/i), {
      target: { value: 'Dropped Fuel' },
    });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\., 5000/i), {
      target: { value: '700' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Expense/i }));

    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    rejectSubmit(new TypeError('Network dropped'));
    await new Promise((r) => setTimeout(r, 25));

    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-b'))).toBeNull();
    expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Network dropped/i)).not.toBeInTheDocument();
    void rerender;
  });

  it('L-02: guards AcceptInvitePage, VerifyEmailPage, and SettingsPage async flows against session switches', async () => {
    const userA = makeUser({
      id: 'user-a',
      name: 'Alice Unverified',
      email: 'alice@example.com',
      emailVerified: true,
    });
    const userB = makeUser({
      id: 'user-b',
      name: 'Bob Unverified',
      email: 'bob@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
    });

    let resolveClaim!: (res: Response) => void;
    let resolveVerify!: (res: Response) => void;
    let resolveSettingsSave!: (res: Response) => void;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/trips/invites/claim') && method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveClaim = resolve;
          });
        }
        if (url.endsWith('/auth/verify-email') && method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveVerify = resolve;
          });
        }
        if (url.endsWith('/auth/me') && method === 'GET') {
          return jsonResponse({ success: true, data: { user: userA } });
        }
        if (url.endsWith('/auth/me') && method === 'PATCH') {
          return new Promise<Response>((resolve) => {
            resolveSettingsSave = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    // 1. AcceptInvitePage claim response after switch -> no accepted banner, no cache invalidation
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    const qcInvite = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const inviteInvalidateSpy = vi.spyOn(qcInvite, 'invalidateQueries');

    render(
      <QueryClientProvider client={qcInvite}>
        <MemoryRouter initialEntries={['/invites/claim?token=inv-token-a']}>
          <Routes>
            <Route path="/invites/claim" element={<AcceptInvitePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Accept Invitation/i }));
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');

    resolveClaim(
      jsonResponse({
        success: true,
        data: {
          tripId: 'trip-a',
          role: 'ORGANIZER',
          participant: { id: 'p-1', tripId: 'trip-a', userId: 'user-a', role: 'ORGANIZER' },
          trip: { id: 'trip-a', name: 'Alice Confidential Trip' },
        },
      })
    );
    await new Promise((r) => setTimeout(r, 25));

    expect(inviteInvalidateSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/Invitation accepted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Alice Confidential Trip/i)).not.toBeInTheDocument();

    // 2. VerifyEmailPage verification response after switch -> must NOT verify or display stale success
    cleanup();
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    render(
      <MemoryRouter initialEntries={['/verify-email?token=verify-tok-b']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    // While verifying token for user-b, account logs out -> logs back in as user-b (new sessionGeneration)
    useAuthStore.getState().clearAuth();
    useAuthStore.getState().setAuth(userB, 'tok-b2', 'ref-b2');

    resolveVerify(
      jsonResponse({
        success: true,
        data: {
          verified: true,
          userId: 'user-b',
          emailVerified: true,
          emailVerifiedAt: '2026-11-18T06:00:00.000Z',
        },
      })
    );
    await new Promise((r) => setTimeout(r, 25));

    expect(useAuthStore.getState().user?.emailVerified).toBe(false);
    expect(screen.queryByText(/Your email address has been verified\./i)).not.toBeInTheDocument();

    // 2b. VerifyEmailPage failed token after switch -> stale error banner must NOT appear for new session
    cleanup();
    let rejectVerify!: (err: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/auth/verify-email') && method === 'POST') {
          return new Promise<Response>((_resolve, reject) => {
            rejectVerify = reject;
          });
        }
        if (url.endsWith('/trips/invites/claim') && method === 'POST') {
          return Promise.reject(new Error('Stale invite claim failure'));
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    render(
      <MemoryRouter initialEntries={['/verify-email?token=fail-tok-a']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    rejectVerify(new Error('Stale verification link error'));
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByText(/Stale verification link error/i)).not.toBeInTheDocument();

    // 2c. AcceptInvitePage failed claim & resend verification after switch -> stale results must NOT apply to User B
    cleanup();
    let rejectClaim!: (err: Error) => void;
    let resolveResend!: (res: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/trips/invites/claim') && method === 'POST') {
          return new Promise<Response>((_resolve, reject) => {
            rejectClaim = reject;
          });
        }
        if (url.endsWith('/auth/resend-verification') && method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveResend = resolve;
          });
        }
        if (url.endsWith('/auth/me') && method === 'GET') {
          return jsonResponse({ success: true, data: { user: userA } });
        }
        if (url.endsWith('/auth/me') && method === 'PATCH') {
          return new Promise<Response>((resolve) => {
            resolveSettingsSave = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    const qcClaimErr = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcClaimErr}>
        <MemoryRouter initialEntries={['/invites/claim?token=inv-fail-a']}>
          <Routes>
            <Route path="/invites/claim" element={<AcceptInvitePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept Invitation/i }));
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    rejectClaim(new Error('Stale invite claim rejection'));
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByText(/Stale invite claim rejection/i)).not.toBeInTheDocument();

    // Resend verification resolving alreadyVerified: true after logout & re-login must NOT verify or display stale notice
    fireEvent.click(screen.getByRole('button', { name: /Resend Verification Email/i }));
    useAuthStore.getState().clearAuth();
    useAuthStore.getState().setAuth(userB, 'tok-b3', 'ref-b3');
    resolveResend(
      jsonResponse({
        success: true,
        data: { sent: false, alreadyVerified: true, emailVerified: true },
      })
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByText(/already verified/i)).not.toBeInTheDocument();
    expect(useAuthStore.getState().user?.id).toBe('user-b');
    expect(useAuthStore.getState().user?.emailVerified).toBe(false);

    // 3. SettingsPage PATCH /auth/me resolving after switch -> must NOT overwrite User B profile
    cleanup();
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice Unverified')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');

    resolveSettingsSave(
      jsonResponse({
        success: true,
        data: { user: { ...userA, name: 'Alice Renamed' } },
      })
    );
    await new Promise((r) => setTimeout(r, 25));

    expect(useAuthStore.getState().user?.id).toBe('user-b');
    expect(useAuthStore.getState().user?.name).toBe('Bob Unverified');
    expect(screen.queryByText(/Profile updated successfully/i)).not.toBeInTheDocument();
  });

  it('L-02: guards DashboardPage invite-code join and CreateTripPage submission against stale navigation and cache invalidation', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    let resolveJoin!: (res: Response) => void;
    let rejectJoin!: (err: Error) => void;
    let joinCalls = 0;
    let resolveCreateTrip!: (res: Response) => void;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/dashboard/summary')) {
          return jsonResponse({
            success: true,
            data: {
              metrics: {
                activeTripsCount: 0,
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
        if (url.includes('/trips/join/') && method === 'POST') {
          joinCalls += 1;
          if (joinCalls === 1) {
            return new Promise<Response>((resolve) => {
              resolveJoin = resolve;
            });
          }
          return new Promise<Response>((_resolve, reject) => {
            rejectJoin = reject;
          });
        }
        if (url.endsWith('/trips') && method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveCreateTrip = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    // 1. DashboardPage join resolve after switch -> no navigate, no cache invalidation
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    const qcDash = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dashInvalidateSpy = vi.spyOn(qcDash, 'invalidateQueries');

    render(
      <QueryClientProvider client={qcDash}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<><DashboardPage /><PathProbe /></>} />
            <Route path="/trips/:tripId" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Enter 8-char code/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/Enter 8-char code/i), {
      target: { value: 'JOIN1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Join$/i }));

    dashInvalidateSpy.mockClear();
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');

    resolveJoin(jsonResponse({ success: true, data: { trip: { id: 'trip-alice-secret' } } }));
    await new Promise((r) => setTimeout(r, 25));

    expect(screen.getByTestId('current-path').textContent).toBe('/');
    expect(dashInvalidateSpy).not.toHaveBeenCalled();

    // 2. DashboardPage join failure after switch -> no stale joinError displayed to User B
    fireEvent.change(screen.getByPlaceholderText(/Enter 8-char code/i), {
      target: { value: 'FAIL9999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Join$/i }));

    useAuthStore.getState().setAuth(userA, 'tok-a2', 'ref-a2');
    rejectJoin(new Error('Stale invalid code error'));
    await new Promise((r) => setTimeout(r, 25));

    expect(screen.queryByText(/Stale invalid code error/i)).not.toBeInTheDocument();

    // 3. CreateTripPage submit resolving after switch -> no navigate, no cache invalidation
    cleanup();
    useAuthStore.getState().setAuth(userA, 'tok-a2', 'ref-a2');
    const qcCreate = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const createInvalidateSpy = vi.spyOn(qcCreate, 'invalidateQueries');

    render(
      <QueryClientProvider client={qcCreate}>
        <MemoryRouter initialEntries={['/trips/new']}>
          <Routes>
            <Route path="/trips/new" element={<><CreateTripPage /><PathProbe /></>} />
            <Route path="/trips/:tripId" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Mustang Bike Trip/i), {
      target: { value: 'Stale New Trip' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Trip/i }));

    useAuthStore.getState().setAuth(userB, 'tok-b2', 'ref-b2');
    resolveCreateTrip(jsonResponse({ success: true, data: { trip: { id: 'trip-stale-new' } } }, 201));
    await new Promise((r) => setTimeout(r, 25));

    expect(screen.getByTestId('current-path').textContent).toBe('/trips/new');
    expect(createInvalidateSpy).not.toHaveBeenCalled();
  });
});
