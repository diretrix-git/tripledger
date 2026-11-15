import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Users, UsersRound } from 'lucide-react';
import { nprToPaisa, type TripMode } from '@tripledger/shared';
import { apiRequest } from '../api/client.js';

export function CreateTripPage(): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const initialMode = (searchParams.get('mode') === 'FAMILY' ? 'FAMILY' : 'FRIENDS') as TripMode;

  const [mode, setMode] = useState<TripMode>(initialMode);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [budgetNpr, setBudgetNpr] = useState('');
  const [organizerFamilyName, setOrganizerFamilyName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const budgetPaisa = budgetNpr.trim() ? nprToPaisa(budgetNpr) : undefined;
      const res = await apiRequest<{ trip: { id: string } }>('/trips', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description || undefined,
          mode,
          budgetPaisa,
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          organizerFamilyName:
            mode === 'FAMILY' && organizerFamilyName.trim()
              ? organizerFamilyName.trim()
              : undefined,
        }),
      });

      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      await queryClient.invalidateQueries({ queryKey: ['trips'] });
      navigate(`/trips/${res.trip.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create trip');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Create a New Trip</h1>
        <p className="text-sm text-slate-600 mt-1">
          Choose between Friends Mode (individual participants) or Family Mode (family groups, representatives & packages).
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        {error && (
          <div className="mb-4 rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs font-medium text-rose-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Operating Mode Selector */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              Operating Mode
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setMode('FRIENDS')}
                className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-all ${
                  mode === 'FRIENDS'
                    ? 'border-blue-600 bg-blue-50/50 ring-2 ring-blue-600/20'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="p-2 rounded-lg bg-blue-600 text-white">
                  <Users className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold text-sm text-slate-900">Friends Mode</div>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Individual tracking for road trips, college outings & shared meals.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setMode('FAMILY')}
                className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-all ${
                  mode === 'FAMILY'
                    ? 'border-blue-600 bg-blue-50/50 ring-2 ring-blue-600/20'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="p-2 rounded-lg bg-slate-900 text-white">
                  <UsersRound className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold text-sm text-slate-900">Family Mode</div>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Family groups, representatives, packages, and dual-level settlements.
                  </p>
                </div>
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Trip Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={mode === 'FAMILY' ? 'e.g., Pokhara Family Vacation 2026' : 'e.g., Mustang Bike Trip'}
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
            />
          </div>

          {mode === 'FAMILY' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Your Family Group Name (Optional)
              </label>
              <input
                type="text"
                value={organizerFamilyName}
                onChange={(e) => setOrganizerFamilyName(e.target.value)}
                placeholder="e.g., Sharma Family"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Creates your initial family group and assigns you as its representative. You can add more families inside the trip.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Trip Budget in NPR (Optional)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={budgetNpr}
              onChange={(e) => setBudgetNpr(e.target.value)}
              placeholder="e.g., 50000"
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-mono tabular-nums focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Start Date (Optional)
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                End Date (Optional)
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Description / Notes (Optional)
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Itinerary, hotel notes, or common instructions..."
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-xs font-semibold text-white shadow-sm"
            >
              {loading ? 'Creating Trip...' : 'Create Trip'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
