// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell.js';
import { AuthPage } from '../pages/AuthPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { VerifyEmailPage } from '../pages/VerifyEmailPage.js';
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
  return <div data-testid="router-search">{loc.search}</div>;
}

describe('M-05: Frontend email verification, cross-user isolation, history cleanup & session sync', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    useOfflineQueueStore.setState({ isOnline: true, isSyncing: false, queue: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('verifies matching signed-in user once under StrictMode, updates authStore, and strips token from history', async () => {
    const loggedInUser: AuthUser = {
      id: 'user-match-1',
      name: 'Alice Match',
      email: 'alice@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      defaultCurrency: 'NPR',
    };
    useAuthStore.getState().setAuth(loggedInUser, 'access-match', 'refresh-match');
    window.history.replaceState(null, '', '/verify-email?token=valid-token-1234567890');

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          verified: true,
          userId: 'user-match-1',
          emailVerified: true,
          emailVerifiedAt: '2026-11-16T06:00:00.000Z',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <React.StrictMode>
        <MemoryRouter initialEntries={['/verify-email?token=valid-token-1234567890']}>
          <Routes>
            <Route
              path="/verify-email"
              element={
                <>
                  <VerifyEmailPage />
                  <LocationSearchProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </React.StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText(/Your email address has been verified\./i)).toBeInTheDocument();
    });

    // StrictMode mounts twice; token is submitted only once
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
    expect(useAuthStore.getState().user?.emailVerifiedAt).toBe('2026-11-16T06:00:00.000Z');
    // Secret token removed from both Router location and browser URL/history
    expect(screen.getByTestId('router-search')).toHaveTextContent('');
    expect(window.location.search).toBe('');
  });

  it('never marks logged-in User A as verified when opening a verification link belonging to User B', async () => {
    const userA: AuthUser = {
      id: 'user-a',
      name: 'User A',
      email: 'usera@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      defaultCurrency: 'NPR',
    };
    useAuthStore.getState().setAuth(userA, 'access-a', 'refresh-a');

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          verified: true,
          userId: 'user-b',
          emailVerified: true,
          emailVerifiedAt: '2026-11-16T06:10:00.000Z',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/verify-email?token=userb-token-1234567890']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Signed-in session unchanged/i)).toBeInTheDocument();
    });

    // Signed-in User A stays strictly unverified in authStore
    expect(useAuthStore.getState().user?.id).toBe('user-a');
    expect(useAuthStore.getState().user?.emailVerified).toBe(false);
    expect(useAuthStore.getState().user?.emailVerifiedAt).toBeNull();
  });

  it('handles expired/invalid link with manual token form and inline resend recovery (including 429 cooldown)', async () => {
    const signedInUnverified: AuthUser = {
      id: 'user-recover',
      name: 'Recover User',
      email: 'recover@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      defaultCurrency: 'NPR',
    };
    useAuthStore.getState().setAuth(signedInUnverified, 'access-recover', 'refresh-recover');

    let callIndex = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/verify-email')) {
        callIndex += 1;
        if (callIndex === 1) {
          return jsonResponse(
            {
              success: false,
              error: {
                code: 'INVALID_OR_EXPIRED_VERIFICATION_TOKEN',
                message: 'Verification token is invalid or has expired.',
              },
            },
            400
          );
        }
        return jsonResponse({
          success: true,
          data: {
            verified: true,
            userId: 'user-recover',
            emailVerified: true,
            emailVerifiedAt: '2026-11-16T06:20:00.000Z',
          },
        });
      }
      if (url.endsWith('/auth/resend-verification')) {
        return jsonResponse(
          {
            success: false,
            error: {
              code: 'VERIFICATION_RESEND_COOLDOWN',
              message: 'Please wait 45 seconds before requesting another verification email.',
            },
          },
          429
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/verify-email?token=expired-token-1234567890']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Verification token is invalid or has expired\./i)).toBeInTheDocument();
    });

    // Inline Resend recovery button surfaces cooldown 429 cleanly
    const resendBtn = screen.getByRole('button', { name: /Resend Verification Email/i });
    fireEvent.click(resendBtn);
    await waitFor(() => {
      expect(screen.getByText(/Please wait 45 seconds/i)).toBeInTheDocument();
    });

    // Manual replacement token input remains accessible after expired link failure
    const tokenInput = screen.getByPlaceholderText(/Paste your email verification token/i);
    fireEvent.change(tokenInput, { target: { value: 'fresh-token-from-inbox-12345' } });
    fireEvent.click(screen.getByRole('button', { name: /^Verify Email$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Your email address has been verified\./i)).toBeInTheDocument();
    });
    expect(useAuthStore.getState().user?.emailVerified).toBe(true);
  });

  it('synchronizes /auth/me when AppShell mounts and clears stale unverified banner automatically', async () => {
    const staleUser: AuthUser = {
      id: 'user-stale-1',
      name: 'Stale Session User',
      email: 'stale@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      defaultCurrency: 'NPR',
    };
    useAuthStore.getState().setAuth(staleUser, 'valid-access-token', 'valid-refresh-token');

    let resolveMe!: (res: Response) => void;
    const mePromise = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) {
        return mePromise;
      }
      return jsonResponse({ success: true, data: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<div>Dashboard Content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Banner visible initially while stale store says emailVerified: false
    expect(screen.getByText(/Your email address is unverified\./i)).toBeInTheDocument();

    resolveMe(
      jsonResponse({
        success: true,
        data: {
          user: {
            ...staleUser,
            emailVerified: true,
            emailVerifiedAt: '2026-11-16T06:30:00.000Z',
          },
        },
      })
    );

    await waitFor(() => {
      expect(useAuthStore.getState().user?.emailVerified).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Your email address is unverified\./i)).not.toBeInTheDocument();
    });
  });

  it('handles SettingsPage resend verification & alreadyVerified sync, plus 201 registration with emailVerificationSent: false notice', async () => {
    const settingsUser: AuthUser = {
      id: 'user-settings-1',
      name: 'Settings User',
      email: 'settings@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      defaultCurrency: 'NPR',
    };
    useAuthStore.getState().setAuth(settingsUser, 'access-settings', 'refresh-settings');

    const outageUser: AuthUser = {
      id: 'user-outage-1',
      name: 'Outage User',
      email: 'outage@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      defaultCurrency: 'NPR',
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) {
        const currentUser = useAuthStore.getState().user ?? settingsUser;
        return jsonResponse({ success: true, data: { user: currentUser } });
      }
      if (url.endsWith('/auth/resend-verification')) {
        return jsonResponse({
          success: true,
          data: { sent: true, alreadyVerified: false, emailVerified: false },
        });
      }
      if (url.endsWith('/auth/register')) {
        return jsonResponse(
          {
            success: true,
            data: {
              user: outageUser,
              accessToken: 'access-outage-201',
              refreshToken: 'refresh-outage-201',
              emailVerificationSent: false,
            },
          },
          201
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Resend Verification/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Resend Verification/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/Verification email sent\. Check your inbox for the verification link\./i)
      ).toBeInTheDocument();
    });

    cleanup();
    useAuthStore.getState().clearAuth();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/register']}>
          <Routes>
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/" element={<AppShell />}>
              <Route index element={<div>Dashboard After Register</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByPlaceholderText(/Aarav Sharma/i), {
      target: { value: 'Outage User' },
    });
    fireEvent.change(screen.getByPlaceholderText(/you@example\.com/i), {
      target: { value: 'outage@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText(/At least 8 chars/i), {
      target: { value: 'Password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Account/i }));

    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBe('access-outage-201');
      expect(useAuthStore.getState().user?.emailVerified).toBe(false);
      expect(screen.getByText('Dashboard After Register')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Your account was created and you are signed in, but the verification email could not be sent right now\./i
        )
      ).toBeInTheDocument();
    });
  });
});
