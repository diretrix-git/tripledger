// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AcceptInvitePage } from '../pages/AcceptInvitePage.js';
import { DashboardPage } from '../pages/DashboardPage.js';
import { TripDetailPage } from '../pages/TripDetailPage.js';
import { useAuthStore, type AuthUser } from '../stores/authStore.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function LocationSearchProbe() {
  const loc = useLocation();
  return <div data-testid="invite-router-search">{loc.search}</div>;
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    name: 'Aarav Sharma',
    email: 'aarav@example.com',
    emailVerified: true,
    emailVerifiedAt: '2026-11-16T06:00:00.000Z',
    defaultCurrency: 'NPR',
    ...overrides,
  };
}

function makeBaseTripPayload(role: 'ORGANIZER' | 'PARTICIPANT', inviteCode?: string) {
  return {
    trip: {
      id: 'trip-1',
      name: 'Everest Base Trek',
      mode: 'FRIENDS',
      status: 'ACTIVE',
      currency: 'NPR',
      ...(inviteCode ? { inviteCode } : {}),
      shareToken: 'share-abc',
      shareEnabled: true,
      checklist: [],
    },
    myParticipant: {
      id: role === 'ORGANIZER' ? 'p-org' : 'p-mem',
      name: role === 'ORGANIZER' ? 'Aarav Sharma' : 'Bina Rai',
      role,
      familyId: null,
    },
    participants: [
      {
        id: 'p-org',
        tripId: 'trip-1',
        userId: 'user-1',
        familyId: null,
        name: 'Aarav Sharma',
        email: 'aarav@example.com',
        role: 'ORGANIZER',
        memberType: 'ADULT',
        defaultWeight: 1,
        isActive: true,
      },
      {
        id: 'p-mem',
        tripId: 'trip-1',
        userId: null,
        familyId: null,
        name: 'Bina Guest',
        email: 'bina@example.com',
        role: 'PARTICIPANT',
        memberType: 'ADULT',
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

describe('Phase 3 UI: Guest PARTICIPANT restriction, organizer-only invite management, and verified claim flow', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({ isOnline: true, isSyncing: false, queue: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('restricts guest creation strictly to PARTICIPANT, manages verified role invites, and exposes inviteCode only to organizers', async () => {
    const clipboardSpy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardSpy },
      configurable: true,
    });

    // 1. Organizer view
    useAuthStore.getState().setAuth(makeUser({ id: 'user-1' }), 'tok-org', 'ref-org');
    let invites = [
      {
        id: 'inv-old',
        tripId: 'trip-1',
        participantId: 'p-mem',
        intendedEmail: 'bina@example.com',
        grantedRole: 'ORGANIZER',
        requireVerifiedEmail: true,
        expiresAt: '2026-12-01T00:00:00.000Z',
        usedAt: null,
        revokedAt: null,
        createdAt: '2026-11-16T06:00:00.000Z',
      },
    ];

    const orgFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/trips/trip-1') && method === 'GET') {
        return jsonResponse({
          success: true,
          data: makeBaseTripPayload('ORGANIZER', 'TRIPCODE1'),
        });
      }
      if (url.endsWith('/trips/trip-1/invites') && method === 'GET') {
        return jsonResponse({ success: true, data: { invites } });
      }
      if (url.endsWith('/trips/trip-1/participants') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.role).toBe('PARTICIPANT');
        return jsonResponse(
          {
            success: true,
            data: {
              participant: {
                id: 'p-new',
                tripId: 'trip-1',
                userId: null,
                familyId: null,
                name: body.name,
                email: body.email,
                role: 'PARTICIPANT',
                memberType: 'ADULT',
                defaultWeight: 1,
                isActive: true,
              },
            },
          },
          201
        );
      }
      if (url.endsWith('/trips/trip-1/participants/p-mem/invites') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        expect(body.grantedRole).toBe('ORGANIZER');
        expect(body.intendedEmail).toBe('bina@example.com');
        invites = [
          {
            id: 'inv-new',
            tripId: 'trip-1',
            participantId: 'p-mem',
            intendedEmail: 'bina@example.com',
            grantedRole: 'ORGANIZER',
            requireVerifiedEmail: true,
            expiresAt: '2026-12-01T00:00:00.000Z',
            usedAt: null,
            revokedAt: null,
            createdAt: '2026-11-16T07:00:00.000Z',
          },
        ];
        return jsonResponse(
          {
            success: true,
            data: {
              invite: invites[0],
              rawToken: 'one-time-invite-secret-token-xyz',
              claimUrl: 'http://localhost:5173/invites/claim?token=one-time-invite-secret-token-xyz',
              emailDelivery: { sent: true, provider: 'MEMORY' },
            },
          },
          201
        );
      }
      if (url.endsWith('/trips/trip-1/invites/inv-new/revoke') && method === 'POST') {
        invites = [{ ...invites[0]!, revokedAt: '2026-11-16T08:00:00.000Z' as unknown as null }];
        return jsonResponse({
          success: true,
          data: { invite: invites[0], alreadyRevoked: false },
        });
      }
      throw new Error(`Unexpected organizer fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', orgFetch);

    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc1}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Code: TRIPCODE1/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Participants/i }));

    // Guest add form forces PARTICIPANT and submits strictly PARTICIPANT
    fireEvent.change(screen.getByPlaceholderText(/Participant Name \*/i), {
      target: { value: 'New Guest Member' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Participant/i }));
    await waitFor(() => {
      expect(orgFetch).toHaveBeenCalledWith(
        expect.stringContaining('/trips/trip-1/participants'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Click Invite / Promote on Bina Guest, submit ORGANIZER invite
    fireEvent.click(screen.getAllByRole('button', { name: /Invite \/ Promote/i })[1]!);
    fireEvent.click(screen.getByRole('button', { name: /Issue Role Invitation/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Issued ORGANIZER invitation for Bina Guest/i)
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Copy Invite Link/i })).toBeInTheDocument();

    // Revoke pending invitation updates list cleanly
    fireEvent.click(screen.getByRole('button', { name: /^Revoke$/i }));
    await waitFor(() => {
      expect(screen.getByText(/Revoked/i)).toBeInTheDocument();
    });

    // 2. Non-organizer participant view hides inviteCode & omits organizer invite UI/requests
    cleanup();
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-2', name: 'Bina Rai', email: 'bina@example.com' }), 'tok-mem', 'ref-mem');

    const memberFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/trips/trip-1')) {
        return jsonResponse({
          success: true,
          data: makeBaseTripPayload('PARTICIPANT'),
        });
      }
      throw new Error(`Unexpected member fetch: ${url}`);
    });
    vi.stubGlobal('fetch', memberFetch);

    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Everest Base Trek/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Code:/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Participants/i }));
    expect(screen.queryByText(/Role Invitations & Verified Promotions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add Guest Participant/i)).not.toBeInTheDocument();
    expect(memberFetch).toHaveBeenCalledTimes(1);
  });

  it('AcceptInvitePage strips URL token immediately, blocks unverified redemption, and redeems when verified', async () => {
    // 1. Unauthenticated visitor strips ?token= and prompts sign in
    window.history.replaceState(null, '', '/invites/claim?token=secret-invite-claim-token-123456');
    const qcUnauth = new QueryClient();
    render(
      <QueryClientProvider client={qcUnauth}>
        <MemoryRouter
          initialEntries={['/invites/claim?token=secret-invite-claim-token-123456']}
        >
          <Routes>
            <Route
              path="/invites/claim"
              element={
                <>
                  <AcceptInvitePage />
                  <LocationSearchProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Sign in required/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('invite-router-search').textContent).toBe('');
    });
    expect(window.location.search).toBe('');

    // 2. Authenticated UNVERIFIED user sees warning, disabled Accept button, and can verify & accept
    cleanup();
    useAuthStore.getState().setAuth(
      makeUser({ id: 'user-2', email: 'bina@example.com', emailVerified: false, emailVerifiedAt: null }),
      'tok-unverified',
      'ref-unverified'
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/resend-verification')) {
        return jsonResponse({
          success: true,
          data: { sent: true, alreadyVerified: false, emailVerified: false },
        });
      }
      if (url.endsWith('/trips/invites/claim')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          token: 'secret-invite-claim-token-123456',
        });
        return jsonResponse({
          success: true,
          data: {
            tripId: 'trip-1',
            role: 'ORGANIZER',
            participant: { id: 'p-mem', tripId: 'trip-1', userId: 'user-2', role: 'ORGANIZER' },
            trip: { id: 'trip-1', name: 'Everest Base Trek' },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    window.history.replaceState(null, '', '/invites/claim?token=secret-invite-claim-token-123456');
    const qcAuth = new QueryClient();
    render(
      <QueryClientProvider client={qcAuth}>
        <MemoryRouter
          initialEntries={['/invites/claim?token=secret-invite-claim-token-123456']}
        >
          <Routes>
            <Route path="/invites/claim" element={<AcceptInvitePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Verify your email before accepting/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept Invitation/i })).toBeDisabled();

    // User verifies email -> button unlocks and redeems token cleanly
    useAuthStore.getState().updateUser({
      ...useAuthStore.getState().user!,
      emailVerified: true,
      emailVerifiedAt: '2026-11-16T06:05:00.000Z',
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept Invitation/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /Accept Invitation/i }));
    await waitFor(() => {
      expect(screen.getByText(/Invitation accepted/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Open Trip/i })).toHaveAttribute(
      'href',
      '/trips/trip-1'
    );
  });

  it('DashboardPage displays Pending Role Invitations only for verified users without exposing raw tokens', async () => {
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-2', email: 'bina@example.com', emailVerified: true }), 'tok-bina', 'ref-bina');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
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
          return jsonResponse({
            success: true,
            data: {
              invites: [
                {
                  id: 'inv-pending-1',
                  tripId: 'trip-99',
                  tripName: 'Kanchenjunga Expedition',
                  tripMode: 'FRIENDS',
                  participantId: 'p-99',
                  participantName: 'Bina Guest',
                  grantedRole: 'ORGANIZER',
                  intendedEmail: 'bina@example.com',
                  requireVerifiedEmail: true,
                  expiresAt: '2026-12-01T00:00:00.000Z',
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected dashboard fetch: ${url}`);
      })
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <DashboardPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Pending Role Invitations \(1\)/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Kanchenjunga Expedition/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Redeem Invitation Token/i })).toHaveAttribute(
      'href',
      '/invites/claim'
    );
  });
});
