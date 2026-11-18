import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, MailWarning, ShieldCheck, XCircle } from 'lucide-react';
import type { ParticipantEntity, TripRole, TripSummaryEntity } from '@tripledger/shared';
import { apiRequest } from '../api/client.js';
import {
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
} from '../stores/authStore.js';

function extractInviteTokenInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const urlToken = parsed.searchParams.get('token');
    if (urlToken) return urlToken.trim();
  } catch {
    // Plain raw token input
  }
  return trimmed;
}

export function AcceptInvitePage(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTokenRef = useRef<string>(searchParams.get('token')?.trim() ?? '');
  const queryClient = useQueryClient();
  const isMountedRef = useRef(true);

  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const updateUser = useAuthStore((s) => s.updateUser);
  const prevGenerationRef = useRef(sessionGeneration);

  const [tokenInput, setTokenInput] = useState(initialTokenRef.current);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [claimedResult, setClaimedResult] = useState<{
    tripId: string;
    tripName: string;
    role: TripRole;
  } | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prevGenerationRef.current !== sessionGeneration) {
      prevGenerationRef.current = sessionGeneration;
      setClaimedResult(null);
      setErrorMessage(null);
      setResendNotice(null);
      setSubmitting(false);
      setResending(false);
    }
  }, [sessionGeneration]);

  useEffect(() => {
    if (searchParams.has('token')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('token');
      setSearchParams(nextParams, { replace: true });
    }
    if (typeof window !== 'undefined' && window.location.search.includes('token=')) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('token');
      window.history.replaceState(
        window.history.state,
        '',
        `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`
      );
    }
  }, [searchParams, setSearchParams]);

  const handleResendVerification = async () => {
    const startSession = captureAuthSessionSnapshot();
    if (!startSession.hasAccessToken || !startSession.userId) {
      return;
    }
    setResending(true);
    setResendNotice(null);
    setErrorMessage(null);
    try {
      const res = await apiRequest<{
        sent: boolean;
        alreadyVerified: boolean;
        emailVerified: boolean;
      }>('/auth/resend-verification', { method: 'POST' });

      if (!isSameAuthSession(startSession, { requireAuthenticated: true })) {
        return;
      }

      const currentUser = useAuthStore.getState().user;
      if (res.alreadyVerified && currentUser && currentUser.id === startSession.userId) {
        updateUser({ ...currentUser, emailVerified: true }, startSession.userId);
        if (isMountedRef.current) {
          setResendNotice(
            'Your email address is already verified. You can now accept this invitation.'
          );
        }
      } else if (isMountedRef.current) {
        setResendNotice('Verification email sent. Check your inbox and verify before accepting.');
      }
    } catch (err) {
      if (isMountedRef.current && isSameAuthSession(startSession, { requireAuthenticated: true })) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to send verification email.');
      }
    } finally {
      if (isMountedRef.current && isSameAuthSession(startSession)) {
        setResending(false);
      }
    }
  };

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = extractInviteTokenInput(tokenInput);
    if (!token) {
      setErrorMessage('Please enter your invitation token.');
      return;
    }

    const startSession = captureAuthSessionSnapshot();
    if (!startSession.hasAccessToken || !startSession.userId) {
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await apiRequest<{
        tripId: string;
        role: TripRole;
        participant: ParticipantEntity;
        trip: TripSummaryEntity;
      }>('/trips/invites/claim', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });

      if (!isSameAuthSession(startSession, { requireAuthenticated: true })) {
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', startSession.userId] }),
        queryClient.invalidateQueries({ queryKey: ['trips', startSession.userId] }),
        queryClient.invalidateQueries({ queryKey: ['trip', res.tripId, startSession.userId] }),
        queryClient.invalidateQueries({ queryKey: ['pending-invites', startSession.userId] }),
      ]);

      if (isMountedRef.current && isSameAuthSession(startSession, { requireAuthenticated: true })) {
        setClaimedResult({
          tripId: res.tripId,
          tripName: res.trip.name,
          role: res.role,
        });
      }
    } catch (err) {
      if (isMountedRef.current && isSameAuthSession(startSession, { requireAuthenticated: true })) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to redeem this invitation.'
        );
      }
    } finally {
      if (isMountedRef.current && isSameAuthSession(startSession)) {
        setSubmitting(false);
      }
    }
  };

  const isAuthenticated = Boolean(accessToken && user);
  const isVerified = Boolean(user?.emailVerified);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white text-slate-900 rounded-2xl shadow-2xl p-8 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white font-bold flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Accept Trip Role Invitation</h1>
            <p className="text-xs text-slate-500">
              Verified account matching is required for privileged trip roles
            </p>
          </div>
        </div>

        {claimedResult ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="text-sm text-emerald-900 space-y-1">
                <p className="font-semibold">Invitation accepted</p>
                <p className="text-xs text-emerald-800">
                  You now hold the <strong>{claimedResult.role}</strong> role on{' '}
                  <strong>{claimedResult.tripName}</strong>.
                </p>
              </div>
            </div>
            <Link
              to={`/trips/${claimedResult.tripId}`}
              className="block w-full text-center py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
            >
              Open Trip
            </Link>
          </div>
        ) : !isAuthenticated ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-xs text-amber-900 space-y-1.5">
              <p className="font-semibold">Sign in required</p>
              <p>
                Sign in or create an account using the exact invited email address, then verify
                your email before accepting this invitation.
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                to="/login"
                className="flex-1 text-center py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="flex-1 text-center py-2.5 px-4 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-semibold transition-colors"
              >
                Create Account
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700">
              Signed in as <strong className="text-slate-900">{user?.email}</strong>
            </div>

            {!isVerified && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <MailWarning className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-900 space-y-1">
                    <p className="font-semibold">Verify your email before accepting</p>
                    <p>
                      Privileged and email-bound invitations cannot be redeemed until{' '}
                      <strong>{user?.email}</strong> is verified.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={resending}
                    onClick={() => void handleResendVerification()}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {resending ? 'Sending...' : 'Resend Verification Email'}
                  </button>
                  <Link
                    to="/verify-email"
                    className="text-xs font-semibold text-amber-900 hover:underline"
                  >
                    Open Verify Page
                  </Link>
                </div>
              </div>
            )}

            {resendNotice && (
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900">
                {resendNotice}
              </div>
            )}

            {errorMessage && (
              <div className="rounded-xl bg-rose-50 border border-rose-200 p-3.5 flex items-start gap-2.5 text-xs text-rose-800">
                <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            <form onSubmit={handleClaim} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Invitation Token
                </label>
                <input
                  type="text"
                  required
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Paste invitation token"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-mono focus:border-blue-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || !isVerified}
                className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                <KeyRound className="w-4 h-4" />
                <span>{submitting ? 'Accepting...' : 'Accept Invitation'}</span>
              </button>
            </form>

            <div className="text-center">
              <Link to="/" className="text-xs font-semibold text-slate-600 hover:underline">
                Back to Dashboard
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
