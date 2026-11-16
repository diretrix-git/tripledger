import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Compass,
  FolderClock,
  LayoutDashboard,
  LogOut,
  MailWarning,
  Plus,
  RefreshCw,
  Settings,
  Users,
  UsersRound,
  Wallet,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { formatPaisaToNPR } from '@tripledger/shared';
import { useAuthStore, type AuthUser } from '../../stores/authStore.js';
import { useOfflineSync } from '../../hooks/useOfflineSync.js';
import { apiRequest } from '../../api/client.js';

export function AppShell(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const updateUser = useAuthStore((s) => s.updateUser);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const navigate = useNavigate();
  const { isOnline, isSyncing, queue, flushOfflineQueue } = useOfflineSync();
  const [showQueueDrawer, setShowQueueDrawer] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let active = true;

    const syncAuthProfile = () => {
      void apiRequest<{ user: AuthUser }>('/auth/me')
        .then((res) => {
          if (active) {
            updateUser(res.user);
          }
        })
        .catch(() => {
          // Keep cached state if offline; expired sessions are cleared in apiRequest.
        });
    };

    syncAuthProfile();
    window.addEventListener('focus', syncAuthProfile);
    return () => {
      active = false;
      window.removeEventListener('focus', syncAuthProfile);
    };
  }, [accessToken, updateUser]);

  const handleLogout = async () => {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch {
      // ignore network error on logout
    }
    clearAuth();
    navigate('/login');
  };

  const navItems = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/friends', label: 'Friends Trips', icon: Users },
    { to: '/family', label: 'Family Trips', icon: UsersRound },
    { to: '/balances', label: 'My Balances', icon: Wallet },
    { to: '/history', label: 'Trip History', icon: FolderClock },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col md:flex-row">
      {/* Desktop Sidebar Rail */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 bg-slate-900 text-slate-100 border-r border-slate-800 z-20">
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white shadow-sm">
              TL
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight text-white block leading-none">
                TripLedger
              </span>
              <span className="text-[11px] text-slate-400">NPR Financial Ledger</span>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Offline / Sync Status Pill */}
        <div className="p-4 border-t border-slate-800 space-y-3">
          <div
            onClick={() => queue.length > 0 && setShowQueueDrawer(!showQueueDrawer)}
            className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs cursor-pointer ${
              isOnline
                ? 'bg-slate-800/90 text-emerald-400'
                : 'bg-amber-950/80 text-amber-300 border border-amber-700/50'
            }`}
          >
            <div className="flex items-center gap-2">
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              <span>{isOnline ? 'Online & Synced' : 'Offline Mode Active'}</span>
            </div>
            {queue.length > 0 && (
              <span className="bg-amber-500 text-slate-950 font-bold px-1.5 py-0.5 rounded text-[10px]">
                {queue.length} queued
              </span>
            )}
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="truncate pr-2">
              <p className="text-xs font-semibold text-white truncate">{user?.name}</p>
              <p className="text-[11px] text-slate-400 truncate">{user?.email}</p>
            </div>
            <button
              onClick={handleLogout}
              title="Log out"
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 md:pl-64 flex flex-col min-h-screen pb-20 md:pb-0">
        {/* Mobile Top Header */}
        <header className="md:hidden sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-xs">
              TL
            </div>
            <span className="font-bold text-slate-900 tracking-tight">TripLedger</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowQueueDrawer(!showQueueDrawer)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                isOnline
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-amber-100 text-amber-800'
              }`}
            >
              {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span>{queue.length > 0 ? `${queue.length} Queued` : isOnline ? 'Online' : 'Offline'}</span>
            </button>
            <NavLink
              to="/settings"
              className="p-1.5 text-slate-600 hover:text-slate-900 rounded-lg"
            >
              <Settings className="w-4 h-4" />
            </NavLink>
          </div>
        </header>

        {/* Unverified Email Notice Banner */}
        {user && user.emailVerified === false && (
          <div className="bg-slate-900 text-slate-100 border-b border-slate-800 px-4 py-2 flex items-center justify-between text-xs gap-2">
            <div className="flex items-center gap-2">
              <MailWarning className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Your email address is unverified. Verify your email to enable verified organizer and
                email-bound invitations.
              </span>
            </div>
            <NavLink
              to="/settings"
              className="shrink-0 font-semibold text-amber-300 hover:text-amber-200 underline"
            >
              Verify in Settings
            </NavLink>
          </div>
        )}

        {/* Offline Queue Banner if items are waiting */}
        {(!isOnline || queue.length > 0) && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between text-xs text-amber-900">
            <div className="flex items-center gap-2">
              <WifiOff className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                {!isOnline
                  ? 'You are currently offline. New expenses are saved locally in your device queue and will sync automatically.'
                  : `${queue.length} offline expense(s) ready to synchronize.`}
              </span>
            </div>
            {isOnline && queue.length > 0 && (
              <button
                onClick={() => void flushOfflineQueue()}
                disabled={isSyncing}
                className="flex items-center gap-1 bg-amber-600 hover:bg-amber-700 text-white font-semibold px-2.5 py-1 rounded-md transition-colors"
              >
                <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{isSyncing ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            )}
          </div>
        )}

        {/* Offline Queue Drawer Modal */}
        {showQueueDrawer && queue.length > 0 && (
          <div className="bg-white border-b border-slate-200 px-6 py-4 shadow-sm">
            <div className="max-w-5xl mx-auto">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Offline Expense Queue ({queue.length})
                </h3>
                <button
                  onClick={() => setShowQueueDrawer(false)}
                  className="text-xs text-slate-500 hover:text-slate-800"
                >
                  Close
                </button>
              </div>
              <div className="divide-y divide-slate-100">
                {queue.map((item) => (
                  <div
                    key={item.clientMutationId}
                    className="py-2 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="font-semibold text-slate-900">{item.payload.title}</span>
                      <span className="text-slate-500 ml-2">({item.tripName})</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-semibold tabular-nums">
                        {formatPaisaToNPR(item.payload.amountPaisa)}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                        {item.syncStatus}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6">
          <Outlet />
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 z-20 flex items-center justify-around py-1.5 px-2">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `flex flex-col items-center py-1 px-2 rounded-lg text-[11px] font-medium ${
              isActive ? 'text-blue-600' : 'text-slate-500'
            }`
          }
        >
          <LayoutDashboard className="w-5 h-5 mb-0.5" />
          <span>Home</span>
        </NavLink>
        <NavLink
          to="/friends"
          className={({ isActive }) =>
            `flex flex-col items-center py-1 px-2 rounded-lg text-[11px] font-medium ${
              isActive ? 'text-blue-600' : 'text-slate-500'
            }`
          }
        >
          <Users className="w-5 h-5 mb-0.5" />
          <span>Friends</span>
        </NavLink>
        <NavLink
          to="/trips/new"
          className="flex flex-col items-center -mt-4"
        >
          <div className="w-11 h-11 rounded-full bg-blue-600 text-white shadow-md flex items-center justify-center">
            <Plus className="w-5 h-5" />
          </div>
          <span className="text-[10px] font-semibold text-blue-600 mt-0.5">New Trip</span>
        </NavLink>
        <NavLink
          to="/family"
          className={({ isActive }) =>
            `flex flex-col items-center py-1 px-2 rounded-lg text-[11px] font-medium ${
              isActive ? 'text-blue-600' : 'text-slate-500'
            }`
          }
        >
          <UsersRound className="w-5 h-5 mb-0.5" />
          <span>Family</span>
        </NavLink>
        <NavLink
          to="/balances"
          className={({ isActive }) =>
            `flex flex-col items-center py-1 px-2 rounded-lg text-[11px] font-medium ${
              isActive ? 'text-blue-600' : 'text-slate-500'
            }`
          }
        >
          <Compass className="w-5 h-5 mb-0.5" />
          <span>Balances</span>
        </NavLink>
      </nav>
    </div>
  );
}
