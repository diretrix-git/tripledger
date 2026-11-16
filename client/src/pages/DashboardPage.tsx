import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Plus,
  Ticket,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { formatPaisaToNPR, type TripMode, type TripStatus } from '@tripledger/shared';
import { apiRequest } from '../api/client.js';

export interface DashboardTripSummary {
  id: string;
  name: string;
  description?: string;
  mode: TripMode;
  status: TripStatus;
  budgetPaisa?: number;
  inviteCode?: string;
  participantCount: number;
  familyCount: number;
  totalApprovedExpensePaisa: number;
  totalPendingExpensePaisa: number;
  myRole: string;
  myOutstandingBalancePaisa: number;
}

interface DashboardResponse {
  metrics: {
    activeTripsCount: number;
    closedTripsCount: number;
    totalActiveTripExpensePaisa: number;
    totalOwedToMePaisa: number;
    totalIOwePaisa: number;
    netOverallBalancePaisa: number;
  };
  trips: DashboardTripSummary[];
  recentActivities: Array<{
    id: string;
    tripId: string;
    tripName: string;
    actorName: string;
    summary: string;
    createdAt: string;
  }>;
}

export function DashboardPage(): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [inviteCode, setInviteCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiRequest<DashboardResponse>('/dashboard/summary'),
  });

  const handleJoinTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError(null);
    if (!inviteCode.trim()) return;

    try {
      const res = await apiRequest<{ trip: { id: string } }>(
        `/trips/join/${inviteCode.trim().toUpperCase()}`,
        { method: 'POST' }
      );
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      navigate(`/trips/${res.trip.id}`);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Invalid invite code');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-28 bg-slate-200 rounded-2xl" />
        <div className="h-64 bg-slate-200 rounded-2xl" />
      </div>
    );
  }

  const metrics = data?.metrics ?? {
    activeTripsCount: 0,
    closedTripsCount: 0,
    totalActiveTripExpensePaisa: 0,
    totalOwedToMePaisa: 0,
    totalIOwePaisa: 0,
    netOverallBalancePaisa: 0,
  };

  const activeTrips = (data?.trips ?? []).filter((t) => t.status !== 'CLOSED');

  return (
    <div className="space-y-6">
      {/* Header & Quick Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Financial Overview
          </h1>
          <p className="text-xs text-slate-600 mt-0.5">
            Track shared trips, family packages, and personal NPR balances in real time.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link
            to="/trips/new?mode=FRIENDS"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>New Friends Trip</span>
          </Link>
          <Link
            to="/trips/new?mode=FAMILY"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-sm"
          >
            <UsersRound className="w-4 h-4" />
            <span>New Family Trip</span>
          </Link>
        </div>
      </div>

      {/* 4 Financial Metric Strip Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Active Trip Spend</span>
            <Wallet className="w-4 h-4 text-slate-400" />
          </div>
          <p className="mt-2 text-lg sm:text-xl font-bold font-mono tabular-nums text-slate-900">
            {formatPaisaToNPR(metrics.totalActiveTripExpensePaisa)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            Across {metrics.activeTripsCount} active trip(s)
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs text-emerald-700 font-medium">
            <span>Owed to You</span>
            <ArrowDownLeft className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-lg sm:text-xl font-bold font-mono tabular-nums text-emerald-600">
            {formatPaisaToNPR(metrics.totalOwedToMePaisa)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">To receive from others</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs text-rose-700 font-medium">
            <span>You Owe</span>
            <ArrowUpRight className="w-4 h-4 text-rose-600" />
          </div>
          <p className="mt-2 text-lg sm:text-xl font-bold font-mono tabular-nums text-rose-600">
            {formatPaisaToNPR(metrics.totalIOwePaisa)}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Pending reimbursement</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Net Position</span>
          </div>
          <p
            className={`mt-2 text-lg sm:text-xl font-bold font-mono tabular-nums ${
              metrics.netOverallBalancePaisa > 0
                ? 'text-emerald-600'
                : metrics.netOverallBalancePaisa < 0
                  ? 'text-rose-600'
                  : 'text-slate-800'
            }`}
          >
            {formatPaisaToNPR(metrics.netOverallBalancePaisa, { showSign: true })}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            {metrics.netOverallBalancePaisa === 0 ? 'All settled' : 'Net across all trips'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Trips Column */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900">Active Trips</h2>
            <Link to="/history" className="text-xs font-semibold text-blue-600 hover:underline">
              View All ({data?.trips.length ?? 0})
            </Link>
          </div>

          {activeTrips.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-8 text-center space-y-3">
              <p className="text-sm font-semibold text-slate-800">No active trips yet</p>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                Start a Friends Mode outing or a Family Mode trip to track expenses, packages, and settlements.
              </p>
              <div className="flex justify-center gap-2 pt-1">
                <Link
                  to="/trips/new?mode=FRIENDS"
                  className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold"
                >
                  Create Friends Trip
                </Link>
                <Link
                  to="/trips/new?mode=FAMILY"
                  className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold"
                >
                  Create Family Trip
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {activeTrips.map((trip) => (
                <Link
                  key={trip.id}
                  to={`/trips/${trip.id}`}
                  className="block bg-white rounded-2xl border border-slate-200 hover:border-blue-400 p-4 shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            trip.mode === 'FAMILY'
                              ? 'bg-purple-50 text-purple-700 border border-purple-200'
                              : 'bg-blue-50 text-blue-700 border border-blue-200'
                          }`}
                        >
                          {trip.mode === 'FAMILY' ? (
                            <UsersRound className="w-3 h-3" />
                          ) : (
                            <Users className="w-3 h-3" />
                          )}
                          {trip.mode}
                        </span>
                        <span className="text-[11px] text-slate-500 font-medium">
                          {trip.participantCount} members
                          {trip.mode === 'FAMILY' ? ` • ${trip.familyCount} families` : ''}
                        </span>
                      </div>
                      <h3 className="text-base font-bold text-slate-900 mt-1.5">
                        {trip.name}
                      </h3>
                    </div>

                    <div className="text-right">
                      <span className="text-[11px] text-slate-500 block">Total Spend</span>
                      <span className="text-sm font-bold font-mono tabular-nums text-slate-900">
                        {formatPaisaToNPR(trip.totalApprovedExpensePaisa)}
                      </span>
                      <div className="mt-1">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono font-semibold tabular-nums ${
                            trip.myOutstandingBalancePaisa > 0
                              ? 'bg-emerald-50 text-emerald-700'
                              : trip.myOutstandingBalancePaisa < 0
                                ? 'bg-rose-50 text-rose-700'
                                : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {trip.myOutstandingBalancePaisa > 0
                            ? `Owed ${formatPaisaToNPR(trip.myOutstandingBalancePaisa)}`
                            : trip.myOutstandingBalancePaisa < 0
                              ? `You owe ${formatPaisaToNPR(Math.abs(trip.myOutstandingBalancePaisa))}`
                              : 'Settled'}
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Join by Invite Code & Recent Activity */}
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              <Ticket className="w-4 h-4 text-blue-600" />
              <span>Join Trip by Invite Code</span>
            </div>
            <form onSubmit={handleJoinTrip} className="flex gap-2">
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Enter 8-char code"
                className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-mono uppercase focus:border-blue-600 focus:outline-none"
              />
              <button
                type="submit"
                className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
              >
                Join
              </button>
            </form>
            {joinError && (
              <p className="text-xs text-rose-600 mt-1.5 font-medium">{joinError}</p>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
              Recent Ledger Activity
            </h3>
            {(data?.recentActivities ?? []).length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                No activity recorded yet.
              </p>
            ) : (
              <div className="space-y-3">
                {data?.recentActivities.slice(0, 8).map((act) => (
                  <div key={act.id} className="text-xs border-b border-slate-100 pb-2.5 last:border-0 last:pb-0">
                    <p className="text-slate-800 font-medium">{act.summary}</p>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mt-0.5">
                      <span>{act.tripName}</span>
                      <span>{new Date(act.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
