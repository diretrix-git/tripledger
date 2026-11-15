import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  EXPENSE_CATEGORY_LABELS,
  formatPaisaToNPR,
  type ExpenseCategory,
  type FamilyBalanceSummary,
  type IndividualBalanceSummary,
  type SettlementSuggestion,
  type TripMode,
  type TripStatus,
} from '@tripledger/shared';
import { apiRequest } from '../api/client.js';

interface PublicSharedResponse {
  trip: {
    id: string;
    name: string;
    description?: string;
    mode: TripMode;
    status: TripStatus;
    currency: string;
  };
  ledger: {
    totalApprovedExpensePaisa: number;
    totalPackageExpensePaisa: number;
    totalAdditionalExpensePaisa: number;
    individualBalances: IndividualBalanceSummary[];
    familyBalances: FamilyBalanceSummary[];
  };
  categoryBreakdown: Array<{
    category: ExpenseCategory;
    label: string;
    expenseCount: number;
    amountPaisa: number;
  }>;
  individualSettlementSuggestions: SettlementSuggestion[];
  familySettlementSuggestions: SettlementSuggestion[];
}

export function PublicSharedReportPage(): React.ReactElement {
  const { shareToken } = useParams<{ shareToken: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['public-share', shareToken],
    queryFn: () => apiRequest<PublicSharedResponse>(`/shared/${shareToken}`),
    enabled: Boolean(shareToken),
  });

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="h-64 bg-slate-200 rounded-2xl animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-xl mx-auto p-6 mt-12 bg-white rounded-2xl border border-slate-200 text-center space-y-3">
        <h1 className="text-lg font-bold text-slate-900">Shared Trip Summary Unavailable</h1>
        <p className="text-xs text-slate-600">
          {error instanceof Error ? error.message : 'This report link is invalid or disabled.'}
        </p>
        <Link
          to="/login"
          className="inline-block px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold"
        >
          Go to TripLedger
        </Link>
      </div>
    );
  }

  const {
    trip,
    ledger,
    categoryBreakdown,
    individualSettlementSuggestions,
    familySettlementSuggestions,
  } = data;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-600 px-2.5 py-0.5 rounded-full">
              TripLedger Read-Only Shared Summary • {trip.mode} Mode
            </span>
            <h1 className="text-2xl font-bold mt-2">{trip.name}</h1>
            {trip.description && (
              <p className="text-xs text-slate-300 mt-1">{trip.description}</p>
            )}
          </div>
          <div className="text-left sm:text-right">
            <span className="text-xs text-slate-400 block">Total Trip Spend</span>
            <span className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
              {formatPaisaToNPR(ledger.totalApprovedExpensePaisa)}
            </span>
          </div>
        </div>

        {/* Family Balances if Family Mode */}
        {trip.mode === 'FAMILY' && ledger.familyBalances.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-3">
              Family-Level Aggregate Balances
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ledger.familyBalances.map((fam) => (
                <div
                  key={fam.familyId}
                  className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between text-xs"
                >
                  <div>
                    <p className="font-bold text-slate-900">{fam.familyName}</p>
                    <p className="text-slate-500">
                      Rep: {fam.representativeName ?? '-'} • {fam.memberCount} members
                    </p>
                  </div>
                  <span
                    className={`font-mono font-bold tabular-nums ${
                      fam.outstandingBalancePaisa > 0
                        ? 'text-emerald-600'
                        : fam.outstandingBalancePaisa < 0
                          ? 'text-rose-600'
                          : 'text-slate-600'
                    }`}
                  >
                    {formatPaisaToNPR(fam.outstandingBalancePaisa, { showSign: true })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Individual Balances */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-bold text-slate-900 mb-3">
            Participant Balance Statement
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-semibold">Participant</th>
                  <th className="py-2 font-semibold text-right">Paid</th>
                  <th className="py-2 font-semibold text-right">Share</th>
                  <th className="py-2 font-semibold text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ledger.individualBalances.map((b) => (
                  <tr key={b.participantId}>
                    <td className="py-2.5 font-medium text-slate-900">
                      {b.participantName}
                      {b.familyName ? (
                        <span className="text-slate-500 font-normal ml-1.5">
                          ({b.familyName})
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {formatPaisaToNPR(b.totalPaidPaisa)}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">
                      {formatPaisaToNPR(b.totalSharePaisa)}
                    </td>
                    <td className="py-2.5 text-right font-mono font-bold tabular-nums">
                      <span
                        className={
                          b.outstandingBalancePaisa > 0
                            ? 'text-emerald-600'
                            : b.outstandingBalancePaisa < 0
                              ? 'text-rose-600'
                              : 'text-slate-500'
                        }
                      >
                        {formatPaisaToNPR(b.outstandingBalancePaisa, { showSign: true })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Category Breakdown & Suggested Settlements */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-3">
              Category Breakdown
            </h2>
            <div className="space-y-2 text-xs">
              {categoryBreakdown.map((c) => (
                <div key={c.category} className="flex items-center justify-between py-1">
                  <span className="text-slate-700 font-medium">
                    {EXPENSE_CATEGORY_LABELS[c.category] ?? c.label} ({c.expenseCount})
                  </span>
                  <span className="font-mono font-semibold tabular-nums">
                    {formatPaisaToNPR(c.amountPaisa)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-3">
              Recommended Settlements
            </h2>
            {(() => {
              const list =
                trip.mode === 'FAMILY' && familySettlementSuggestions.length > 0
                  ? familySettlementSuggestions
                  : individualSettlementSuggestions;

              if (list.length === 0) {
                return <p className="text-xs text-slate-500">All balances settled!</p>;
              }
              return (
                <div className="space-y-2 text-xs">
                  {list.map((s, i) => (
                    <div
                      key={i}
                      className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between"
                    >
                      <span>
                        <strong>{s.fromFamilyName ?? s.fromParticipantName}</strong> pays{' '}
                        <strong>{s.toFamilyName ?? s.toParticipantName}</strong>
                      </span>
                      <span className="font-mono font-bold text-blue-600 tabular-nums">
                        {formatPaisaToNPR(s.amountPaisa)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
