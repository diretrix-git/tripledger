import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  formatPaisaToNPR,
  nprToPaisa,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type ExpenseCategory,
  type FamilyEntity,
  type ParticipantEntity,
  type PaymentMethod,
  type SplitMethod,
  type TripMode,
} from '@tripledger/shared';
import { apiRequest } from '../../api/client.js';
import { captureAuthSessionSnapshot, isSameAuthSession } from '../../stores/authStore.js';
import { useOfflineQueueStore } from '../../stores/offlineQueueStore.js';
import { generateUUID } from '../../utils/uuid.js';

interface QuickAddExpenseModalProps {
  tripId: string;
  tripName: string;
  tripMode: TripMode;
  myParticipantId: string;
  participants: ParticipantEntity[];
  families: FamilyEntity[];
  onClose: () => void;
}

export function QuickAddExpenseModal({
  tripId,
  tripName,
  tripMode,
  myParticipantId,
  participants,
  families,
  onClose,
}: QuickAddExpenseModalProps): React.ReactElement {
  const queryClient = useQueryClient();
  const { isOnline, enqueueExpense } = useOfflineQueueStore();
  const isMountedRef = useRef(true);
  const activeTripIdRef = useRef(tripId);
  activeTripIdRef.current = tripId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const activeParticipants = participants.filter((p) => p.isActive);
  const defaultPayerId =
    activeParticipants.find((p) => p.id === myParticipantId)?.id ??
    activeParticipants.find((p) => p.role === 'ORGANIZER')?.id ??
    activeParticipants[0]?.id ??
    '';

  const [title, setTitle] = useState('');
  const [amountNpr, setAmountNpr] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('FOOD_DRINKS');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [isEstimated, setIsEstimated] = useState(false);
  const [isPackage, setIsPackage] = useState(false);
  const [packageRateNpr, setPackageRateNpr] = useState('');

  // Payer Mode: SINGLE or MULTIPLE
  const [payerMode, setPayerMode] = useState<'SINGLE' | 'MULTIPLE'>('SINGLE');
  const [singlePayerId, setSinglePayerId] = useState(defaultPayerId);
  const [multiPayerAmounts, setMultiPayerAmounts] = useState<Record<string, string>>({});

  // Split Method
  const [splitMethod, setSplitMethod] = useState<SplitMethod>('EQUAL');
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>(
    activeParticipants.map((p) => p.id)
  );
  const [selectedFamilyIds, setSelectedFamilyIds] = useState<string[]>(
    families.map((f) => f.id)
  );
  const [customShareNpr, setCustomShareNpr] = useState<Record<string, string>>({});
  const [weightOverrides, setWeightOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(activeParticipants.map((p) => [p.id, String(p.defaultWeight)]))
  );

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleParticipant = (id: string) => {
    setSelectedParticipantIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleFamily = (id: string) => {
    setSelectedFamilyIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handlePackageToggle = (checked: boolean) => {
    setIsPackage(checked);
    if (checked) {
      setSplitMethod('PACKAGE');
      setCategory('PACKAGE');
    } else if (splitMethod === 'PACKAGE') {
      setSplitMethod('EQUAL');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const startSession = captureAuthSessionSnapshot();
    const requestTripId = tripId;
    if (!startSession.hasAccessToken || !startSession.userId) {
      setError('You must be signed in to record an expense.');
      return;
    }

    setError(null);
    setSubmitting(true);

    const canUpdateModalUi = () =>
      isMountedRef.current &&
      activeTripIdRef.current === requestTripId &&
      isSameAuthSession(startSession, { requireAuthenticated: true });

    try {
      let computedAmountPaisa = 0;
      let packageRatePerPersonPaisa: number | undefined;

      if (splitMethod === 'PACKAGE' && packageRateNpr.trim()) {
        packageRatePerPersonPaisa = nprToPaisa(packageRateNpr);
        computedAmountPaisa = packageRatePerPersonPaisa * selectedParticipantIds.length;
      } else {
        computedAmountPaisa = nprToPaisa(amountNpr);
      }

      // Build payments array
      let payments: Array<{ participantId: string; amountPaisa: number; paymentMethod: PaymentMethod }> = [];
      if (payerMode === 'SINGLE') {
        payments = [
          {
            participantId: singlePayerId,
            amountPaisa: computedAmountPaisa,
            paymentMethod,
          },
        ];
      } else {
        for (const [pId, val] of Object.entries(multiPayerAmounts)) {
          if (val && val.trim() !== '' && Number(val) > 0) {
            payments.push({
              participantId: pId,
              amountPaisa: nprToPaisa(val),
              paymentMethod,
            });
          }
        }
        const sumPaid = payments.reduce((acc, p) => acc + p.amountPaisa, 0);
        if (sumPaid !== computedAmountPaisa) {
          throw new Error(
            `Multiple payer contributions (${formatPaisaToNPR(sumPaid)}) must equal total expense (${formatPaisaToNPR(computedAmountPaisa)}).`
          );
        }
      }

      const clientMutationId = generateUUID();

      const customShares =
        splitMethod === 'CUSTOM'
          ? Object.entries(customShareNpr)
              .filter(([, v]) => v && v.trim() !== '' && Number(v) > 0)
              .map(([participantId, v]) => ({
                participantId,
                amountPaisa: nprToPaisa(v),
              }))
          : undefined;

      const weights =
        splitMethod === 'WEIGHTED'
          ? selectedParticipantIds.map((participantId) => ({
              participantId,
              weight: Number.parseFloat(weightOverrides[participantId] || '1') || 1,
            }))
          : undefined;

      const payload = {
        title: title.trim(),
        category,
        amountPaisa: computedAmountPaisa,
        isEstimated,
        isPackage: isPackage || splitMethod === 'PACKAGE',
        packageRatePerPersonPaisa,
        splitMethod,
        paymentMethod,
        incurredAt: new Date().toISOString(),
        payments,
        includedParticipantIds: selectedParticipantIds,
        includedFamilyIds: splitMethod === 'PER_FAMILY' ? selectedFamilyIds : undefined,
        customShares,
        weights,
        clientMutationId,
      };

      if (!isOnline) {
        if (!isSameAuthSession(startSession, { requireAuthenticated: true })) {
          return;
        }
        const queued = await enqueueExpense({
          userId: startSession.userId,
          clientMutationId,
          tripId: requestTripId,
          tripName,
          payload,
        });
        if (!queued) {
          if (canUpdateModalUi()) {
            setError('Unable to queue offline expense for the current session.');
          }
          return;
        }
        if (canUpdateModalUi()) {
          onClose();
        }
        return;
      }

      try {
        await apiRequest(`/trips/${requestTripId}/expenses`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (!isSameAuthSession(startSession, { requireAuthenticated: true })) {
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: ['trip', requestTripId, startSession.userId],
        });
        await queryClient.invalidateQueries({ queryKey: ['dashboard', startSession.userId] });
        if (canUpdateModalUi()) {
          onClose();
        }
      } catch (err) {
        if (!isSameAuthSession(startSession, { requireAuthenticated: true })) {
          return;
        }
        // If network dropped mid-flight, queue offline automatically
        if (err instanceof TypeError) {
          const queued = await enqueueExpense({
            userId: startSession.userId,
            clientMutationId,
            tripId: requestTripId,
            tripName,
            payload,
          });
          if (!queued) {
            if (canUpdateModalUi()) {
              setError('Unable to queue offline expense for the current session.');
            }
            return;
          }
          if (canUpdateModalUi()) {
            onClose();
          }
          return;
        }
        throw err;
      }
    } catch (err) {
      if (canUpdateModalUi()) {
        setError(err instanceof Error ? err.message : 'Failed to save expense');
      }
    } finally {
      if (canUpdateModalUi()) {
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-xl rounded-t-3xl sm:rounded-2xl border border-slate-200 shadow-xl max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900">Quick-Add Expense</h2>
            <p className="text-[11px] text-slate-500">
              {isOnline ? 'Saves directly to ledger' : 'Offline Mode — Will queue locally & sync automatically'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4">
          {error && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs font-medium text-rose-700">
              {error}
            </div>
          )}

          {/* Title & Category */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Expense Name *
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Highway Fuel, Lunch, Resort Package"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:border-blue-600 focus:outline-none"
              >
                {EXPENSE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {EXPENSE_CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Package or Standard Amount */}
          {tripMode === 'FAMILY' && (
            <div className="flex items-center gap-4 bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
              <label className="flex items-center gap-2 font-medium text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPackage}
                  onChange={(e) => handlePackageToggle(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600"
                />
                <span>Fixed Per-Person Package Expense (e.g., Resort NPR 3,000/person)</span>
              </label>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {splitMethod === 'PACKAGE' ? (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Package Rate Per Person (NPR) *
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  required
                  value={packageRateNpr}
                  onChange={(e) => setPackageRateNpr(e.target.value)}
                  placeholder="e.g., 3000"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums focus:border-blue-600 focus:outline-none"
                />
                <p className="text-[11px] text-blue-600 font-mono mt-1">
                  Total for {selectedParticipantIds.length} members: NPR{' '}
                  {(Number(packageRateNpr || 0) * selectedParticipantIds.length).toLocaleString('en-IN')}
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Total Amount (NPR) *
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  required
                  value={amountNpr}
                  onChange={(e) => setAmountNpr(e.target.value)}
                  placeholder="e.g., 5000"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums focus:border-blue-600 focus:outline-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Payment Method
              </label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:border-blue-600 focus:outline-none"
              >
                {PAYMENT_METHODS.map((pm) => (
                  <option key={pm} value={pm}>
                    {PAYMENT_METHOD_LABELS[pm]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Forgotten Expense Protection: Estimated / Pending Confirmation Checkbox */}
          <div className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isEstimated}
                onChange={(e) => setIsEstimated(e.target.checked)}
                className="rounded border-slate-300 text-amber-600"
              />
              <span>Mark as Estimated / Pending Confirmation (update exact amount later)</span>
            </label>
          </div>

          {/* Payer Configuration: Single vs Multiple Payers */}
          <div className="border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Who Paid?
              </label>
              <div className="flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-semibold">
                <button
                  type="button"
                  onClick={() => setPayerMode('SINGLE')}
                  className={`px-2.5 py-1 rounded-md ${
                    payerMode === 'SINGLE'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600'
                  }`}
                >
                  Single Payer
                </button>
                <button
                  type="button"
                  onClick={() => setPayerMode('MULTIPLE')}
                  className={`px-2.5 py-1 rounded-md ${
                    payerMode === 'MULTIPLE'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600'
                  }`}
                >
                  Multiple Payers
                </button>
              </div>
            </div>

            {payerMode === 'SINGLE' ? (
              <select
                value={singlePayerId}
                onChange={(e) => setSinglePayerId(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                {activeParticipants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.role})
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2 bg-slate-50 p-3 rounded-xl border border-slate-200 max-h-44 overflow-y-auto">
                {activeParticipants.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-800">{p.name}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="NPR 0"
                      value={multiPayerAmounts[p.id] ?? ''}
                      onChange={(e) =>
                        setMultiPayerAmounts((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                      className="w-28 rounded-lg border border-slate-300 px-2.5 py-1 text-right font-mono tabular-nums bg-white"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Splitting Strategy Selector */}
          <div className="border-t border-slate-100 pt-3">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              Splitting Method
            </label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {(
                [
                  { id: 'EQUAL', label: 'Equal' },
                  { id: 'SELECTIVE', label: 'Selective' },
                  { id: 'CUSTOM', label: 'Custom Amounts' },
                  { id: 'WEIGHTED', label: 'Weighted' },
                  ...(tripMode === 'FAMILY'
                    ? [
                        { id: 'PER_FAMILY', label: 'Per-Family' },
                        { id: 'PACKAGE', label: 'Fixed Package' },
                      ]
                    : []),
                ] as Array<{ id: SplitMethod; label: string }>
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSplitMethod(m.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    splitMethod === m.id
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {splitMethod === 'PER_FAMILY' && families.length > 0 ? (
              <div className="space-y-1.5 bg-slate-50 p-3 rounded-xl border border-slate-200">
                <p className="text-[11px] font-semibold text-slate-600 mb-1">
                  Select Families Included in Split:
                </p>
                {families.map((fam) => (
                  <label
                    key={fam.id}
                    className="flex items-center justify-between text-xs py-1 cursor-pointer"
                  >
                    <span className="font-medium text-slate-800">{fam.name}</span>
                    <input
                      type="checkbox"
                      checked={selectedFamilyIds.includes(fam.id)}
                      onChange={() => toggleFamily(fam.id)}
                      className="rounded border-slate-300 text-blue-600"
                    />
                  </label>
                ))}
              </div>
            ) : (
              <div className="space-y-2 bg-slate-50 p-3 rounded-xl border border-slate-200 max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between text-[11px] text-slate-500 pb-1 border-b border-slate-200">
                  <span>Participants ({selectedParticipantIds.length} selected)</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedParticipantIds(
                        selectedParticipantIds.length === activeParticipants.length
                          ? []
                          : activeParticipants.map((p) => p.id)
                      )
                    }
                    className="text-blue-600 font-semibold"
                  >
                    {selectedParticipantIds.length === activeParticipants.length
                      ? 'Clear All'
                      : 'Select All'}
                  </button>
                </div>

                {activeParticipants.map((p) => {
                  const isIncluded = selectedParticipantIds.includes(p.id);
                  return (
                    <div key={p.id} className="flex items-center justify-between gap-2 text-xs py-1">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isIncluded}
                          onChange={() => toggleParticipant(p.id)}
                          className="rounded border-slate-300 text-blue-600"
                        />
                        <span className="font-medium text-slate-800">{p.name}</span>
                        {p.memberType !== 'ADULT' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">
                            {p.memberType}
                          </span>
                        )}
                      </label>

                      {splitMethod === 'CUSTOM' && isIncluded && (
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="NPR Share"
                          value={customShareNpr[p.id] ?? ''}
                          onChange={(e) =>
                            setCustomShareNpr((prev) => ({
                              ...prev,
                              [p.id]: e.target.value,
                            }))
                          }
                          className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-right font-mono tabular-nums bg-white"
                        />
                      )}

                      {splitMethod === 'WEIGHTED' && isIncluded && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-slate-500">Weight:</span>
                          <input
                            type="number"
                            step="0.25"
                            min="0.1"
                            value={weightOverrides[p.id] ?? '1'}
                            onChange={(e) =>
                              setWeightOverrides((prev) => ({
                                ...prev,
                                [p.id]: e.target.value,
                              }))
                            }
                            className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-right font-mono bg-white"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-xs font-semibold text-white shadow-sm"
            >
              {submitting ? 'Saving...' : isOnline ? 'Save Expense' : 'Queue Expense Offline'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
