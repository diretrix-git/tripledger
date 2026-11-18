// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

  it('scopes designated FAMILY_REP settlement actions, preserves organizer & direct-receiver flows, exposes Family mode toggle, and shows unassigned rep state cleanly', async () => {
    const buildFamilyTripPayload = (options: {
      tripStatus?: 'ACTIVE' | 'CLOSED';
      myRole: 'FAMILY_REP' | 'ORGANIZER' | 'PARTICIPANT';
      myParticipantId: string;
      myFamilyId: string | null;
      fam1RepId: string | null;
      fam2RepId?: string | null;
      includeExtendedSettlements?: boolean;
    }) => ({
      trip: {
        id: 'trip-1',
        name: 'Mustang Family Trek',
        mode: 'FAMILY',
        status: options.tripStatus ?? 'ACTIVE',
        currency: 'NPR',
        shareToken: 'share-fam',
        shareEnabled: true,
        checklist: [],
      },
      myParticipant: {
        id: options.myParticipantId,
        name:
          options.myParticipantId === 'p-org'
            ? 'Aarav Organizer'
            : options.myParticipantId === 'p-rep1'
              ? 'Rep Alpha'
              : 'Fam1 Member',
        role: options.myRole,
        familyId: options.myFamilyId,
      },
      participants: [
        {
          id: 'p-org',
          tripId: 'trip-1',
          userId: 'user-org',
          familyId: null,
          name: 'Aarav Organizer',
          email: 'org@example.com',
          role: 'ORGANIZER',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
        {
          id: 'p-rep1',
          tripId: 'trip-1',
          userId: 'user-rep1',
          familyId: 'fam-1',
          name: 'Rep Alpha',
          email: 'rep1@example.com',
          role: options.myParticipantId === 'p-rep1' ? options.myRole : 'FAMILY_REP',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
        {
          id: 'p-mem1',
          tripId: 'trip-1',
          userId: 'user-mem1',
          familyId: 'fam-1',
          name: 'Fam1 Member',
          email: 'mem1@example.com',
          role: 'PARTICIPANT',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
        {
          id: 'p-inact',
          tripId: 'trip-1',
          userId: null,
          familyId: 'fam-1',
          name: 'Inactive Alpha Member',
          email: null,
          role: 'PARTICIPANT',
          memberType: 'CHILD',
          defaultWeight: 0.5,
          isActive: false,
        },
        {
          id: 'p-rep2',
          tripId: 'trip-1',
          userId: 'user-rep2',
          familyId: 'fam-2',
          name: 'Rep Beta',
          email: 'rep2@example.com',
          role: 'FAMILY_REP',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
      ],
      families: [
        {
          id: 'fam-1',
          tripId: 'trip-1',
          name: 'Alpha Family',
          representativeId: options.fam1RepId,
          defaultWeight: 1,
        },
        {
          id: 'fam-2',
          tripId: 'trip-1',
          name: 'Beta Family',
          representativeId: options.fam2RepId ?? 'p-rep2',
          defaultWeight: 1,
        },
      ],
      expenses: [],
      settlements: [
        {
          id: 's-eligible',
          tripId: 'trip-1',
          settlementMode: 'FAMILY',
          fromParticipantId: 'p-org',
          toParticipantId: 'p-mem1',
          fromFamilyId: null,
          toFamilyId: 'fam-1',
          amountPaisa: 50000,
          status: 'REPORTED',
          note: 'Hotel split',
          createdAt: '2026-11-16T07:00:00.000Z',
          updatedAt: '2026-11-16T07:00:00.000Z',
        },
        ...(options.includeExtendedSettlements
          ? [
              {
                id: 's-indiv',
                tripId: 'trip-1',
                settlementMode: 'INDIVIDUAL',
                fromParticipantId: 'p-org',
                toParticipantId: 'p-mem1',
                fromFamilyId: null,
                toFamilyId: 'fam-1',
                amountPaisa: 12000,
                status: 'REPORTED',
                note: 'Individual coffee',
                createdAt: '2026-11-16T07:05:00.000Z',
                updatedAt: '2026-11-16T07:05:00.000Z',
              },
              {
                id: 's-other-fam',
                tripId: 'trip-1',
                settlementMode: 'FAMILY',
                fromParticipantId: 'p-org',
                toParticipantId: 'p-rep2',
                fromFamilyId: null,
                toFamilyId: 'fam-2',
                amountPaisa: 25000,
                status: 'REPORTED',
                note: 'Other family',
                createdAt: '2026-11-16T07:10:00.000Z',
                updatedAt: '2026-11-16T07:10:00.000Z',
              },
              {
                id: 's-confirmed',
                tripId: 'trip-1',
                settlementMode: 'FAMILY',
                fromParticipantId: 'p-org',
                toParticipantId: 'p-mem1',
                fromFamilyId: null,
                toFamilyId: 'fam-1',
                amountPaisa: 15000,
                status: 'CONFIRMED',
                note: 'Already confirmed',
                createdAt: '2026-11-16T07:15:00.000Z',
                updatedAt: '2026-11-16T07:15:00.000Z',
              },
              {
                id: 's-inactive-recv',
                tripId: 'trip-1',
                settlementMode: 'FAMILY',
                fromParticipantId: 'p-org',
                toParticipantId: 'p-inact',
                fromFamilyId: null,
                toFamilyId: 'fam-1',
                amountPaisa: 10000,
                status: 'REPORTED',
                note: 'Inactive receiver',
                createdAt: '2026-11-16T07:20:00.000Z',
                updatedAt: '2026-11-16T07:20:00.000Z',
              },
            ]
          : []),
      ],
      ledger: {
        totalApprovedExpensePaisa: 0,
        totalPackageExpensePaisa: 0,
        totalAdditionalExpensePaisa: 0,
        totalPendingExpensePaisa: 0,
        totalConfirmedSettlementPaisa: 0,
        individualBalances: [],
        familyBalances: [
          {
            familyId: 'fam-1',
            familyName: 'Alpha Family',
            representativeId: options.fam1RepId,
            representativeName: 'Fallback Adult Should Not Leak',
            memberCount: 2,
            totalWeight: 1.5,
            totalPaidPaisa: 0,
            totalSharePaisa: 0,
            settledPaidPaisa: 0,
            settledReceivedPaisa: 0,
            outstandingBalancePaisa: 0,
            paidPaisa: 0,
            sharePaisa: 0,
            settlementSentPaisa: 0,
            settlementReceivedPaisa: 0,
            netBalancePaisa: 0,
          },
        ],
        ungroupedParticipantBalances: [],
      },
      individualSettlementSuggestions: [],
      familySettlementSuggestions: [],
    });

    // 1. Designated active FAMILY_REP: sees controls ONLY for REPORTED FAMILY settlement in own family with active receiver
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-rep1', name: 'Rep Alpha', email: 'rep1@example.com' }), 'tok-rep1', 'ref-rep1');

    let familyTripPayload = buildFamilyTripPayload({
      myRole: 'FAMILY_REP',
      myParticipantId: 'p-rep1',
      myFamilyId: 'fam-1',
      fam1RepId: 'p-rep1',
      includeExtendedSettlements: true,
    });

    const repFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/trips/trip-1') && method === 'GET') {
        return jsonResponse({ success: true, data: familyTripPayload });
      }
      if (url.endsWith('/trips/trip-1/settlements/s-eligible/status') && method === 'PATCH') {
        familyTripPayload = {
          ...familyTripPayload,
          settlements: familyTripPayload.settlements.map((s) =>
            s.id === 's-eligible' ? { ...s, status: 'CONFIRMED' } : s
          ),
        };
        return jsonResponse({
          success: true,
          data: { settlement: { ...familyTripPayload.settlements[0]!, status: 'CONFIRMED' } },
        });
      }
      throw new Error(`Unexpected rep fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', repFetch);

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
      expect(screen.getByText(/Mustang Family Trek/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm settlement s-eligible' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Reject settlement s-eligible' })).toBeInTheDocument();

    for (const disallowedId of ['s-indiv', 's-other-fam', 's-confirmed', 's-inactive-recv']) {
      expect(screen.queryByRole('button', { name: `Confirm settlement ${disallowedId}` })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: `Reject settlement ${disallowedId}` })).not.toBeInTheDocument();
    }

    // Settlement Mode toggle exposes Individual and Family controls on FAMILY trips
    const familyModeBtn = screen.getByRole('button', { name: /^Family$/i });
    const indivModeBtn = screen.getByRole('button', { name: /^Individual$/i });
    expect(familyModeBtn).toBeInTheDocument();
    expect(indivModeBtn).toBeInTheDocument();
    expect(indivModeBtn.className).toContain('bg-white');
    expect(familyModeBtn.className).not.toContain('bg-white');
    fireEvent.click(familyModeBtn);
    expect(familyModeBtn.className).toContain('bg-white');
    expect(indivModeBtn.className).not.toContain('bg-white');

    // Confirm sends PATCH /settlements/:id/status { status: 'CONFIRMED' }
    fireEvent.click(screen.getByRole('button', { name: 'Confirm settlement s-eligible' }));
    await waitFor(() => {
      expect(repFetch).toHaveBeenCalledWith(
        expect.stringContaining('/trips/trip-1/settlements/s-eligible/status'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'CONFIRMED' }),
        })
      );
    });

    // 2. Non-designated FAMILY_REP (fam1RepId points to p-mem1) sees zero confirm/reject buttons
    cleanup();
    const nonDesignatedPayload = buildFamilyTripPayload({
      myRole: 'FAMILY_REP',
      myParticipantId: 'p-rep1',
      myFamilyId: 'fam-1',
      fam1RepId: 'p-mem1',
      includeExtendedSettlements: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/trips/trip-1')) {
          return jsonResponse({ success: true, data: nonDesignatedPayload });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );
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
      expect(screen.getByText(/Mustang Family Trek/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(screen.getByText('REPORTED')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Confirm settlement/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject settlement/i })).not.toBeInTheDocument();

    // 3. Closed trip hides confirm/reject buttons even for designated FAMILY_REP
    cleanup();
    const closedPayload = buildFamilyTripPayload({
      tripStatus: 'CLOSED',
      myRole: 'FAMILY_REP',
      myParticipantId: 'p-rep1',
      myFamilyId: 'fam-1',
      fam1RepId: 'p-rep1',
      includeExtendedSettlements: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/trips/trip-1')) {
          return jsonResponse({ success: true, data: closedPayload });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );
    const qc3 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc3}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Mustang Family Trek/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(screen.getByText('REPORTED')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Confirm settlement/i })).not.toBeInTheDocument();

    // 4. Direct receiver (PARTICIPANT where toParticipantId === myParticipant.id) still sees confirm/reject on REPORTED open-trip settlement
    cleanup();
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-mem1', name: 'Fam1 Member', email: 'mem1@example.com' }), 'tok-mem1', 'ref-mem1');
    const receiverPayload = buildFamilyTripPayload({
      myRole: 'PARTICIPANT',
      myParticipantId: 'p-mem1',
      myFamilyId: 'fam-1',
      fam1RepId: null,
      includeExtendedSettlements: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/trips/trip-1')) {
          return jsonResponse({ success: true, data: receiverPayload });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );
    const qc4 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc4}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Mustang Family Trek/i)).toBeInTheDocument();
    });
    // Also verify unassigned representative display on Overview & Participants tabs
    expect(screen.getByText(/Rep: Unassigned/i)).toBeInTheDocument();
    expect(screen.queryByText(/Fallback Adult Should Not Leak/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Auto-assigned primary adult/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Families .* Members/i }));
    await waitFor(() => {
      expect(screen.getByText(/Representative:\s*Not designated/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Auto-assigned primary adult/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm settlement s-eligible' })).toBeInTheDocument();
    });

    // 5. Organizer still sees confirm/reject on REPORTED open-trip settlement
    cleanup();
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-org', name: 'Aarav Organizer', email: 'org@example.com' }), 'tok-org', 'ref-org');
    const orgPayload = buildFamilyTripPayload({
      myRole: 'ORGANIZER',
      myParticipantId: 'p-org',
      myFamilyId: null,
      fam1RepId: 'p-rep1',
      includeExtendedSettlements: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/trips/trip-1')) {
          return jsonResponse({ success: true, data: orgPayload });
        }
        if (String(input).includes('/invites')) {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );
    const qc5 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc5}>
        <MemoryRouter initialEntries={['/trips/trip-1']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Mustang Family Trek/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm settlement s-eligible' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Reject settlement s-eligible' })).toBeInTheDocument();
  });

  it('requires verified email on FAMILY_REP UI controls, resets settlement state across trips, disables settlement creation on CLOSED trips, and excludes inactive participants from dropdowns', async () => {
    // 1. Unverified FAMILY_REP sees no confirm/reject buttons on REPORTED FAMILY settlement
    useAuthStore.getState().setAuth(
      makeUser({
        id: 'user-rep1',
        name: 'Rep Alpha',
        email: 'rep1@example.com',
        emailVerified: false,
        emailVerifiedAt: null,
      }),
      'tok-unverified-rep',
      'ref-unverified-rep'
    );

    const familyPayloadForRep = {
      trip: {
        id: 'trip-fam',
        name: 'Family Trip F03',
        mode: 'FAMILY',
        status: 'ACTIVE',
        currency: 'NPR',
        shareToken: 'share-fam',
        shareEnabled: true,
        checklist: [],
      },
      myParticipant: {
        id: 'p-rep1',
        name: 'Rep Alpha',
        role: 'FAMILY_REP',
        familyId: 'fam-1',
      },
      participants: [
        {
          id: 'p-org',
          tripId: 'trip-fam',
          userId: 'user-org',
          familyId: null,
          name: 'Aarav Organizer',
          email: 'org@example.com',
          role: 'ORGANIZER',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
        {
          id: 'p-rep1',
          tripId: 'trip-fam',
          userId: 'user-rep1',
          familyId: 'fam-1',
          name: 'Rep Alpha',
          email: 'rep1@example.com',
          role: 'FAMILY_REP',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
        {
          id: 'p-mem1',
          tripId: 'trip-fam',
          userId: 'user-mem1',
          familyId: 'fam-1',
          name: 'Fam1 Member',
          email: 'mem1@example.com',
          role: 'PARTICIPANT',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: true,
        },
      ],
      families: [
        {
          id: 'fam-1',
          tripId: 'trip-fam',
          name: 'Alpha Family',
          representativeId: 'p-rep1',
          defaultWeight: 1,
        },
      ],
      expenses: [],
      settlements: [
        {
          id: 's-rep-unverified',
          tripId: 'trip-fam',
          settlementMode: 'FAMILY',
          fromParticipantId: 'p-org',
          toParticipantId: 'p-mem1',
          fromFamilyId: null,
          toFamilyId: 'fam-1',
          amountPaisa: 40000,
          status: 'REPORTED',
          note: 'Needs verified rep',
          createdAt: '2026-11-16T07:00:00.000Z',
          updatedAt: '2026-11-16T07:00:00.000Z',
        },
      ],
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

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/trips/trip-fam')) {
          return jsonResponse({ success: true, data: familyPayloadForRep });
        }
        throw new Error(`Unexpected fetch: ${String(input)}`);
      })
    );

    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc1}>
        <MemoryRouter initialEntries={['/trips/trip-fam']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Family Trip F03/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(screen.getByText('REPORTED')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Confirm settlement/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject settlement/i })).not.toBeInTheDocument();

    // 2. Switching from FAMILY trip to FRIENDS trip resets settlementViewMode & form fields and forces INDIVIDUAL on submit,
    //    and inactive participants are omitted from Sender/Receiver and Family Representative dropdowns.
    cleanup();
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-org', name: 'Aarav Organizer', email: 'org@example.com' }), 'tok-org', 'ref-org');

    const famNavPayload = {
      ...makeBaseTripPayload('ORGANIZER'),
      trip: {
        ...makeBaseTripPayload('ORGANIZER').trip,
        id: 'trip-fam-nav',
        name: 'Nav Family Trip',
        mode: 'FAMILY',
      },
      participants: [
        ...makeBaseTripPayload('ORGANIZER').participants,
        {
          id: 'p-inactive',
          tripId: 'trip-fam-nav',
          userId: null,
          familyId: null,
          name: 'Inactive Guest Hidden',
          email: null,
          role: 'PARTICIPANT',
          memberType: 'ADULT',
          defaultWeight: 1,
          isActive: false,
        },
      ],
    };
    const friendsNavPayload = {
      ...makeBaseTripPayload('ORGANIZER'),
      trip: {
        ...makeBaseTripPayload('ORGANIZER').trip,
        id: 'trip-friends-nav',
        name: 'Nav Friends Trip',
        mode: 'FRIENDS',
      },
    };

    const recordedBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/trips/trip-fam-nav') && method === 'GET') {
          return jsonResponse({ success: true, data: famNavPayload });
        }
        if (url.endsWith('/trips/trip-fam-nav/invites') && method === 'GET') {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        if (url.endsWith('/trips/trip-friends-nav') && method === 'GET') {
          return jsonResponse({ success: true, data: friendsNavPayload });
        }
        if (url.endsWith('/trips/trip-friends-nav/invites') && method === 'GET') {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        if (url.endsWith('/trips/trip-friends-nav/settlements') && method === 'POST') {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          recordedBodies.push({ url, body: parsed });
          return jsonResponse({ success: true, data: { settlement: { id: 's-new' } } }, 201);
        }
        throw new Error(`Unexpected nav fetch: ${method} ${url}`);
      })
    );

    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc2}>
        <MemoryRouter initialEntries={['/trips/trip-fam-nav']}>
          <Link to="/trips/trip-friends-nav">Switch to Friends Trip</Link>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Nav Family Trip/i)).toBeInTheDocument();
    });

    // Check Participants -> Create Family Group rep select omits inactive participant
    fireEvent.click(screen.getByRole('button', { name: /Families .* Members/i }));
    const repSelect = screen.getByDisplayValue('-- Select Representative (Optional) --');
    expect(within(repSelect).queryByText('Inactive Guest Hidden')).not.toBeInTheDocument();
    expect(within(repSelect).getByText('Aarav Sharma')).toBeInTheDocument();

    // Switch to Settlements on FAMILY trip, pick Family mode, check Sender/Receiver omit inactive participant, fill stale amount
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    const famModeButton = screen.getByRole('button', { name: /^Family$/i });
    fireEvent.click(famModeButton);
    expect(famModeButton.className).toContain('bg-white');

    const senderSelect = screen.getByDisplayValue('Select Sender');
    const receiverSelect = screen.getByDisplayValue('Select Receiver');
    expect(within(senderSelect).queryByText('Inactive Guest Hidden')).not.toBeInTheDocument();
    expect(within(receiverSelect).queryByText('Inactive Guest Hidden')).not.toBeInTheDocument();

    fireEvent.change(senderSelect, { target: { value: 'p-org' } });
    fireEvent.change(receiverSelect, { target: { value: 'p-mem' } });
    fireEvent.change(screen.getByPlaceholderText(/1500/i), { target: { value: '999' } });

    // Navigate to FRIENDS trip: resets tab to OVERVIEW, clears inputs, forces INDIVIDUAL submission
    fireEvent.click(screen.getByRole('link', { name: 'Switch to Friends Trip' }));
    await waitFor(() => {
      expect(screen.getByText(/Nav Friends Trip/i)).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/1500/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    const friendSender = screen.getByDisplayValue('Select Sender');
    const friendReceiver = screen.getByDisplayValue('Select Receiver');
    const friendAmountInput = screen.getByPlaceholderText(/1500/i) as HTMLInputElement;
    expect(friendAmountInput.value).toBe('');

    fireEvent.change(friendSender, { target: { value: 'p-mem' } });
    fireEvent.change(friendReceiver, { target: { value: 'p-org' } });
    fireEvent.change(friendAmountInput, { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /Record & Confirm Settlement/i }));

    await waitFor(() => {
      expect(recordedBodies).toHaveLength(1);
    });
    expect(recordedBodies[0]!.body.settlementMode).toBe('INDIVIDUAL');

    // 3. CLOSED trip hides settlement suggestion Settle button and Settlement creation form
    cleanup();
    const closedOrganizerPayload = {
      ...makeBaseTripPayload('ORGANIZER'),
      trip: {
        ...makeBaseTripPayload('ORGANIZER').trip,
        id: 'trip-closed',
        name: 'Closed Trip F03',
        status: 'CLOSED',
      },
      individualSettlementSuggestions: [
        {
          mode: 'INDIVIDUAL',
          fromParticipantId: 'p-mem',
          fromParticipantName: 'Bina Guest',
          toParticipantId: 'p-org',
          toParticipantName: 'Aarav Sharma',
          amountPaisa: 10000,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/trips/trip-closed')) {
          return jsonResponse({ success: true, data: closedOrganizerPayload });
        }
        if (url.endsWith('/trips/trip-closed/invites')) {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        throw new Error(`Unexpected closed fetch: ${url}`);
      })
    );

    const qc3 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc3}>
        <MemoryRouter initialEntries={['/trips/trip-closed']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Closed Trip F03/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^Settle$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/Trip is closed\. Recording new settlements is disabled\./i)
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /Record & Confirm Settlement/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Select Sender')).not.toBeInTheDocument();
  });

  it('guards in-flight UI mutations against trip switches and session changes, and surfaces clear revocation messaging on 503 EMAIL_DELIVERY_FAILED', async () => {
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-1', name: 'Aarav Sharma', email: 'aarav@example.com' }), 'tok-org', 'ref-org');

    const payloadA = {
      ...makeBaseTripPayload('ORGANIZER'),
      trip: { ...makeBaseTripPayload('ORGANIZER').trip, id: 'trip-a', name: 'Trip Alpha' },
    };
    const payloadB = {
      ...makeBaseTripPayload('ORGANIZER'),
      trip: { ...makeBaseTripPayload('ORGANIZER').trip, id: 'trip-b', name: 'Trip Beta' },
    };

    let resolveInviteA!: (res: Response) => void;
    let resolveSettleA!: (res: Response) => void;
    let rejectSettleASession!: (err: Error) => void;
    let settleCallCount = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';

        if (url.endsWith('/trips/trip-a') && method === 'GET') {
          return jsonResponse({ success: true, data: payloadA });
        }
        if (url.endsWith('/trips/trip-b') && method === 'GET') {
          return jsonResponse({ success: true, data: payloadB });
        }
        if (url.endsWith('/trips/trip-a/invites') && method === 'GET') {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        if (url.endsWith('/trips/trip-b/invites') && method === 'GET') {
          return jsonResponse({ success: true, data: { invites: [] } });
        }
        if (url.endsWith('/trips/trip-a/participants/p-mem/invites') && method === 'POST') {
          return new Promise<Response>((resolve) => {
            resolveInviteA = resolve;
          });
        }
        if (url.endsWith('/trips/trip-a/settlements') && method === 'POST') {
          settleCallCount += 1;
          if (settleCallCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveSettleA = resolve;
            });
          }
          return new Promise<Response>((_resolve, reject) => {
            rejectSettleASession = reject;
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      })
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/trips/trip-a']}>
          <Link to="/trips/trip-b">Go Trip B</Link>
          <Link to="/trips/trip-a">Go Trip A</Link>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Trip Alpha/i)).toBeInTheDocument();
    });

    // 1. Trigger invite issuance on trip-a, navigate to trip-b before response resolves
    fireEvent.click(screen.getByRole('button', { name: /Participants/i }));
    fireEvent.change(screen.getByLabelText('Target Participant'), { target: { value: 'p-mem' } });
    fireEvent.change(screen.getByPlaceholderText(/Verified Email Required/i), {
      target: { value: 'bina@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Issue Role Invitation/i }));

    fireEvent.click(screen.getByRole('link', { name: 'Go Trip B' }));
    await waitFor(() => {
      expect(screen.getByText(/Trip Beta/i)).toBeInTheDocument();
    });

    // Open Participants tab on trip-b and ensure issuing button is reset and not disabled
    fireEvent.click(screen.getByRole('button', { name: /Participants/i }));
    expect(screen.getByRole('button', { name: /Issue Role Invitation/i })).not.toBeDisabled();

    // Late invite response from trip-a arrives: MUST NOT render secret/claimUrl on trip-b
    resolveInviteA(
      jsonResponse(
        {
          success: true,
          data: {
            invite: {
              id: 'inv-a-late',
              tripId: 'trip-a',
              participantId: 'p-mem',
              intendedEmail: 'bina@example.com',
              grantedRole: 'ORGANIZER',
              requireVerifiedEmail: true,
              expiresAt: '2026-12-01T00:00:00.000Z',
              usedAt: null,
              revokedAt: null,
              createdAt: '2026-11-18T00:00:00.000Z',
            },
            rawToken: 'LEAK-SECRET-TOKEN-A',
            claimUrl: 'http://localhost:5173/invites/claim?token=LEAK-SECRET-TOKEN-A',
            emailDelivery: { sent: true, provider: 'MEMORY' },
          },
        },
        201
      )
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Issued ORGANIZER invitation/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Invite Link/i })).not.toBeInTheDocument();

    // 2. Submit settlement on trip-a, switch to trip-b and type new values before trip-a resolves
    fireEvent.click(screen.getByRole('link', { name: 'Go Trip A' }));
    await waitFor(() => {
      expect(screen.getByText(/Trip Alpha/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    fireEvent.change(screen.getByDisplayValue('Select Sender'), { target: { value: 'p-mem' } });
    fireEvent.change(screen.getByDisplayValue('Select Receiver'), { target: { value: 'p-org' } });
    fireEvent.change(screen.getByPlaceholderText(/1500/i), { target: { value: '500' } });
    fireEvent.change(screen.getByPlaceholderText(/eSewa TXN/i), { target: { value: 'Note A' } });
    fireEvent.click(screen.getByRole('button', { name: /Record & Confirm Settlement/i }));

    fireEvent.click(screen.getByRole('link', { name: 'Go Trip B' }));
    await waitFor(() => {
      expect(screen.getByText(/Trip Beta/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    const tripBAmount = screen.getByPlaceholderText(/1500/i) as HTMLInputElement;
    const tripBNote = screen.getByPlaceholderText(/eSewa TXN/i) as HTMLInputElement;
    fireEvent.change(tripBAmount, { target: { value: '750' } });
    fireEvent.change(tripBNote, { target: { value: 'Trip B Draft' } });

    resolveSettleA(jsonResponse({ success: true, data: { settlement: { id: 's-late-a' } } }, 201));
    await new Promise((r) => setTimeout(r, 20));
    expect(tripBAmount.value).toBe('750');
    expect(tripBNote.value).toBe('Trip B Draft');

    // 3. Submit settlement on trip-a, switch user/logout while request is in flight -> error must not mutate UI or invalidate new session
    fireEvent.click(screen.getByRole('link', { name: 'Go Trip A' }));
    await waitFor(() => {
      expect(screen.getByText(/Trip Alpha/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Settlements \(/i }));
    fireEvent.change(screen.getByDisplayValue('Select Sender'), { target: { value: 'p-mem' } });
    fireEvent.change(screen.getByDisplayValue('Select Receiver'), { target: { value: 'p-org' } });
    fireEvent.change(screen.getByPlaceholderText(/1500/i), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: /Record & Confirm Settlement/i }));

    invalidateSpy.mockClear();
    useAuthStore.getState().setAuth(
      makeUser({ id: 'user-other', name: 'Other User', email: 'other@example.com' }),
      'tok-other',
      'ref-other'
    );
    rejectSettleASession(new Error('Stale settlement failure after account switch'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Stale settlement failure after account switch/i)).not.toBeInTheDocument();
    expect(invalidateSpy).not.toHaveBeenCalled();

    // 4. L-02 UI behavior: 503 EMAIL_DELIVERY_FAILED clearly explains prior + new invite revocation & refreshes invite history
    cleanup();
    useAuthStore
      .getState()
      .setAuth(makeUser({ id: 'user-1', name: 'Aarav Sharma', email: 'aarav@example.com' }), 'tok-org', 'ref-org');
    let emailFailInvites = [
      {
        id: 'inv-prior',
        tripId: 'trip-mail-fail',
        participantId: 'p-mem',
        intendedEmail: 'bina@example.com',
        grantedRole: 'PARTICIPANT',
        requireVerifiedEmail: true,
        expiresAt: '2026-12-01T00:00:00.000Z',
        usedAt: null,
        revokedAt: null,
        createdAt: '2026-11-18T00:00:00.000Z',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/trips/trip-mail-fail') && method === 'GET') {
          return jsonResponse({
            success: true,
            data: {
              ...makeBaseTripPayload('ORGANIZER'),
              trip: { ...makeBaseTripPayload('ORGANIZER').trip, id: 'trip-mail-fail', name: 'Mail Outage Trip' },
            },
          });
        }
        if (url.endsWith('/trips/trip-mail-fail/invites') && method === 'GET') {
          return jsonResponse({ success: true, data: { invites: emailFailInvites } });
        }
        if (url.endsWith('/trips/trip-mail-fail/participants/p-mem/invites') && method === 'POST') {
          emailFailInvites = [
            { ...emailFailInvites[0]!, revokedAt: '2026-11-18T01:00:00.000Z' as unknown as null },
          ];
          return jsonResponse(
            {
              success: false,
              error: {
                code: 'EMAIL_DELIVERY_FAILED',
                message: 'Unable to deliver invitation email at this time. Please try again later.',
              },
            },
            503
          );
        }
        throw new Error(`Unexpected mail-fail fetch: ${method} ${url}`);
      })
    );
    const qcMail = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qcMail}>
        <MemoryRouter initialEntries={['/trips/trip-mail-fail']}>
          <Routes>
            <Route path="/trips/:tripId" element={<TripDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(/Mail Outage Trip/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Participants/i }));
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('Target Participant'), { target: { value: 'p-mem' } });
    fireEvent.change(screen.getByPlaceholderText(/Verified Email Required/i), {
      target: { value: 'bina@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Issue Role Invitation/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/prior pending invitation for this participant are now revoked/i)
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText('Pending')).not.toBeInTheDocument();
      expect(screen.getByText('Revoked')).toBeInTheDocument();
    });
  });
});
