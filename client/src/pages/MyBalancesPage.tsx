import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { formatPaisaToNPR } from '@tripledger/shared';
import { apiRequest } from '../api/client.js';
import { useAuthStore } from '../stores/authStore.js';
import type { DashboardTripSummary } from './DashboardPage.js';

export function MyBalancesPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', user?.id ?? null],
    queryFn: () =>
      apiRequest<{
        metrics: {
          totalOwedToMePaisa: number;
          totalIOwePaisa: number;
          netOverallBalancePaisa: number;
        };
        trips: Array<
          DashboardTripSummary & {
            myTotalPaidPaisa: number;
            myTotalSharePaisa: number;
          }
        >;
      }>('/dashboard/summary'),
    enabled: Boolean(accessToken && user?.id),
  });

  if (isLoading) {
    return <div className="h-64 bg-slate-200 rounded-2xl animate-pulse" />;
  }

  const metrics = data?.metrics ?? {
    totalOwedToMePaisa: 0,
    totalIOwePaisa: 0,
    netOverallBalancePaisa: 0,
  };
  const trips = data?.trips ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          My Personal Balances
        </h1>
        <p className="text-xs text-slate-600 mt-0.5">
          Reconciled contributions, shares, and outstanding NPR balances across all trips.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-emerald-700">
            <span>Total Owed to You</span>
            <ArrowDownLeft className="w-4 h-4" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600 mt-2">
            {formatPaisaToNPR(metrics.totalOwedToMePaisa)}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-semibold text-rose-700">
            <span>Total You Owe</span>
            <ArrowUpRight className="w-4 h-4" />
          </div>
          <p className="text-2xl font-bold font-mono tabular-nums text-rose-600 mt-2">
            {formatPaisaToNPR(metrics.totalIOwePaisa)}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <div className="text-xs font-semibold text-slate-500">Net Overall Balance</div>
          <p
            className={`text-2xl font-bold font-mono tabular-nums mt-2 ${
              metrics.netOverallBalancePaisa > 0
                ? 'text-emerald-600'
                : metrics.netOverallBalancePaisa < 0
                  ? 'text-rose-600'
                  : 'text-slate-900'
            }`}
          >
            {formatPaisaToNPR(metrics.netOverallBalancePaisa, { showSign: true })}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900 mb-4">Trip-by-Trip Breakdown</h2>
        {trips.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500">
            <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
            <p>You have no trip balances yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-semibold">Trip</th>
                  <th className="py-2 font-semibold">Mode</th>
                  <th className="py-2 font-semibold text-right">You Paid</th>
                  <th className="py-2 font-semibold text-right">Your Share</th>
                  <th className="py-2 font-semibold text-right">Outstanding Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {trips.map((t) => (
                  <tr key={t.id}>
                    <td className="py-3">
                      <Link
                        to={`/trips/${t.id}`}
                        className="font-bold text-blue-600 hover:underline"
                      >
                        {t.name}
                      </Link>
                    </td>
                    <td className="py-3 text-slate-600">{t.mode}</td>
                    <td className="py-3 text-right font-mono tabular-nums">
                      {formatPaisaToNPR(t.myTotalPaidPaisa)}
                    </td>
                    <td className="py-3 text-right font-mono tabular-nums">
                      {formatPaisaToNPR(t.myTotalSharePaisa)}
                    </td>
                    <td className="py-3 text-right font-mono font-bold tabular-nums">
                      <span
                        className={
                          t.myOutstandingBalancePaisa > 0
                            ? 'text-emerald-600'
                            : t.myOutstandingBalancePaisa < 0
                              ? 'text-rose-600'
                              : 'text-slate-500'
                        }
                      >
                        {formatPaisaToNPR(t.myOutstandingBalancePaisa, { showSign: true })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
