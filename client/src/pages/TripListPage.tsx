import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Users, UsersRound } from 'lucide-react';
import { formatPaisaToNPR, type TripMode } from '@tripledger/shared';
import { apiRequest } from '../api/client.js';
import type { DashboardTripSummary } from './DashboardPage.js';

export function TripListPage({
  filterMode,
  filterClosed,
  title,
  subtitle,
}: {
  filterMode?: TripMode;
  filterClosed?: boolean;
  title: string;
  subtitle: string;
}): React.ReactElement {
  const queryParams = new URLSearchParams();
  if (filterMode) queryParams.set('mode', filterMode);
  if (filterClosed) queryParams.set('status', 'CLOSED');

  const { data, isLoading } = useQuery({
    queryKey: ['trips', filterMode ?? 'ALL', filterClosed ? 'CLOSED' : 'ALL'],
    queryFn: () =>
      apiRequest<{ trips: DashboardTripSummary[] }>(
        `/trips${queryParams.toString() ? `?${queryParams.toString()}` : ''}`
      ),
  });

  const trips = data?.trips ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
        </div>
        {!filterClosed && (
          <Link
            to={`/trips/new${filterMode ? `?mode=${filterMode}` : ''}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm self-start"
          >
            <Plus className="w-4 h-4" />
            <span>Create {filterMode === 'FAMILY' ? 'Family' : 'Friends'} Trip</span>
          </Link>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3 animate-pulse">
          <div className="h-24 bg-slate-200 rounded-2xl" />
          <div className="h-24 bg-slate-200 rounded-2xl" />
        </div>
      ) : trips.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-800">No matching trips found</p>
          {!filterClosed && (
            <Link
              to={`/trips/new${filterMode ? `?mode=${filterMode}` : ''}`}
              className="inline-block px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold"
            >
              Create Your First Trip
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {trips.map((trip) => (
            <Link
              key={trip.id}
              to={`/trips/${trip.id}`}
              className="bg-white rounded-2xl border border-slate-200 hover:border-blue-400 p-5 shadow-sm transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
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
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                      trip.status === 'CLOSED'
                        ? 'bg-slate-200 text-slate-700'
                        : 'bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {trip.status}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-slate-900 mt-2">{trip.name}</h2>
                {trip.description && (
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2">{trip.description}</p>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <div className="text-slate-500">
                  <span>{trip.participantCount} participants</span>
                  {trip.mode === 'FAMILY' && <span> • {trip.familyCount} families</span>}
                </div>
                <div className="text-right">
                  <span className="font-mono font-bold tabular-nums text-slate-900 block">
                    {formatPaisaToNPR(trip.totalApprovedExpensePaisa)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
