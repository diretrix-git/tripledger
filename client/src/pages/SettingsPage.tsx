import React, { useEffect, useState } from 'react';
import { CheckCircle2, MailWarning } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { useAuthStore, type AuthUser } from '../stores/authStore.js';

export function SettingsPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [statusBanner, setStatusBanner] = useState<{
    type: 'info' | 'error';
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    let active = true;
    void apiRequest<{ user: AuthUser }>('/auth/me')
      .then((res) => {
        if (!active) return;
        updateUser(res.user);
        setName(res.user.name);
        setPhone(res.user.phone ?? '');
      })
      .catch(() => {
        // Keep cached store state if offline
      });
    return () => {
      active = false;
    };
  }, [updateUser]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusBanner(null);
    try {
      const res = await apiRequest<{ user: AuthUser }>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ name, phone }),
      });
      updateUser(res.user);
      setStatusBanner({ type: 'info', text: 'Profile updated successfully.' });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update profile',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResendVerification = async () => {
    setResending(true);
    setStatusBanner(null);
    try {
      const res = await apiRequest<{
        sent: boolean;
        alreadyVerified: boolean;
        emailVerified: boolean;
      }>('/auth/resend-verification', { method: 'POST' });

      if (res.alreadyVerified && user) {
        updateUser({ ...user, emailVerified: true });
        setStatusBanner({ type: 'info', text: 'Your email address is already verified.' });
      } else {
        setStatusBanner({
          type: 'info',
          text: 'Verification email sent. Check your inbox for the verification link.',
        });
      }
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to send verification email',
      });
    } finally {
      setResending(false);
    }
  };

  const isVerified = user?.emailVerified === true;

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Account & PWA Settings
        </h1>
        <p className="text-xs text-slate-600 mt-0.5">
          Manage your profile, currency display, and offline PWA preferences.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <form onSubmit={handleSave} className="space-y-4">
          {statusBanner && (
            <div
              role={statusBanner.type === 'error' ? 'alert' : 'status'}
              className={`p-3 rounded-xl text-xs font-medium border ${
                statusBanner.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-blue-50 border-blue-200 text-blue-800'
              }`}
            >
              {statusBanner.text}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Full Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-slate-700">
                Email Address (Immutable)
              </label>
              {isVerified ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold">
                  <CheckCircle2 className="w-3 h-3" />
                  Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 text-[11px] font-semibold">
                  <MailWarning className="w-3 h-3" />
                  Unverified
                </span>
              )}
            </div>
            <input
              type="email"
              disabled
              value={user?.email ?? ''}
              className="w-full rounded-xl border border-slate-200 bg-slate-100 px-3.5 py-2 text-sm text-slate-500"
            />
            {!isVerified && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500">
                  Verify your email before accepting email-bound or organizer invitations.
                </p>
                <button
                  type="button"
                  disabled={resending}
                  onClick={() => void handleResendVerification()}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-[11px] font-semibold"
                >
                  {resending ? 'Sending...' : 'Resend Verification'}
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Phone Number
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Primary Ledger Currency
            </label>
            <input
              type="text"
              disabled
              value="NPR (Nepalese Rupees — Integer Paisa Engine)"
              className="w-full rounded-xl border border-slate-200 bg-slate-100 px-3.5 py-2 text-sm text-slate-600 font-mono"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>
    </div>
  );
}
