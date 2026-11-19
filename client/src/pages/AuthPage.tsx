import React, { useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QueryClientContext } from '@tanstack/react-query';
import { ApiClientError, apiRequest } from '../api/client.js';
import { clearAuthQueryCache } from '../hooks/useAuthCacheIsolation.js';
import {
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
  type AuthUser,
} from '../stores/authStore.js';

export function AuthPage({ mode }: { mode: 'login' | 'register' }): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useContext(QueryClientContext);
  const setAuth = useAuthStore((s) => s.setAuth);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const isMountedRef = useRef(true);
  const prevGenerationRef = useRef(sessionGeneration);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prevGenerationRef.current !== sessionGeneration) {
      prevGenerationRef.current = sessionGeneration;
      setError(null);
      setNotice(null);
      setLoading(false);
    }
  }, [sessionGeneration]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const startSession = captureAuthSessionSnapshot();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';
      const body =
        mode === 'login'
          ? { email, password }
          : { name, email, password, phone: phone || undefined };

      const data = await apiRequest<{
        user: AuthUser;
        accessToken: string;
        refreshToken: string;
        emailVerificationSent?: boolean;
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!isMountedRef.current) {
        return;
      }

      if (!isSameAuthSession(startSession)) {
        setError(
          'Your signed-in session changed in another tab while this request was in flight. Please submit again if you still want to switch accounts.'
        );
        return;
      }

      clearAuthQueryCache(queryClient);
      setAuth(data.user, data.accessToken, data.refreshToken);
      prevGenerationRef.current = useAuthStore.getState().sessionGeneration;

      if (mode === 'register' && data.emailVerificationSent === false) {
        setNotice(
          'Your account was created and you are signed in, but the verification email could not be sent right now. You can continue using TripLedger and resend verification from Settings.'
        );
        navigate('/', { state: { emailVerificationSent: false } });
        return;
      }

      navigate('/');
    } catch (err) {
      if (!isMountedRef.current || !isSameAuthSession(startSession)) {
        return;
      }
      if (err instanceof ApiClientError && err.code === 'EMAIL_DELIVERY_FAILED') {
        setError(
          'Your account was created, but sending the verification email failed. Please sign in and resend verification from Settings.'
        );
      } else {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      }
    } finally {
      if (isMountedRef.current && isSameAuthSession(startSession)) {
        setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <div className="w-12 h-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-bold text-xl shadow-sm">
            TL
          </div>
        </div>
        <h1 className="mt-4 text-center text-2xl font-bold tracking-tight text-slate-900">
          {mode === 'login' ? 'Sign in to TripLedger' : 'Create your TripLedger account'}
        </h1>
        <p className="mt-1 text-center text-sm text-slate-600">
          Every rupee. Every person. Accounted for.
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 shadow-sm rounded-2xl border border-slate-200 sm:px-10">
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs font-medium text-rose-700"
            >
              {error}
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs font-medium text-amber-800"
            >
              {notice}
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSubmit}>
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Aarav Sharma"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'At least 8 chars with letter & number' : '••••••••'}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Phone Number (Optional — for eSewa/Khalti reference)
                </label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="9841000000"
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 px-4 text-sm shadow-sm transition-colors"
            >
              {loading
                ? 'Please wait...'
                : mode === 'login'
                  ? 'Sign In'
                  : 'Create Account'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-100 text-center text-xs text-slate-600">
            {mode === 'login' ? (
              <>
                New to TripLedger?{' '}
                <Link to="/register" className="font-semibold text-blue-600 hover:text-blue-700">
                  Create an account
                </Link>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <Link to="/login" className="font-semibold text-blue-600 hover:text-blue-700">
                  Sign in instead
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
