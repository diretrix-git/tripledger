import React from 'react';
import { formatPaisaToNPR } from '@tripledger/shared';

export function App(): React.ReactElement {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full">
            TripLedger PWA
          </span>
          <span className="text-xs font-mono text-slate-500 tabular-nums">
            {formatPaisaToNPR(0)}
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Every rupee. Every person. Accounted for.
        </h1>
        <p className="text-sm text-slate-600">
          Group trip and family expense ledger initialized.
        </p>
      </div>
    </div>
  );
}

export default App;
