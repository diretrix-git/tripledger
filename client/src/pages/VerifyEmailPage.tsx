import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import {
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
} from '../stores/authStore.js';

export function VerifyEmailPage(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTokenRef = useRef(searchParams.get('token')?.trim() ?? '');
  const initialToken = initialTokenRef.current;
  const user = useAuthStore((s) => s.user);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const updateUser = useAuthStore((s) => s.updateUser);
  const isMountedRef = useRef(true);
  const prevGenerationRef = useRef(sessionGeneration);

  const [manualToken, setManualToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'verified' | 'error'>(
    initialToken ? 'submitting' : 'idle'
  );
  const [message, setMessage] = useState<string | null>(null);
  const [sessionMismatchNotice, setSessionMismatchNotice] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const autoSubmittedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prevGenerationRef.current !== sessionGeneration) {
      prevGenerationRef.current = sessionGeneration;
      setMessage(null);
      setSessionMismatchNotice(null);
      setResendNotice(null);
      setResending(false);
      setStatus((prev) => (prev === 'idle' ? prev : 'idle'));
    }
  }, [sessionGeneration]);

  const submitVerification = async (tokenValue: string) => {
    const trimmed = tokenValue.trim();
    if (!trimmed) {
      setStatus('error');
      setMessage('Please provide a verification token.');
      return;
    }

    const startSession = captureAuthSessionSnapshot();
    setStatus('submitting');
    setMessage(null);
    setSessionMismatchNotice(null);
    try {
      const res = await apiRequest<{
        verified: boolean;
        userId: string;
        emailVerified: boolean;
        emailVerifiedAt: string;
      }>('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token: trimmed }),
      });

      if (!isSameAuthSession(startSession)) {
        return;
      }

      const currentUser = useAuthStore.getState().user;
      if (currentUser && res.userId && currentUser.id === res.userId) {
        updateUser(
          {
            ...currentUser,
            emailVerified: res.emailVerified,
            emailVerifiedAt: res.emailVerifiedAt,
          },
          res.userId
        );
      } else if (currentUser && currentUser.id !== res.userId) {
        if (isMountedRef.current) {
          setSessionMismatchNotice(
            'This link verified a different TripLedger account. Your currently signed-in account was left unchanged.'
          );
        }
      }
      if (isMountedRef.current) {
        setStatus('verified');
        setMessage('Your email address has been verified.');
      }
    } catch (err) {
      if (isMountedRef.current && isSameAuthSession(startSession)) {
        setStatus('error');
        setMessage(
          err instanceof Error ? err.message : 'Verification link is invalid or has expired.'
        );
      }
    }
  };

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

    if (initialToken && !autoSubmittedRef.current) {
      autoSubmittedRef.current = true;
      void submitVerification(initialToken);
    }
  }, [initialToken, searchParams, setSearchParams]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitVerification(manualToken);
  };

  const handleResendVerification = async () => {
    const startSession = captureAuthSessionSnapshot();
    if (!startSession.hasAccessToken || !startSession.userId) {
      return;
    }
    setResending(true);
    setResendNotice(null);
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
          setStatus('verified');
          setMessage('Your email address is already verified.');
        }
      } else if (isMountedRef.current) {
        setResendNotice({
          type: 'success',
          text: 'A new verification email has been sent. Check your inbox for the latest link.',
        });
      }
    } catch (err) {
      if (isMountedRef.current && isSameAuthSession(startSession, { requireAuthenticated: true })) {
        setResendNotice({
          type: 'error',
          text: err instanceof Error ? err.message : 'Failed to send verification email.',
        });
      }
    } finally {
      if (isMountedRef.current && isSameAuthSession(startSession)) {
        setResending(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md bg-white py-8 px-6 shadow-sm rounded-2xl border border-slate-200 sm:px-10 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center">
            <MailCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Verify Email Address</h1>
            <p className="text-xs text-slate-500">TripLedger account verification</p>
          </div>
        </div>

        {status === 'submitting' && (
          <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 text-xs text-blue-800 font-medium">
            Confirming your verification token...
          </div>
        )}

        {status === 'verified' && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 flex items-start gap-2.5 text-xs text-emerald-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Email verified</p>
              <p className="mt-0.5">{message}</p>
            </div>
          </div>
        )}

        {sessionMismatchNotice && (
          <div
            role="status"
            className="rounded-xl bg-amber-50 border border-amber-200 p-4 flex items-start gap-2.5 text-xs text-amber-900"
          >
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Signed-in session unchanged</p>
              <p className="mt-0.5">{sessionMismatchNotice}</p>
            </div>
          </div>
        )}

        {status === 'error' && message && (
          <div
            role="alert"
            className="rounded-xl bg-rose-50 border border-rose-200 p-4 flex items-start gap-2.5 text-xs text-rose-800"
          >
            <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Verification failed</p>
              <p className="mt-0.5">{message}</p>
            </div>
          </div>
        )}

        {resendNotice && (
          <div
            role={resendNotice.type === 'error' ? 'alert' : 'status'}
            className={`rounded-xl p-3 text-xs font-medium border ${
              resendNotice.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-blue-50 border-blue-200 text-blue-800'
            }`}
          >
            {resendNotice.text}
          </div>
        )}

        {status !== 'verified' && status !== 'submitting' && (
          <div className="space-y-3">
            <form onSubmit={handleManualSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Verification Token
                </label>
                <input
                  type="text"
                  required
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="Paste your email verification token"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs font-mono"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 px-4 text-xs"
              >
                Verify Email
              </button>
            </form>

            {user && user.emailVerified === false && (
              <button
                type="button"
                disabled={resending}
                onClick={() => void handleResendVerification()}
                className="w-full rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-semibold py-2.5 px-4 text-xs"
              >
                {resending ? 'Sending verification email...' : 'Resend Verification Email'}
              </button>
            )}
          </div>
        )}

        <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
          {user ? (
            <>
              <Link to="/" className="font-semibold text-blue-600 hover:underline">
                Go to Dashboard
              </Link>
              <Link to="/settings" className="font-semibold text-slate-600 hover:underline">
                Account Settings
              </Link>
            </>
          ) : (
            <Link to="/login" className="font-semibold text-blue-600 hover:underline">
              Continue to Sign In
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
