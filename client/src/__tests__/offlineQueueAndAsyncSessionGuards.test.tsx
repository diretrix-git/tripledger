// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { App } from '../App.js';
import { QuickAddExpenseModal } from '../components/expenses/QuickAddExpenseModal.js';
import { AppShell } from '../components/layout/AppShell.js';
import { useOfflineSync } from '../hooks/useOfflineSync.js';
import { AcceptInvitePage } from '../pages/AcceptInvitePage.js';
import { AuthPage } from '../pages/AuthPage.js';
import { CreateTripPage } from '../pages/CreateTripPage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { VerifyEmailPage } from '../pages/VerifyEmailPage.js';
import { AUTH_STORAGE_KEY, useAuthStore, type AuthUser } from '../stores/authStore.js';
import {
  createOfflineQueueStore,
  getOfflineQueueStorageKey,
  LEGACY_OFFLINE_QUEUE_STORAGE_KEY,
  useOfflineQueueStore,
  type OfflineQueueStore,
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

function installTestWebLocks() {
  const held = new Map<string, { waiters: Array<() => void> }>();
  const request = (
    name: string,
    optsOrCb: LockOptions | LockGrantedCallback<unknown>,
    maybeCb?: LockGrantedCallback<unknown>
  ): Promise<unknown> => {
    const opts: LockOptions = typeof optsOrCb === 'function' ? {} : optsOrCb;
    const callback: LockGrantedCallback<unknown> =
      typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;

    const acquireAndRun = async () => {
      const state = held.get(name)!;
      try {
        return await callback({ name, mode: opts.mode ?? 'exclusive' } as Lock);
      } finally {
        const nextWaiter = state.waiters.shift();
        if (nextWaiter) {
          nextWaiter();
        } else {
          held.delete(name);
        }
      }
    };

    const existing = held.get(name);
    if (existing) {
      if (opts.ifAvailable) {
        return Promise.resolve(callback(null));
      }
      return new Promise<void>((resolve) => {
        existing.waiters.push(resolve);
      }).then(acquireAndRun);
    }

    held.set(name, { waiters: [] });
    return Promise.resolve().then(acquireAndRun);
  };

  Object.defineProperty(navigator, 'locks', {
    value: { request },
    configurable: true,
  });
}

describe('Phase 3.1.6: Offline queue account isolation (L-01) and async session guards (L-02)', () => {
  const createdStores: OfflineQueueStore[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true,
    });
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({
      isOnline: true,
      isSyncing: false,
      activeUserId: null,
      queue: [],
      legacyDiscardedCount: 0,
      crossTabCoordinationDegraded: false,
      syncError: null,
    });
  });

  afterEach(() => {
    while (createdStores.length > 0) {
      createdStores.pop()?.getState().destroy();
    }
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true,
    });
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
  }, 15000);

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
    await useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'mut-1', userId: 'user-a' }));
    await useOfflineQueueStore
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

  it('M-01: serializes concurrent multi-tab queue mutations and flush coordination via Web Locks without losing sibling entries', async () => {
    installTestWebLocks();
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');

    // Two independent tab stores sharing localStorage & navigator.locks (without cross-tab storage event delivery yet)
    const tab1Store = createOfflineQueueStore({ bindWindowEvents: false });
    const tab2Store = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(tab1Store, tab2Store);
    tab1Store.getState().setOnlineStatus(false);
    tab2Store.getState().setOnlineStatus(false);

    // 1. Two tabs concurrently enqueue different expenses for the same user
    const [ok1, ok2] = await Promise.all([
      tab1Store.getState().enqueueExpense(makeQueuedEntry({ clientMutationId: 'tab-mut-1', userId: 'user-a' })),
      tab2Store.getState().enqueueExpense(makeQueuedEntry({ clientMutationId: 'tab-mut-2', userId: 'user-a' })),
    ]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    const persistedAfterConcurrentEnqueue = JSON.parse(
      window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))!
    ) as { queue: QueuedOfflineExpense[] };
    expect(persistedAfterConcurrentEnqueue.queue.map((q) => q.clientMutationId).sort()).toEqual([
      'tab-mut-1',
      'tab-mut-2',
    ]);

    // 2. Tab 1 changes tab-mut-1 status while Tab 2 concurrently enqueues tab-mut-3
    await Promise.all([
      tab1Store.getState().markItemStatus('tab-mut-1', 'SYNCING', undefined, 'user-a'),
      tab2Store.getState().enqueueExpense(makeQueuedEntry({ clientMutationId: 'tab-mut-3', userId: 'user-a' })),
    ]);

    const persistedAfterStatusAndEnqueue = JSON.parse(
      window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))!
    ) as { queue: QueuedOfflineExpense[] };
    expect(
      persistedAfterStatusAndEnqueue.queue
        .map((q) => [q.clientMutationId, q.syncStatus])
        .sort()
    ).toEqual([
      ['tab-mut-1', 'SYNCING'],
      ['tab-mut-2', 'PENDING'],
      ['tab-mut-3', 'PENDING'],
    ]);

    // 3. Tab 1 removes tab-mut-1 while Tab 2 concurrently enqueues tab-mut-4
    await Promise.all([
      tab1Store.getState().removeQueuedExpense('tab-mut-1', 'user-a'),
      tab2Store.getState().enqueueExpense(makeQueuedEntry({ clientMutationId: 'tab-mut-4', userId: 'user-a' })),
    ]);

    const persistedAfterRemoveAndEnqueue = JSON.parse(
      window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))!
    ) as { queue: QueuedOfflineExpense[] };
    expect(
      persistedAfterRemoveAndEnqueue.queue.map((q) => q.clientMutationId).sort()
    ).toEqual(['tab-mut-2', 'tab-mut-3', 'tab-mut-4']);

    // 4. Concurrent flush attempts from two tabs coordinate via Web Locks { ifAvailable: true }
    //    so only one tab transmits POST requests while the other stands down
    window.localStorage.removeItem(getOfflineQueueStorageKey('user-a'));
    await tab1Store.getState().refreshUserQueueFromStorage('user-a');
    await tab2Store.getState().refreshUserQueueFromStorage('user-a');
    await tab1Store
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'sync-single-1', userId: 'user-a' }));
    await tab2Store.getState().refreshUserQueueFromStorage('user-a');

    let resolveSharedPost!: (res: Response) => void;
    const postMutationIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/trips/trip-1/expenses') && init?.method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
          postMutationIds.push(body.clientMutationId);
          return new Promise<Response>((resolve) => {
            resolveSharedPost = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );

    let flushTab1!: () => Promise<void>;
    let flushTab2!: () => Promise<void>;
    function DualTabSyncProbe({
      store,
      assignFlush,
    }: {
      store: OfflineQueueStore;
      assignFlush: (fn: () => Promise<void>) => void;
    }) {
      const { flushOfflineQueue } = useOfflineSync(store);
      assignFlush(flushOfflineQueue);
      return null;
    }

    tab1Store.getState().setOnlineStatus(true);
    tab2Store.getState().setOnlineStatus(true);
    const qcDual = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qcDual}>
        <DualTabSyncProbe store={tab1Store} assignFlush={(fn) => { flushTab1 = fn; }} />
        <DualTabSyncProbe store={tab2Store} assignFlush={(fn) => { flushTab2 = fn; }} />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(postMutationIds).toHaveLength(1);
    });
    // Tab 2 triggers flush while Tab 1 holds the per-user sync lock -> must not duplicate POST
    await flushTab2();
    expect(postMutationIds).toEqual(['sync-single-1']);

    resolveSharedPost(jsonResponse({ success: true, data: { expense: { id: 'exp-dual-1' } } }, 201));
    await waitFor(() => {
      expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toBeNull();
    });
    void flushTab1;

    // 5. Fallback mode (without navigator.locks): within-tab concurrent Promise.all preserves both items cleanly
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true,
    });
    const fallbackStore = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(fallbackStore);
    fallbackStore.getState().setOnlineStatus(false);
    await Promise.all([
      fallbackStore.getState().enqueueExpense(makeQueuedEntry({ clientMutationId: 'fb-1', userId: 'user-a' })),
      fallbackStore.getState().enqueueExpense(makeQueuedEntry({ clientMutationId: 'fb-2', userId: 'user-a' })),
    ]);
    expect(fallbackStore.getState().queue.map((q) => q.clientMutationId)).toEqual([
      'fb-1',
      'fb-2',
    ]);
  });

  it('M-01 & L-01: preserves correct user-a queue when 201 arrives during account switch, ignores late user-a storage events while user-b is active, handles key===null storage clears, and retries FAILED items manually', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    useOfflineQueueStore.getState().setOnlineStatus(false);
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    await useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'ok-1', userId: 'user-a' }));
    await useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'ok-2', userId: 'user-a' }));

    let resolveOk1!: (res: Response) => void;
    const postedInOrder: Array<{ token: string | null; clientMutationId: string }> = [];

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
          postedInOrder.push({ token: auth, clientMutationId: body.clientMutationId });
          if (body.clientMutationId === 'ok-1') {
            return new Promise<Response>((resolve) => {
              resolveOk1 = resolve;
            });
          }
          return jsonResponse({ success: true, data: { expense: { id: 'exp-ok-2' } } }, 201);
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

    // Go online to begin ok-1 POST
    useOfflineQueueStore.getState().setOnlineStatus(true);
    await waitFor(() => {
      expect(postedInOrder).toEqual([{ token: 'Bearer tok-a', clientMutationId: 'ok-1' }]);
    });

    // Account switches to User B while ok-1 is in flight, then ok-1 returns HTTP 201
    invalidateSpy.mockClear();
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    resolveOk1(jsonResponse({ success: true, data: { expense: { id: 'exp-ok-1' } } }, 201));
    await new Promise((r) => setTimeout(r, 30));

    // ok-2 must NOT be submitted under User B, User B cache not invalidated, User B queue stays empty
    expect(postedInOrder).toEqual([{ token: 'Bearer tok-a', clientMutationId: 'ok-1' }]);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    expect(useOfflineQueueStore.getState().isSyncing).toBe(false);

    // Late storage event for User A arriving while User B is active is ignored cleanly
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: getOfflineQueueStorageKey('user-a'),
        newValue: window.localStorage.getItem(getOfflineQueueStorageKey('user-a')),
        storageArea: window.localStorage,
      })
    );
    expect(useOfflineQueueStore.getState().activeUserId).toBe('user-b');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    // Switch back to User A: ok-1 was removed cleanly and only ok-2 resumes and syncs
    useAuthStore.getState().setAuth(userA, 'tok-a2', 'ref-a2');
    await waitFor(() => {
      expect(postedInOrder).toEqual([
        { token: 'Bearer tok-a', clientMutationId: 'ok-1' },
        { token: 'Bearer tok-a2', clientMutationId: 'ok-2' },
      ]);
    });
    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    });

    // StorageEvent with key === null clears queue and resets activeUserId without hydrating legacy items
    useOfflineQueueStore.getState().setOnlineStatus(false);
    await useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'clear-evt-1', userId: 'user-a' }));
    expect(useOfflineQueueStore.getState().activeUserId).toBe('user-a');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(1);

    window.localStorage.clear();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: null,
        newValue: null,
        storageArea: window.localStorage,
      })
    );
    expect(useOfflineQueueStore.getState().activeUserId).toBeNull();
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    expect(useAuthStore.getState().user).toBeNull();

    // Failed expense synchronization preserves FAILED + error across reload and succeeds on manual "Sync Now" retry
    cleanup();
    let failAttempts = 0;
    const retryIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/auth/me')) {
          return jsonResponse({ success: true, data: { user: userA } });
        }
        if (url.endsWith('/trips/trip-1/expenses') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
          retryIds.push(body.clientMutationId);
          failAttempts += 1;
          if (failAttempts === 1) {
            return jsonResponse(
              { success: false, error: { code: 'SERVER_BUSY', message: 'Temporary Outage' } },
              503
            );
          }
          return jsonResponse({ success: true, data: { expense: { id: 'exp-retried' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    useOfflineQueueStore.getState().setOnlineStatus(false);
    useAuthStore.getState().setAuth(userA, 'tok-a3', 'ref-a3');
    await useOfflineQueueStore
      .getState()
      .enqueueExpense(makeQueuedEntry({ clientMutationId: 'retry-mut-1', userId: 'user-a' }));

    const qcRetry = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcRetry}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<div>Home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    useOfflineQueueStore.getState().setOnlineStatus(true);
    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue[0]?.syncStatus).toBe('FAILED');
    });
    expect(useOfflineQueueStore.getState().queue[0]?.lastError).toBe('Temporary Outage');
    expect(retryIds).toEqual(['retry-mut-1']);

    // Manual retry via "Sync Now" reuses exact clientMutationId and clears queue on 201
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));
    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    });
    expect(retryIds).toEqual(['retry-mut-1', 'retry-mut-1']);
    expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toBeNull();
  });

  it('L-02: blocks stale AuthPage login completion after cross-tab account switch and clears CreateTripPage stale error banner on switch', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    let loginCount = 0;
    let resolveStaleLogin!: (res: Response) => void;
    let tripCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/auth/login') && method === 'POST') {
          loginCount += 1;
          if (loginCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveStaleLogin = resolve;
            });
          }
          return jsonResponse({
            success: true,
            data: { user: userA, accessToken: 'tok-a-fresh', refreshToken: 'ref-a-fresh' },
          });
        }
        if (url.endsWith('/trips') && method === 'POST') {
          tripCount += 1;
          if (tripCount === 1) {
            return jsonResponse(
              { success: false, error: { code: 'VALIDATION_ERROR', message: 'Stale Trip Error' } },
              400
            );
          }
          return jsonResponse({ success: true, data: { trip: { id: 'trip-b-valid' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    // 1. AuthPage stale login completion cannot overwrite newer cross-tab session
    const qcAuth = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcAuth}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<><AuthPage mode="login" /><PathProbe /></>} />
            <Route path="/" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: userA.email },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'Password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Sign In$/i }));

    // Tab 2 signs in as User B via cross-tab storage event before Tab 1 resolves
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: AUTH_STORAGE_KEY,
        newValue: JSON.stringify({
          state: { user: userB, accessToken: 'tok-b-tab2', refreshToken: 'ref-b-tab2' },
          version: 0,
        }),
        storageArea: window.localStorage,
      })
    );
    expect(useAuthStore.getState().user?.id).toBe('user-b');

    resolveStaleLogin(
      jsonResponse({
        success: true,
        data: { user: userA, accessToken: 'tok-a-stale', refreshToken: 'ref-a-stale' },
      })
    );
    await waitFor(() => {
      expect(screen.getByText(/session changed in another tab/i)).toBeInTheDocument();
    });
    expect(useAuthStore.getState().user?.id).toBe('user-b');
    expect(useAuthStore.getState().accessToken).toBe('tok-b-tab2');
    expect(screen.getByTestId('current-path').textContent).toBe('/login');

    // Legitimate subsequent re-submit when no competing transition occurs still succeeds cleanly
    fireEvent.click(screen.getByRole('button', { name: /^Sign In$/i }));
    await waitFor(() => {
      expect(useAuthStore.getState().user?.id).toBe('user-a');
      expect(useAuthStore.getState().accessToken).toBe('tok-a-fresh');
      expect(screen.getByTestId('current-path').textContent).toBe('/');
    });

    // 2. CreateTripPage clears stale error notice after account switch and preserves valid submission
    cleanup();
    useAuthStore.getState().setAuth(userA, 'tok-a-fresh', 'ref-a-fresh');
    const qcCreate = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      target: { value: 'Bad Trip' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Trip/i }));
    await waitFor(() => {
      expect(screen.getByText(/Stale Trip Error/i)).toBeInTheDocument();
    });

    // Account switch clears stale error banner immediately
    useAuthStore.getState().setAuth(userB, 'tok-b2', 'ref-b2');
    await waitFor(() => {
      expect(screen.queryByText(/Stale Trip Error/i)).not.toBeInTheDocument();
    });

    // Same-session valid submission under User B still navigates cleanly
    fireEvent.change(screen.getByPlaceholderText(/Mustang Bike Trip/i), {
      target: { value: 'Valid Bob Trip' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Trip/i }));
    await waitFor(() => {
      expect(screen.getByTestId('current-path').textContent).toBe('/trips/trip-b-valid');
    });
  });

  it('Phase 3.1.10 L-01 (mocked jsdom Web Locks): protects active peer SYNCING entries while sync lock is held, then recovers orphaned SYNCING automatically and via manual Sync Now with stable clientMutationId', async () => {
    installTestWebLocks();
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');

    // Note: installTestWebLocks + two stores in one jsdom runtime simulate Web Locks lock-queue
    // contention cleanly without multi-process browser tabs.
    const postedMutations: Array<{ clientMutationId: string; title: string; token: string | null }> =
      [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const auth = new Headers(init?.headers).get('Authorization');
        if (url.endsWith('/auth/me')) {
          return jsonResponse({ success: true, data: { user: userA } });
        }
        if (url.endsWith('/trips/trip-1/expenses') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as {
            clientMutationId: string;
            title: string;
          };
          postedMutations.push({
            clientMutationId: body.clientMutationId,
            title: body.title,
            token: auth,
          });
          return jsonResponse({ success: true, data: { expense: { id: 'exp-recovered-1' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    // 1. Seed storage with an active SYNCING item owned by a live peer Tab 1 holding sync:user-a
    const orphanEntry = makeQueuedEntry({
      clientMutationId: 'mut-orphan-1',
      userId: 'user-a',
      syncStatus: 'SYNCING',
      payload: {
        title: 'Pokhara Bus Ticket',
        category: 'TRANSPORTATION',
        amountPaisa: 45000,
        isEstimated: false,
        isPackage: false,
        splitMethod: 'EQUAL',
        paymentMethod: 'CASH',
        incurredAt: '2026-11-18T06:00:00.000Z',
        payments: [{ participantId: 'p-a', amountPaisa: 45000 }],
        clientMutationId: 'mut-orphan-1',
      },
    });
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-a'),
      JSON.stringify({ version: 1, userId: 'user-a', queue: [orphanEntry] })
    );

    let releaseTab1Lock!: () => void;
    let tab1Acquired = false;
    void navigator.locks.request(
      'tripledger:offline-queue:sync:user-a',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          tab1Acquired = true;
          releaseTab1Lock = resolve;
        })
    );
    await waitFor(() => {
      expect(tab1Acquired).toBe(true);
    });

    const survivingTabStore = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(survivingTabStore);
    survivingTabStore.getState().setOnlineStatus(true);
    await survivingTabStore.getState().refreshUserQueueFromStorage('user-a');

    let flushSurvivingManual!: () => Promise<void>;
    function RecoveryProbe() {
      const { flushOfflineQueue } = useOfflineSync(survivingTabStore);
      flushSurvivingManual = flushOfflineQueue;
      return null;
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RecoveryProbe />
      </QueryClientProvider>
    );

    // Trigger manual flush while Tab 1 still actively holds sync:user-a -> MUST NOT reset SYNCING or duplicate POST
    await flushSurvivingManual();
    expect(postedMutations).toEqual([]);
    expect(survivingTabStore.getState().queue[0]?.syncStatus).toBe('SYNCING');
    expect(
      (
        JSON.parse(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))!) as {
          queue: QueuedOfflineExpense[];
        }
      ).queue[0]?.syncStatus
    ).toBe('SYNCING');

    // 2. Simulate Tab 1 crashing/closing: lock releases while mut-orphan-1 stays SYNCING in storage
    releaseTab1Lock();

    await waitFor(() => {
      expect(postedMutations).toEqual([
        {
          clientMutationId: 'mut-orphan-1',
          title: 'Pokhara Bus Ticket',
          token: 'Bearer tok-a',
        },
      ]);
    });
    await waitFor(() => {
      expect(survivingTabStore.getState().queue).toHaveLength(0);
      expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toBeNull();
    });

    // 3. Normal peer completion (201 remove or 503 FAILED) does NOT cause redundant recovery or retries
    cleanup();
    postedMutations.length = 0;
    const failedEntry = makeQueuedEntry({
      clientMutationId: 'mut-peer-finished',
      userId: 'user-a',
      syncStatus: 'SYNCING',
    });
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-a'),
      JSON.stringify({ version: 1, userId: 'user-a', queue: [failedEntry] })
    );

    let releaseTab1Normal!: () => void;
    tab1Acquired = false;
    void navigator.locks.request(
      'tripledger:offline-queue:sync:user-a',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          tab1Acquired = true;
          releaseTab1Normal = resolve;
        })
    );
    await waitFor(() => {
      expect(tab1Acquired).toBe(true);
    });

    const tab1PeerStore = createOfflineQueueStore({ bindWindowEvents: false });
    const tab2PeerStore = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(tab1PeerStore, tab2PeerStore);
    tab1PeerStore.getState().setOnlineStatus(true);
    tab2PeerStore.getState().setOnlineStatus(true);
    await tab2PeerStore.getState().refreshUserQueueFromStorage('user-a');
    expect(tab2PeerStore.getState().queue[0]?.syncStatus).toBe('SYNCING');

    function PeerWatcherProbe() {
      useOfflineSync(tab2PeerStore);
      return null;
    }

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PeerWatcherProbe />
      </QueryClientProvider>
    );

    // Tab 1 completes with a 503 -> FAILED in shared localStorage cleanly while Tab 2 still has SYNCING in memory,
    // then Tab 1 releases sync:user-a -> Tab 2 must acquire sync:user-a, read FAILED from storage, and NOT retry
    await tab1PeerStore.getState().markItemStatus('mut-peer-finished', 'FAILED', 'Server busy', 'user-a');
    expect(tab2PeerStore.getState().queue[0]?.syncStatus).toBe('SYNCING');
    releaseTab1Normal();
    await waitFor(() => {
      expect(tab2PeerStore.getState().queue[0]?.syncStatus).toBe('FAILED');
    });
    expect(tab2PeerStore.getState().queue[0]?.lastError).toBe('Server busy');
    expect(postedMutations).toEqual([]);

    // 4. Manual "Sync Now" recovers orphaned SYNCING if previous recovery did not run while offline / lock failed
    cleanup();
    const manualOrphan = makeQueuedEntry({
      clientMutationId: 'mut-manual-orphan',
      userId: 'user-a',
      syncStatus: 'SYNCING',
      payload: {
        title: 'Thamel Dinner',
        category: 'FOOD_DRINKS',
        amountPaisa: 62000,
        isEstimated: false,
        isPackage: false,
        splitMethod: 'EQUAL',
        paymentMethod: 'CASH',
        incurredAt: '2026-11-18T06:00:00.000Z',
        payments: [{ participantId: 'p-a', amountPaisa: 62000 }],
        clientMutationId: 'mut-manual-orphan',
      },
    });
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-a'),
      JSON.stringify({ version: 1, userId: 'user-a', queue: [manualOrphan] })
    );

    // Fail the automatic recovery watcher lock check once so mut-manual-orphan remains SYNCING cleanly,
    // then restore working Web Locks and recover via explicit user click on "Sync Now".
    const origRequest = navigator.locks.request.bind(navigator.locks);
    let rejectNextSyncLock = true;
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: (
          name: string,
          optsOrCb: LockOptions | LockGrantedCallback<unknown>,
          maybeCb?: LockGrantedCallback<unknown>
        ) => {
          if (rejectNextSyncLock && name.includes(':sync:')) {
            rejectNextSyncLock = false;
            return Promise.reject(new DOMException('Transient lock outage', 'AbortError'));
          }
          return origRequest(name, optsOrCb as LockOptions, maybeCb!);
        },
      },
      configurable: true,
    });

    useOfflineQueueStore.getState().setOnlineStatus(true);
    useOfflineQueueStore.setState({
      isOnline: true,
      isSyncing: false,
      activeUserId: 'user-a',
      queue: [manualOrphan],
      legacyDiscardedCount: 0,
      crossTabCoordinationDegraded: false,
      syncError: null,
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<div>Home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/exclusive cross-tab sync lock/i);
    });
    expect(useOfflineQueueStore.getState().isSyncing).toBe(false);
    expect(postedMutations).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));
    await waitFor(() => {
      expect(postedMutations).toEqual([
        {
          clientMutationId: 'mut-manual-orphan',
          title: 'Thamel Dinner',
          token: 'Bearer tok-a',
        },
      ]);
    });
    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('Phase 3.1.10 L-01 (mocked jsdom Web Locks): aborts orphaned SYNCING recovery safely on session switch and preserves exact entry for owning user re-login', async () => {
    installTestWebLocks();
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    const orphanA = makeQueuedEntry({
      clientMutationId: 'mut-switch-orphan-1',
      userId: 'user-a',
      syncStatus: 'SYNCING',
    });
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-a'),
      JSON.stringify({ version: 1, userId: 'user-a', queue: [orphanA] })
    );

    const postedWithAuth: Array<{ token: string | null; clientMutationId: string }> = [];
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
          postedWithAuth.push({ token: auth, clientMutationId: body.clientMutationId });
          return jsonResponse({ success: true, data: { expense: { id: 'exp-a-resumed' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    let releaseTab1Lock!: () => void;
    let tab1Acquired = false;
    void navigator.locks.request(
      'tripledger:offline-queue:sync:user-a',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          tab1Acquired = true;
          releaseTab1Lock = resolve;
        })
    );
    await waitFor(() => {
      expect(tab1Acquired).toBe(true);
    });

    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    // Keep SYNCING state in active store directly to mirror live Tab 1 peer event
    useOfflineQueueStore.setState({
      isOnline: true,
      isSyncing: false,
      activeUserId: 'user-a',
      queue: [orphanA],
      legacyDiscardedCount: 0,
      crossTabCoordinationDegraded: false,
      syncError: null,
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<div>Home</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Account switches to User B BEFORE Tab 1 releases sync:user-a
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    releaseTab1Lock();
    await new Promise((r) => setTimeout(r, 35));

    // Must never send User A's entry under User B or touch User B's queue
    expect(postedWithAuth).toEqual([]);
    expect(useOfflineQueueStore.getState().activeUserId).toBe('user-b');
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    expect(
      (
        JSON.parse(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))!) as {
          queue: QueuedOfflineExpense[];
        }
      ).queue[0]?.clientMutationId
    ).toBe('mut-switch-orphan-1');

    // Switch back to User A -> recovers and submits exact clientMutationId under User A
    useAuthStore.getState().setAuth(userA, 'tok-a-2', 'ref-a-2');
    await waitFor(() => {
      expect(postedWithAuth).toEqual([
        { token: 'Bearer tok-a-2', clientMutationId: 'mut-switch-orphan-1' },
      ]);
    });
    await waitFor(() => {
      expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
    });
  });

  it('Phase 3.1.10 L-02 (mocked jsdom Web Locks): handles rejected navigator.locks.request during mutations and sync without unhandled rejections, unsafe flushing, or stuck syncing state', async () => {
    const unhandledReasons: unknown[] = [];
    const onBrowserUnhandled = (event: PromiseRejectionEvent) => {
      unhandledReasons.push(event.reason);
    };
    const onNodeUnhandled = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    window.addEventListener('unhandledrejection', onBrowserUnhandled);
    process.on('unhandledRejection', onNodeUnhandled);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
      useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
      useOfflineQueueStore.getState().setOnlineStatus(false);

      // 1. Reject ALL navigator.locks.request calls for mutations
      Object.defineProperty(navigator, 'locks', {
        value: {
          request: vi.fn(async () => {
            throw new DOMException('Mutation lock denied in restricted context', 'SecurityError');
          }),
        },
        configurable: true,
      });

      const [r1, r2] = await Promise.all([
        useOfflineQueueStore
          .getState()
          .enqueueExpense(makeQueuedEntry({ clientMutationId: 'rej-mut-1', userId: 'user-a' })),
        useOfflineQueueStore
          .getState()
          .enqueueExpense(makeQueuedEntry({ clientMutationId: 'rej-mut-2', userId: 'user-a' })),
      ]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(useOfflineQueueStore.getState().crossTabCoordinationDegraded).toBe(true);
      expect(useOfflineQueueStore.getState().queue.map((q) => q.clientMutationId)).toEqual([
        'rej-mut-1',
        'rej-mut-2',
      ]);
      expect(warnSpy).toHaveBeenCalled();

      // Update + remove continue functioning cleanly after mutation lock rejection
      await useOfflineQueueStore.getState().markItemStatus('rej-mut-2', 'FAILED', 'Test error', 'user-a');
      await useOfflineQueueStore.getState().removeQueuedExpense('rej-mut-2', 'user-a');
      expect(useOfflineQueueStore.getState().queue.map((q) => q.clientMutationId)).toEqual([
        'rej-mut-1',
      ]);

      // 2. Reject sync lock while mutation lock works -> MUST refuse unsafe concurrent flush & surface error
      const postedIds: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          if (url.endsWith('/auth/me')) {
            return jsonResponse({ success: true, data: { user: userA } });
          }
          if (url.endsWith('/trips/trip-1/expenses') && method === 'POST') {
            const body = JSON.parse(String(init?.body)) as { clientMutationId: string };
            postedIds.push(body.clientMutationId);
            return jsonResponse({ success: true, data: { expense: { id: 'exp-after-lock-recovery' } } }, 201);
          }
          throw new Error(`Unexpected fetch: ${method} ${url}`);
        })
      );

      installTestWebLocks();
      const workingRequest = navigator.locks.request.bind(navigator.locks);
      let failSyncLocks = true;
      Object.defineProperty(navigator, 'locks', {
        value: {
          request: (
            name: string,
            optsOrCb: LockOptions | LockGrantedCallback<unknown>,
            maybeCb?: LockGrantedCallback<unknown>
          ) => {
            if (failSyncLocks && name.includes(':sync:')) {
              return Promise.reject(new DOMException('Sync lock failed', 'SecurityError'));
            }
            return workingRequest(name, optsOrCb as LockOptions, maybeCb!);
          },
        },
        configurable: true,
      });

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

      // Go online while sync locks reject
      useOfflineQueueStore.getState().setOnlineStatus(true);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/exclusive cross-tab sync lock/i);
      });
      expect(postedIds).toEqual([]);
      expect(useOfflineQueueStore.getState().isSyncing).toBe(false);
      expect(useOfflineQueueStore.getState().queue).toHaveLength(1);
      expect(screen.getByRole('button', { name: /Sync Now/i })).not.toBeDisabled();

      // Explicit manual Sync Now while lock still rejects stays non-stuck & emits no unsafe POST
      fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));
      await new Promise((r) => setTimeout(r, 25));
      expect(postedIds).toEqual([]);
      expect(useOfflineQueueStore.getState().isSyncing).toBe(false);
      expect(screen.getByRole('button', { name: /Sync Now/i })).not.toBeDisabled();

      // Dismiss notice cleanly, then subsequent enqueue + flush recover seamlessly once Web Locks recovers
      fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
      expect(useOfflineQueueStore.getState().syncError).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent(/cross-tab lock failed/i);

      failSyncLocks = false;
      expect(
        await useOfflineQueueStore
          .getState()
          .enqueueExpense(makeQueuedEntry({ clientMutationId: 'rej-mut-3', userId: 'user-a' }))
      ).toBe(true);

      await waitFor(() => {
        expect(postedIds).toEqual(['rej-mut-1', 'rej-mut-3']);
      });
      await waitFor(() => {
        expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
        expect(useOfflineQueueStore.getState().crossTabCoordinationDegraded).toBe(false);
        expect(useOfflineQueueStore.getState().syncError).toBeNull();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });

      // Give microtasks/event loop a tick to confirm zero unhandled rejections surfaced
      await new Promise((r) => setTimeout(r, 25));
      expect(unhandledReasons).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      window.removeEventListener('unhandledrejection', onBrowserUnhandled);
      process.off('unhandledRejection', onNodeUnhandled);
    }
  });

  it('Phase 3.1.12 L-01 (mocked jsdom Web Locks): cold-booting or signing into Tab 2 during active Tab 1 sync preserves SYNCING, arms recovery watcher, respects account switches, and recovers on Tab 1 crash', async () => {
    installTestWebLocks();
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    const userB = makeUser({ id: 'user-b', name: 'Bob', email: 'bob@example.com' });

    const postedWithAuth: Array<{
      token: string | null;
      clientMutationId: string;
      title: string;
    }> = [];

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
          const body = JSON.parse(String(init?.body)) as {
            clientMutationId: string;
            title: string;
          };
          postedWithAuth.push({
            token: auth,
            clientMutationId: body.clientMutationId,
            title: body.title,
          });
          return jsonResponse({ success: true, data: { expense: { id: 'exp-cold-1' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    // 1. Tab 1 actively holds sync:user-a with mut-cold-boot-1 persisted as SYNCING
    const coldEntry = makeQueuedEntry({
      clientMutationId: 'mut-cold-boot-1',
      userId: 'user-a',
      syncStatus: 'SYNCING',
      lastError: 'Prior retry metadata',
      payload: {
        title: 'Nagarkot Hotel',
        category: 'ACCOMMODATION',
        amountPaisa: 85000,
        isEstimated: false,
        isPackage: false,
        splitMethod: 'EQUAL',
        paymentMethod: 'CASH',
        incurredAt: '2026-11-18T06:00:00.000Z',
        payments: [{ participantId: 'p-a', amountPaisa: 85000 }],
        clientMutationId: 'mut-cold-boot-1',
      },
    });
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-a'),
      JSON.stringify({ version: 1, userId: 'user-a', queue: [coldEntry] })
    );

    let releaseTab1Cold!: () => void;
    let tab1Acquired = false;
    void navigator.locks.request(
      'tripledger:offline-queue:sync:user-a',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          tab1Acquired = true;
          releaseTab1Cold = resolve;
        })
    );
    await waitFor(() => {
      expect(tab1Acquired).toBe(true);
    });

    // Cold-boot Tab 2 AFTER user-a is already authenticated (exercises initialQueue hydration)
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    const coldBootTab2 = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(coldBootTab2);
    coldBootTab2.getState().setOnlineStatus(true);

    // Must NOT convert SYNCING -> PENDING on cold boot while Web Locks are available
    expect(coldBootTab2.getState().queue[0]?.syncStatus).toBe('SYNCING');
    expect(
      (
        JSON.parse(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))!) as {
          queue: QueuedOfflineExpense[];
        }
      ).queue[0]?.syncStatus
    ).toBe('SYNCING');

    function ColdBootProbe() {
      useOfflineSync(coldBootTab2);
      return null;
    }

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ColdBootProbe />
      </QueryClientProvider>
    );

    // Give effects microtasks to arm watcher; while Tab 1 holds lock, zero POSTs and SYNCING intact
    await new Promise((r) => setTimeout(r, 25));
    expect(postedWithAuth).toEqual([]);
    expect(coldBootTab2.getState().queue[0]?.syncStatus).toBe('SYNCING');

    // Tab 1 terminates/releases lock without clearing entry -> Tab 2 recovers and submits ONCE
    releaseTab1Cold();
    await waitFor(() => {
      expect(postedWithAuth).toEqual([
        {
          token: 'Bearer tok-a',
          clientMutationId: 'mut-cold-boot-1',
          title: 'Nagarkot Hotel',
        },
      ]);
    });
    await waitFor(() => {
      expect(coldBootTab2.getState().queue).toHaveLength(0);
      expect(window.localStorage.getItem(getOfflineQueueStorageKey('user-a'))).toBeNull();
    });

    // 2. Tab 2 logs into user-a while Tab 1 holds sync:user-a with BOTH a PENDING and SYNCING item,
    //    then switches to user-b before Tab 1 releases lock, and later resumes as user-a cleanly
    cleanup();
    postedWithAuth.length = 0;
    const syncEntry = makeQueuedEntry({
      clientMutationId: 'mut-login-sync-1',
      userId: 'user-a',
      syncStatus: 'SYNCING',
    });
    const pendingEntry = makeQueuedEntry({
      clientMutationId: 'mut-login-pend-2',
      userId: 'user-a',
      syncStatus: 'PENDING',
    });
    window.localStorage.setItem(
      getOfflineQueueStorageKey('user-a'),
      JSON.stringify({ version: 1, userId: 'user-a', queue: [syncEntry, pendingEntry] })
    );

    let releaseTab1Dual!: () => void;
    tab1Acquired = false;
    void navigator.locks.request(
      'tripledger:offline-queue:sync:user-a',
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          tab1Acquired = true;
          releaseTab1Dual = resolve;
        })
    );
    await waitFor(() => {
      expect(tab1Acquired).toBe(true);
    });

    // Start Tab 2 signed out, render probe, then sign in as user-a -> syncAuthContext keeps SYNCING
    useAuthStore.getState().clearAuth();
    const loginTab2 = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(loginTab2);
    loginTab2.getState().setOnlineStatus(true);

    function LoginProbe() {
      useOfflineSync(loginTab2);
      return null;
    }

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LoginProbe />
      </QueryClientProvider>
    );

    useAuthStore.getState().setAuth(userA, 'tok-a1', 'ref-a1');
    expect(loginTab2.getState().queue.map((q) => [q.clientMutationId, q.syncStatus])).toEqual([
      ['mut-login-sync-1', 'SYNCING'],
      ['mut-login-pend-2', 'PENDING'],
    ]);

    // Switch to User B while waiting on Tab 1's sync:user-a lock
    await new Promise((r) => setTimeout(r, 20));
    useAuthStore.getState().setAuth(userB, 'tok-b', 'ref-b');
    releaseTab1Dual();
    await new Promise((r) => setTimeout(r, 30));

    // Must not submit User A items under User B
    expect(postedWithAuth).toEqual([]);
    expect(loginTab2.getState().activeUserId).toBe('user-b');
    expect(loginTab2.getState().queue).toHaveLength(0);

    // Re-login User A -> recovers orphaned SYNCING alongside PENDING and submits exact clientMutationIds once each
    useAuthStore.getState().setAuth(userA, 'tok-a2', 'ref-a2');
    await waitFor(() => {
      expect(postedWithAuth.map((p) => [p.token, p.clientMutationId])).toEqual([
        ['Bearer tok-a2', 'mut-login-sync-1'],
        ['Bearer tok-a2', 'mut-login-pend-2'],
      ]);
    });
    await waitFor(() => {
      expect(loginTab2.getState().queue).toHaveLength(0);
    });
  });

  it('Phase 3.1.12 L-02 (mocked jsdom Web Locks): rethrows post-grant callback exceptions from runWithUserQueueLock without executing work twice and keeps subsequent mutations usable', async () => {
    installTestWebLocks();
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');

    const store = createOfflineQueueStore({ bindWindowEvents: false });
    createdStores.push(store);
    store.getState().setOnlineStatus(false);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    let shouldThrowOnSet = true;
    const unsubscribe = store.subscribe(() => {
      if (shouldThrowOnSet) {
        shouldThrowOnSet = false;
        throw new Error('Simulated UI subscriber error inside locked mutation callback');
      }
    });

    try {
      await expect(
        store
          .getState()
          .enqueueExpense(makeQueuedEntry({ clientMutationId: 'post-grant-err-1', userId: 'user-a' }))
      ).rejects.toThrow('Simulated UI subscriber error inside locked mutation callback');

      // Callback ran only ONCE after lock grant (must NOT re-run in fallback catch block)
      const queueWritesAfterErr = setItemSpy.mock.calls.filter(
        ([key]) => key === getOfflineQueueStorageKey('user-a')
      );
      expect(queueWritesAfterErr).toHaveLength(1);
      expect(store.getState().crossTabCoordinationDegraded).toBe(false);

      // Subsequent operations in the same lock chain continue normally without poisoning
      expect(
        await store
          .getState()
          .enqueueExpense(makeQueuedEntry({ clientMutationId: 'post-grant-ok-2', userId: 'user-a' }))
      ).toBe(true);
      expect(store.getState().queue.map((q) => q.clientMutationId)).toEqual([
        'post-grant-err-1',
        'post-grant-ok-2',
      ]);
    } finally {
      unsubscribe();
      setItemSpy.mockRestore();
    }
  });

  it('QuickAddExpenseModal submits and queues expenses cleanly on non-secure HTTP LAN origins where crypto.randomUUID is undefined', async () => {
    const userA = makeUser({ id: 'user-a', name: 'Alice', email: 'alice@example.com' });
    useAuthStore.getState().setAuth(userA, 'tok-a', 'ref-a');
    useOfflineQueueStore.getState().setOnlineStatus(true);

    const postedBodies: Array<{ title: string; clientMutationId: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/trips/trip-lan-1/expenses') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { title: string; clientMutationId: string };
          postedBodies.push(body);
          return jsonResponse({ success: true, data: { expense: { id: 'exp-lan-1' } } }, 201);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    const originalCrypto = globalThis.crypto;
    const nonSecureCrypto = {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      randomUUID: undefined,
    };
    Object.defineProperty(globalThis, 'crypto', {
      value: nonSecureCrypto,
      configurable: true,
      writable: true,
    });

    const onClose = vi.fn();
    try {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <QuickAddExpenseModal
            tripId="trip-lan-1"
            tripName="LAN Mobile Trip"
            tripMode="FRIENDS"
            myParticipantId="p-a"
            participants={[
              {
                id: 'p-a',
                tripId: 'trip-lan-1',
                userId: 'user-a',
                familyId: null,
                name: 'Alice',
                role: 'ORGANIZER',
                memberType: 'ADULT',
                defaultWeight: 1,
                isActive: true,
              },
            ]}
            families={[]}
            onClose={onClose}
          />
        </QueryClientProvider>
      );

      fireEvent.change(
        screen.getByPlaceholderText('e.g., Highway Fuel, Lunch, Resort Package'),
        { target: { value: 'Mobile LAN Expense' } }
      );
      fireEvent.change(screen.getByPlaceholderText('e.g., 5000'), {
        target: { value: '1250' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save Expense' }));

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
      expect(postedBodies).toHaveLength(1);
      expect(postedBodies[0]!.title).toBe('Mobile LAN Expense');
      expect(postedBodies[0]!.clientMutationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });
});
