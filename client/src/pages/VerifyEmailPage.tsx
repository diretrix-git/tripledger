import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { useAuthStore } from '../stores/authStore.js';

export function VerifyEmailPage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const initialToken = searchParams.get('token')?.trim() ?? '';
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [manualToken, setManualToken] = useState(initialToken);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'verified' | 'error'>(
    initialToken ? 'submitting' : 'idle'
  );
  const [message, setMessage] = useState<string | null>(null);
  const autoSubmittedRef = useRef(false);

  const submitVerification = async (tokenValue: string) => {
    const trimmed = tokenValue.trim();
    if (!trimmed) {
      setStatus('error');
      setMessage('Please provide a verification token.');
      return;
    }

    setStatus('submitting');
    setMessage(null);
    try {
      const res = await apiRequest<{
        verified: boolean;
        emailVerified: boolean;
        emailVerifiedAt: string;
      }>('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token: trimmed }),
      });

      const currentUser = useAuthStore.getState().user;
      if (currentUser) {
        updateUser({
          ...currentUser,
          emailVerified: res.emailVerified,
          emailVerifiedAt: res.emailVerifiedAt,
        });
      }
      setStatus('verified');
      setMessage('Your email address has been verified.');
    } catch (err) {
      setStatus('error');
      setMessage(
        err instanceof Error ? err.message : 'Verification link is invalid or has expired.'
      );
    }
  };

  useEffect(() => {
    if (initialToken && !autoSubmittedRef.current) {
      autoSubmittedRef.current = true;
      void submitVerification(initialToken);
    }
  }, [initialToken]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submitVerification(manualToken);
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

        {status !== 'verified' && !initialToken && (
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
              disabled={status === 'submitting'}
              className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 px-4 text-xs"
            >
              Verify Email
            </button>
          </form>
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
