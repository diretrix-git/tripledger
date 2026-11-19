import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  KeyRound,
  Package,
  Plus,
  Share2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  UsersRound,
  XCircle,
} from 'lucide-react';
import {
  DEFAULT_PARTICIPANT_INVITE_TTL_HOURS,
  EXPENSE_CATEGORY_LABELS,
  formatPaisaToNPR,
  isPrivilegedTripRole,
  MEMBER_TYPES,
  nprToPaisa,
  paisaToNprString,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  TRIP_ROLES,
  type ChecklistItem,
  type CreateParticipantInviteResponse,
  type ExpenseCategory,
  type ExpenseRecord,
  type FamilyBalanceSummary,
  type FamilyEntity,
  type IndividualBalanceSummary,
  type MemberType,
  type ParticipantEntity,
  type ParticipantInviteEntity,
  type PaymentMethod,
  type SettlementMode,
  type SettlementRecord,
  type SettlementSuggestion,
  type TripRole,
  type TripSummaryEntity,
} from '@tripledger/shared';
import { ApiClientError, apiRequest } from '../api/client.js';
import { QuickAddExpenseModal } from '../components/expenses/QuickAddExpenseModal.js';
import {
  exportTripReportToExcel,
  exportTripReportToPDF,
} from '../utils/exportReport.js';
import { useAuthStore } from '../stores/authStore.js';
import { useOfflineQueueStore } from '../stores/offlineQueueStore.js';

interface TripDetailResponse {
  trip: TripSummaryEntity;
  myParticipant: {
    id: string;
    name: string;
    role: TripRole;
    familyId: string | null;
  };
  participants: ParticipantEntity[];
  families: FamilyEntity[];
  expenses: ExpenseRecord[];
  settlements: SettlementRecord[];
  ledger: {
    totalApprovedExpensePaisa: number;
    totalPackageExpensePaisa: number;
    totalAdditionalExpensePaisa: number;
    totalPendingExpensePaisa: number;
    totalConfirmedSettlementPaisa: number;
    individualBalances: IndividualBalanceSummary[];
    familyBalances: FamilyBalanceSummary[];
    ungroupedParticipantBalances: IndividualBalanceSummary[];
  };
  individualSettlementSuggestions: SettlementSuggestion[];
  familySettlementSuggestions: SettlementSuggestion[];
}

export function TripDetailPage(): React.ReactElement {
  const { tripId } = useParams<{ tripId: string }>();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const tripEpochRef = useRef(0);
  const lastTripIdRef = useRef(tripId);
  if (lastTripIdRef.current !== tripId) {
    lastTripIdRef.current = tripId;
    tripEpochRef.current += 1;
  }
  const activeContextRef = useRef({ tripId, sessionGeneration });
  activeContextRef.current = { tripId, sessionGeneration };
  const allOfflineQueue = useOfflineQueueStore((s) => s.queue);
  const offlineQueue = useMemo(
    () =>
      allOfflineQueue.filter(
        (q) => q.tripId === tripId && Boolean(currentUser?.id) && q.userId === currentUser?.id
      ),
    [allOfflineQueue, currentUser?.id, tripId]
  );

  const [activeTab, setActiveTab] = useState<
    'OVERVIEW' | 'EXPENSES' | 'PARTICIPANTS' | 'SETTLEMENTS' | 'CHECKLIST' | 'REPORTS'
  >('OVERVIEW');
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [copiedBanner, setCopiedBanner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Add Participant state (guests are strictly restricted to PARTICIPANT)
  const [newParticipantName, setNewParticipantName] = useState('');
  const [newParticipantEmail, setNewParticipantEmail] = useState('');
  const [newParticipantType, setNewParticipantType] = useState<MemberType>('ADULT');
  const [newParticipantFamilyId, setNewParticipantFamilyId] = useState('');
  const [newParticipantWeight, setNewParticipantWeight] = useState('1');

  // Organizer Role Invitations state
  const [inviteParticipantId, setInviteParticipantId] = useState('');
  const [inviteRole, setInviteRole] = useState<TripRole>('ORGANIZER');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteTtlHours, setInviteTtlHours] = useState<number>(DEFAULT_PARTICIPANT_INVITE_TTL_HOURS);
  const [issuingInvite, setIssuingInvite] = useState(false);
  const [issuedInviteSecret, setIssuedInviteSecret] = useState<{
    participantName: string;
    grantedRole: TripRole;
    intendedEmail: string | null;
    claimUrl: string;
    rawToken: string;
    emailSent: boolean;
  } | null>(null);

  // Add Family state
  const [newFamilyName, setNewFamilyName] = useState('');
  const [newFamilyRepId, setNewFamilyRepId] = useState('');

  // Settlement Form state
  const [settlementViewMode, setSettlementViewMode] = useState<SettlementMode>('INDIVIDUAL');
  const [settleFromId, setSettleFromId] = useState('');
  const [settleToId, setSettleToId] = useState('');
  const [settleAmountNpr, setSettleAmountNpr] = useState('');
  const [settleMethod, setSettleMethod] = useState<PaymentMethod>('ESEWA');
  const [settleNote, setSettleNote] = useState('');

  useEffect(() => {
    setActiveTab('OVERVIEW');
    setShowAddExpense(false);
    setCopiedBanner(null);
    setActionError(null);
    setNewParticipantName('');
    setNewParticipantEmail('');
    setNewParticipantType('ADULT');
    setNewParticipantFamilyId('');
    setNewParticipantWeight('1');
    setInviteParticipantId('');
    setInviteRole('ORGANIZER');
    setInviteEmail('');
    setIssuingInvite(false);
    setIssuedInviteSecret(null);
    setNewFamilyName('');
    setNewFamilyRepId('');
    setSettlementViewMode('INDIVIDUAL');
    setSettleFromId('');
    setSettleToId('');
    setSettleAmountNpr('');
    setSettleMethod('ESEWA');
    setSettleNote('');
  }, [tripId, sessionGeneration]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['trip', tripId, currentUser?.id ?? null],
    queryFn: () => apiRequest<TripDetailResponse>(`/trips/${tripId}`),
    enabled: Boolean(tripId && accessToken),
  });

  const invitesQuery = useQuery({
    queryKey: ['trip-invites', tripId, currentUser?.id ?? null],
    queryFn: () => apiRequest<{ invites: ParticipantInviteEntity[] }>(`/trips/${tripId}/invites`),
    enabled: Boolean(tripId && accessToken && data?.myParticipant?.role === 'ORGANIZER'),
  });

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-32 bg-slate-200 rounded-2xl" />
        <div className="h-96 bg-slate-200 rounded-2xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-2xl p-6 text-rose-700 text-sm">
        {error instanceof Error ? error.message : 'Unable to load trip details.'}
      </div>
    );
  }

  const {
    trip,
    myParticipant,
    participants,
    families,
    expenses,
    settlements,
    ledger,
    individualSettlementSuggestions,
    familySettlementSuggestions,
  } = data;

  const isOrganizer = myParticipant.role === 'ORGANIZER';
  const myParticipantRecord = participants.find((p) => p.id === myParticipant.id);
  const canAddExpense =
    trip.status !== 'CLOSED' &&
    ['ORGANIZER', 'CONTRIBUTOR', 'FAMILY_REP'].includes(myParticipant.role);

  const activeParticipants = participants.filter((p) => p.isActive);
  const participantMap = new Map(participants.map((p) => [p.id, p]));
  const familyMap = new Map(families.map((f) => [f.id, f]));
  const participantNameMap = new Map(participants.map((p) => [p.id, p.name]));
  const familyNameMap = new Map(families.map((f) => [f.id, f.name]));

  const copyToClipboard = (text: string, label: string) => {
    const fallbackCopy = () => {
      if (typeof document === 'undefined') return;
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      try {
        textarea.select();
        document.execCommand('copy');
      } catch {
        // ignore fallback copy errors
      } finally {
        document.body.removeChild(textarea);
      }
    };

    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      void navigator.clipboard.writeText(text).catch(() => {
        fallbackCopy();
      });
    } else {
      fallbackCopy();
    }
    setCopiedBanner(label);
    setTimeout(() => setCopiedBanner(null), 2500);
  };

  const runScopedTripMutation = async <T,>(opts: {
    action: () => Promise<T>;
    onSuccess?: (result: T) => void;
    invalidateKeys?: readonly unknown[][];
    fallbackErrorMessage: string;
    onError?: (err: unknown) => string;
    onFinallySameContext?: () => void;
  }) => {
    const startTripId = tripId;
    const startEpoch = tripEpochRef.current;
    const startGeneration = useAuthStore.getState().sessionGeneration;
    const isSameContext = () => {
      const current = activeContextRef.current;
      return (
        current.tripId === startTripId &&
        tripEpochRef.current === startEpoch &&
        current.sessionGeneration === startGeneration &&
        useAuthStore.getState().sessionGeneration === startGeneration
      );
    };

    setActionError(null);
    try {
      const result = await opts.action();
      if (isSameContext()) {
        opts.onSuccess?.(result);
      }
      if (
        opts.invalidateKeys &&
        useAuthStore.getState().sessionGeneration === startGeneration
      ) {
        await Promise.all(
          opts.invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
        );
      }
    } catch (err) {
      if (isSameContext()) {
        const message = opts.onError
          ? opts.onError(err)
          : err instanceof Error
            ? err.message
            : opts.fallbackErrorMessage;
        setActionError(message);
      }
      if (
        err instanceof ApiClientError &&
        err.code === 'EMAIL_DELIVERY_FAILED' &&
        opts.invalidateKeys &&
        useAuthStore.getState().sessionGeneration === startGeneration
      ) {
        await Promise.all(
          opts.invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
        );
      }
    } finally {
      if (isSameContext()) {
        opts.onFinallySameContext?.();
      }
    }
  };

  const handleAddParticipant = async (e: React.FormEvent) => {
    e.preventDefault();
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/participants`, {
          method: 'POST',
          body: JSON.stringify({
            name: newParticipantName,
            email: newParticipantEmail || undefined,
            role: 'PARTICIPANT',
            memberType: newParticipantType,
            familyId: newParticipantFamilyId || null,
            defaultWeight: Number.parseFloat(newParticipantWeight) || 1,
          }),
        }),
      onSuccess: () => {
        setNewParticipantName('');
        setNewParticipantEmail('');
      },
      invalidateKeys: [['trip', requestTripId]],
      fallbackErrorMessage: 'Failed to add participant',
    });
  };

  const handleIssueParticipantInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteParticipantId) {
      setActionError('Select a participant to issue an invitation for.');
      return;
    }
    if (isPrivilegedTripRole(inviteRole) && !inviteEmail.trim()) {
      setActionError(`An intended email address is required for ${inviteRole} invitations.`);
      return;
    }

    const requestTripId = trip.id;
    const participantNames = new Map(participantNameMap);
    setIssuingInvite(true);
    await runScopedTripMutation({
      action: () =>
        apiRequest<CreateParticipantInviteResponse>(
          `/trips/${requestTripId}/participants/${inviteParticipantId}/invites`,
          {
            method: 'POST',
            body: JSON.stringify({
              grantedRole: inviteRole,
              intendedEmail: inviteEmail.trim() || undefined,
              expiresInHours: inviteTtlHours,
            }),
          }
        ),
      onSuccess: (res) => {
        setIssuedInviteSecret({
          participantName: participantNames.get(res.invite.participantId) ?? 'Participant',
          grantedRole: res.invite.grantedRole,
          intendedEmail: res.invite.intendedEmail,
          claimUrl: res.claimUrl,
          rawToken: res.rawToken,
          emailSent: Boolean(res.emailDelivery?.sent),
        });
        setInviteEmail('');
      },
      invalidateKeys: [['trip-invites', requestTripId]],
      fallbackErrorMessage: 'Failed to issue invitation',
      onError: (err) => {
        if (err instanceof ApiClientError && err.code === 'EMAIL_DELIVERY_FAILED') {
          return `Email delivery failed (${err.message}). This invitation and any prior pending invitation for this participant are now revoked; issue a new invitation to retry.`;
        }
        return err instanceof Error ? err.message : 'Failed to issue invitation';
      },
      onFinallySameContext: () => {
        setIssuingInvite(false);
      },
    });
  };

  const handleRevokeInvite = async (inviteId: string) => {
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/invites/${inviteId}/revoke`, { method: 'POST' }),
      invalidateKeys: [['trip-invites', requestTripId]],
      fallbackErrorMessage: 'Failed to revoke invitation',
    });
  };

  const handleAddFamily = async (e: React.FormEvent) => {
    e.preventDefault();
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/families`, {
          method: 'POST',
          body: JSON.stringify({
            name: newFamilyName,
            representativeId: newFamilyRepId || null,
            defaultWeight: 1,
          }),
        }),
      onSuccess: () => {
        setNewFamilyName('');
        setNewFamilyRepId('');
      },
      invalidateKeys: [['trip', requestTripId]],
      fallbackErrorMessage: 'Failed to create family group',
    });
  };

  const handleApproveExpense = async (
    expenseId: string,
    approvalStatus: 'APPROVED' | 'REJECTED',
    actualAmountPaisa?: number
  ) => {
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/expenses/${expenseId}/approve`, {
          method: 'POST',
          body: JSON.stringify({ approvalStatus, actualAmountPaisa }),
        }),
      invalidateKeys: [['trip', requestTripId]],
      fallbackErrorMessage: 'Failed to update expense status',
    });
  };

  const handleDeleteExpense = async (expenseId: string) => {
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/expenses/${expenseId}`, {
          method: 'DELETE',
        }),
      invalidateKeys: [['trip', requestTripId]],
      fallbackErrorMessage: 'Failed to remove expense',
    });
  };

  const handleRecordSettlement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (trip.status === 'CLOSED') {
      return;
    }
    const requestTripId = trip.id;
    const settlementMode = trip.mode === 'FAMILY' ? settlementViewMode : 'INDIVIDUAL';
    await runScopedTripMutation({
      action: async () => {
        const amountPaisa = nprToPaisa(settleAmountNpr);
        return apiRequest(`/trips/${requestTripId}/settlements`, {
          method: 'POST',
          body: JSON.stringify({
            settlementMode,
            fromParticipantId: settleFromId,
            toParticipantId: settleToId,
            amountPaisa,
            paymentMethod: settleMethod,
            status: isOrganizer ? 'CONFIRMED' : 'REPORTED',
            referenceNote: settleNote || undefined,
          }),
        });
      },
      onSuccess: () => {
        setSettleAmountNpr('');
        setSettleNote('');
      },
      invalidateKeys: [['trip', requestTripId], ['dashboard']],
      fallbackErrorMessage: 'Failed to record settlement',
    });
  };

  const handlePrefillSuggestion = (s: SettlementSuggestion) => {
    if (trip.status === 'CLOSED') {
      return;
    }
    setSettlementViewMode(trip.mode === 'FAMILY' ? s.mode : 'INDIVIDUAL');
    setSettleFromId(s.fromParticipantId);
    setSettleToId(s.toParticipantId);
    setSettleAmountNpr(paisaToNprString(s.amountPaisa));
    setActiveTab('SETTLEMENTS');
  };

  const handleConfirmSettlement = async (
    settlementId: string,
    status: 'CONFIRMED' | 'REJECTED'
  ) => {
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/settlements/${settlementId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        }),
      invalidateKeys: [['trip', requestTripId], ['dashboard']],
      fallbackErrorMessage: 'Failed to update settlement',
    });
  };

  const handleChecklistToggle = async (
    category: ExpenseCategory,
    field: 'checked' | 'notApplicable',
    value: boolean
  ) => {
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/checklist`, {
          method: 'PATCH',
          body: JSON.stringify({
            category,
            [field]: value,
            ...(field === 'checked' && value ? { notApplicable: false } : {}),
            ...(field === 'notApplicable' && value ? { checked: false } : {}),
          }),
        }),
      invalidateKeys: [['trip', requestTripId]],
      fallbackErrorMessage: 'Failed to update checklist',
    });
  };

  const handleCloseTrip = async () => {
    const requestTripId = trip.id;
    await runScopedTripMutation({
      action: () =>
        apiRequest(`/trips/${requestTripId}/close`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      invalidateKeys: [['trip', requestTripId], ['dashboard']],
      fallbackErrorMessage: 'Cannot close trip yet',
    });
  };

  const myBalance = ledger.individualBalances.find(
    (b) => b.participantId === myParticipant.id
  );

  return (
    <div className="space-y-6">
      {/* Top Trip Header Card */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${
                  trip.mode === 'FAMILY'
                    ? 'bg-purple-50 text-purple-700 border border-purple-200'
                    : 'bg-blue-50 text-blue-700 border border-blue-200'
                }`}
              >
                {trip.mode === 'FAMILY' ? (
                  <UsersRound className="w-3.5 h-3.5" />
                ) : (
                  <Users className="w-3.5 h-3.5" />
                )}
                {trip.mode} MODE
              </span>
              <span
                className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${
                  trip.status === 'CLOSED'
                    ? 'bg-slate-200 text-slate-700'
                    : 'bg-emerald-50 text-emerald-700'
                }`}
              >
                {trip.status}
              </span>
              <span className="text-xs text-slate-500">
                Your Role: <strong className="text-slate-800">{myParticipant.role}</strong>
              </span>
            </div>

            <h1 className="text-2xl font-bold tracking-tight text-slate-900 mt-2">
              {trip.name}
            </h1>
            {trip.description && (
              <p className="text-xs text-slate-600 mt-1">{trip.description}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isOrganizer && trip.inviteCode && (
              <button
                onClick={() => copyToClipboard(trip.inviteCode!, 'Invite code copied!')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-mono font-semibold text-slate-700"
                title="Copy Invite Code"
              >
                <Copy className="w-3.5 h-3.5 text-slate-500" />
                <span>Code: {trip.inviteCode}</span>
              </button>
            )}

            <button
              onClick={() =>
                copyToClipboard(
                  `${window.location.origin}/shared/${trip.shareToken}`,
                  'Public read-only report link copied!'
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700"
            >
              <Share2 className="w-3.5 h-3.5 text-blue-600" />
              <span>Share Summary</span>
            </button>

            {canAddExpense && (
              <button
                onClick={() => setShowAddExpense(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm"
              >
                <Plus className="w-4 h-4" />
                <span>Quick-Add Expense</span>
              </button>
            )}
          </div>
        </div>

        {copiedBanner && (
          <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-xs font-medium text-emerald-800 inline-block">
            {copiedBanner}
          </div>
        )}

        {/* Financial KPI Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-5 border-t border-slate-100">
          <div>
            <span className="text-[11px] font-medium text-slate-500 block">
              Total Approved Spend
            </span>
            <span className="text-lg font-bold font-mono tabular-nums text-slate-900">
              {formatPaisaToNPR(ledger.totalApprovedExpensePaisa)}
            </span>
            {trip.budgetPaisa ? (
              <span className="text-[11px] text-slate-500 block font-mono">
                Budget: {formatPaisaToNPR(trip.budgetPaisa)}
              </span>
            ) : null}
          </div>

          {trip.mode === 'FAMILY' ? (
            <div>
              <span className="text-[11px] font-medium text-slate-500 block">
                Packages vs Additional
              </span>
              <span className="text-xs font-mono font-semibold text-slate-800 block mt-1">
                Pkg: {formatPaisaToNPR(ledger.totalPackageExpensePaisa)}
              </span>
              <span className="text-xs font-mono text-slate-600 block">
                Add&apos;l: {formatPaisaToNPR(ledger.totalAdditionalExpensePaisa)}
              </span>
            </div>
          ) : (
            <div>
              <span className="text-[11px] font-medium text-slate-500 block">
                Your Contribution Paid
              </span>
              <span className="text-lg font-bold font-mono tabular-nums text-slate-900">
                {formatPaisaToNPR(myBalance?.totalPaidPaisa ?? 0)}
              </span>
            </div>
          )}

          <div>
            <span className="text-[11px] font-medium text-slate-500 block">
              Your Expense Share
            </span>
            <span className="text-lg font-bold font-mono tabular-nums text-slate-900">
              {formatPaisaToNPR(myBalance?.totalSharePaisa ?? 0)}
            </span>
          </div>

          <div>
            <span className="text-[11px] font-medium text-slate-500 block">
              Your Net Balance
            </span>
            <span
              className={`text-lg font-bold font-mono tabular-nums ${
                (myBalance?.outstandingBalancePaisa ?? 0) > 0
                  ? 'text-emerald-600'
                  : (myBalance?.outstandingBalancePaisa ?? 0) < 0
                    ? 'text-rose-600'
                    : 'text-slate-800'
              }`}
            >
              {formatPaisaToNPR(myBalance?.outstandingBalancePaisa ?? 0, { showSign: true })}
            </span>
            <span className="text-[10px] text-slate-500 block">
              {(myBalance?.outstandingBalancePaisa ?? 0) > 0
                ? 'You are owed money'
                : (myBalance?.outstandingBalancePaisa ?? 0) < 0
                  ? 'You owe money'
                  : 'Settled'}
            </span>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-3.5 text-xs font-medium text-rose-700 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-rose-500 font-bold">
            Dismiss
          </button>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex overflow-x-auto gap-1.5 border-b border-slate-200 pb-2">
        {(
          [
            { id: 'OVERVIEW', label: 'Balances & Overview' },
            { id: 'EXPENSES', label: `Expenses (${expenses.length + offlineQueue.length})` },
            {
              id: 'PARTICIPANTS',
              label:
                trip.mode === 'FAMILY'
                  ? `Families (${families.length}) & Members (${participants.length})`
                  : `Participants (${participants.length})`,
            },
            { id: 'SETTLEMENTS', label: `Settlements (${settlements.length})` },
            { id: 'CHECKLIST', label: 'Forgotten Expense Checklist' },
            { id: 'REPORTS', label: 'Reports & Export' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-200/70'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: OVERVIEW & BALANCES */}
      {activeTab === 'OVERVIEW' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Family Mode: Family-Level Aggregate Balances */}
            {trip.mode === 'FAMILY' && ledger.familyBalances.length > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <h2 className="text-sm font-bold text-slate-900 mb-3">
                  Family-Level Aggregate Balances
                </h2>
                <div className="space-y-3">
                  {ledger.familyBalances.map((fam) => {
                    const designatedRepId = familyMap.get(fam.familyId)?.representativeId ?? null;
                    const designatedRepName = designatedRepId
                      ? participantNameMap.get(designatedRepId) ?? null
                      : null;

                    return (
                    <div
                      key={fam.familyId}
                      className="rounded-xl border border-slate-200 p-3.5 bg-slate-50/60"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-bold text-sm text-slate-900">
                            {fam.familyName}
                          </span>
                          <span className="text-xs text-slate-500 ml-2">
                            Rep: {designatedRepName ?? 'Unassigned'} • {fam.memberCount} members
                          </span>
                        </div>
                        <span
                          className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold tabular-nums ${
                            fam.outstandingBalancePaisa > 0
                              ? 'bg-emerald-50 text-emerald-700'
                              : fam.outstandingBalancePaisa < 0
                                ? 'bg-rose-50 text-rose-700'
                                : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {formatPaisaToNPR(fam.outstandingBalancePaisa, { showSign: true })}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-4 text-[11px] text-slate-600 font-mono">
                        <span>Paid: {formatPaisaToNPR(fam.totalPaidPaisa)}</span>
                        <span>Share: {formatPaisaToNPR(fam.totalSharePaisa)}</span>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Individual Participant Balances Table */}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-bold text-slate-900 mb-3">
                Individual Participant Balances
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
                        <td className="py-2.5">
                          <span className="font-semibold text-slate-900 block">
                            {b.participantName}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            {b.familyName ? `${b.familyName} • ` : ''}
                            {b.role}
                          </span>
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-slate-700">
                          {formatPaisaToNPR(b.totalPaidPaisa)}
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-slate-700">
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
          </div>

          {/* Right Column: Optimized Settlement Suggestions */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-900">
                  Suggested Settlements
                </h2>
                {trip.mode === 'FAMILY' && (
                  <div className="flex rounded-lg bg-slate-100 p-0.5 text-[10px] font-bold">
                    <button
                      onClick={() => setSettlementViewMode('FAMILY')}
                      className={`px-2 py-1 rounded ${
                        settlementViewMode === 'FAMILY'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600'
                      }`}
                    >
                      Family
                    </button>
                    <button
                      onClick={() => setSettlementViewMode('INDIVIDUAL')}
                      className={`px-2 py-1 rounded ${
                        settlementViewMode === 'INDIVIDUAL'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600'
                      }`}
                    >
                      Individual
                    </button>
                  </div>
                )}
              </div>

              {(() => {
                const suggestions =
                  trip.mode === 'FAMILY' && settlementViewMode === 'FAMILY'
                    ? familySettlementSuggestions
                    : individualSettlementSuggestions;

                if (suggestions.length === 0) {
                  return (
                    <div className="text-center py-6 text-xs text-slate-500">
                      <CheckCircle2 className="w-7 h-7 text-emerald-500 mx-auto mb-1.5" />
                      <p className="font-semibold text-slate-800">Everyone is settled!</p>
                      <p>No outstanding balances remain.</p>
                    </div>
                  );
                }

                return (
                  <div className="space-y-2.5">
                    {suggestions.map((s, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <p className="font-semibold text-slate-900">
                            {s.fromFamilyName
                              ? `${s.fromFamilyName} (${s.fromParticipantName})`
                              : s.fromParticipantName}{' '}
                            <span className="text-slate-400 font-normal">pays</span>{' '}
                            {s.toFamilyName
                              ? `${s.toFamilyName} (${s.toParticipantName})`
                              : s.toParticipantName}
                          </p>
                          <p className="font-mono font-bold text-blue-600 tabular-nums mt-0.5">
                            {formatPaisaToNPR(s.amountPaisa)}
                          </p>
                        </div>
                        {trip.status !== 'CLOSED' && (
                          <button
                            onClick={() => handlePrefillSuggestion(s)}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold shrink-0"
                          >
                            Settle
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: EXPENSES (INCLUDING FIXED PACKAGES & OFFLINE QUEUE) */}
      {activeTab === 'EXPENSES' && (
        <div className="space-y-4">
          {offlineQueue.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900">
                Queued Offline Expenses ({offlineQueue.length})
              </h3>
              {offlineQueue.map((q) => (
                <div
                  key={q.clientMutationId}
                  className="bg-white rounded-xl p-3 border border-amber-200 flex items-center justify-between text-xs"
                >
                  <div>
                    <span className="font-bold text-slate-900">{q.payload.title}</span>
                    <span className="ml-2 text-amber-700 font-medium">
                      [{q.syncStatus}]
                    </span>
                  </div>
                  <span className="font-mono font-bold tabular-nums">
                    {formatPaisaToNPR(q.payload.amountPaisa)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {expenses.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-3">
              <p className="text-sm font-semibold text-slate-800">No expenses recorded yet</p>
              {canAddExpense && (
                <button
                  onClick={() => setShowAddExpense(true)}
                  className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold"
                >
                  Add First Expense
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {expenses.map((exp) => (
                <div
                  key={exp.id}
                  className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {exp.isPackage && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] font-bold">
                          <Package className="w-3 h-3" />
                          FIXED PACKAGE
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-semibold">
                        {EXPENSE_CATEGORY_LABELS[exp.category] ?? exp.category}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-semibold">
                        Split: {exp.splitMethod}
                      </span>
                      {exp.approvalStatus !== 'APPROVED' && (
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
                          {exp.approvalStatus}
                        </span>
                      )}
                    </div>

                    <h3 className="text-sm font-bold text-slate-900">{exp.title}</h3>
                    <p className="text-xs text-slate-600">
                      Paid by:{' '}
                      {exp.payments
                        .map(
                          (p) =>
                            `${participantNameMap.get(p.participantId) ?? 'Member'} (${formatPaisaToNPR(p.amountPaisa)})`
                        )
                        .join(' + ')}{' '}
                      via {PAYMENT_METHOD_LABELS[exp.paymentMethod] ?? exp.paymentMethod}
                    </p>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-3">
                    <div className="text-right">
                      <span className="text-base font-bold font-mono tabular-nums text-slate-900 block">
                        {formatPaisaToNPR(exp.amountPaisa)}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {exp.shares.length} participants included
                      </span>
                    </div>

                    {isOrganizer && (
                      <div className="flex items-center gap-1.5">
                        {(exp.approvalStatus === 'PENDING_APPROVAL' ||
                          exp.approvalStatus === 'PENDING_CONFIRMATION') && (
                          <button
                            onClick={() => void handleApproveExpense(exp.id, 'APPROVED')}
                            title="Approve / Confirm Expense"
                            className="p-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => void handleDeleteExpense(exp.id)}
                          title="Soft-Delete / Reverse Expense"
                          className="p-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: PARTICIPANTS & FAMILY GROUPS */}
      {activeTab === 'PARTICIPANTS' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Participants List & Organizer Add Form */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-bold text-slate-900 mb-3">
                Trip Participants ({participants.length})
              </h2>
              <div className="divide-y divide-slate-100">
                {participants.map((p) => (
                  <div
                    key={p.id}
                    className="py-2.5 flex items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <span className="font-bold text-slate-900">{p.name}</span>
                      {!p.userId && (
                        <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">
                          Guest
                        </span>
                      )}
                      {!p.isActive && (
                        <span className="ml-1.5 px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 text-[10px]">
                          Inactive
                        </span>
                      )}
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Role: {p.role} • Type: {p.memberType} • Weight: {p.defaultWeight}x
                        {p.familyId && ` • ${familyNameMap.get(p.familyId) ?? 'Family'}`}
                      </div>
                    </div>
                    {isOrganizer && p.isActive && trip.status !== 'CLOSED' && (
                      <button
                        type="button"
                        onClick={() => {
                          setInviteParticipantId(p.id);
                          setInviteEmail(p.email ?? '');
                        }}
                        className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-[11px] font-semibold text-slate-700 shrink-0"
                      >
                        Invite / Promote
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {isOrganizer && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
                  <UserPlus className="w-4 h-4 text-blue-600" />
                  <span>Add Guest Participant</span>
                </h3>
                <form onSubmit={handleAddParticipant} className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      required
                      value={newParticipantName}
                      onChange={(e) => setNewParticipantName(e.target.value)}
                      placeholder="Participant Name *"
                      className="rounded-xl border border-slate-300 px-3 py-2 text-xs"
                    />
                    <input
                      type="email"
                      value={newParticipantEmail}
                      onChange={(e) => setNewParticipantEmail(e.target.value)}
                      placeholder="Email (Optional — contact info)"
                      className="rounded-xl border border-slate-300 px-3 py-2 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div
                      className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-600 flex items-center"
                      title="Guest participants always start as PARTICIPANT. Grant higher roles via Role Invitations."
                    >
                      PARTICIPANT
                    </div>
                    <select
                      value={newParticipantType}
                      onChange={(e) => setNewParticipantType(e.target.value as MemberType)}
                      className="rounded-xl border border-slate-300 px-2.5 py-2 text-xs bg-white"
                    >
                      {MEMBER_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="any"
                      min="0.01"
                      value={newParticipantWeight}
                      onChange={(e) => setNewParticipantWeight(e.target.value)}
                      placeholder="Weight (1.0)"
                      className="rounded-xl border border-slate-300 px-2.5 py-2 text-xs font-mono"
                    />
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Guests are created as PARTICIPANT. Issue a verified-email role invitation below
                    to grant ORGANIZER or FAMILY_REP access.
                  </p>
                  {trip.mode === 'FAMILY' && families.length > 0 && (
                    <select
                      value={newParticipantFamilyId}
                      onChange={(e) => setNewParticipantFamilyId(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs bg-white"
                    >
                      <option value="">-- Individual (No Family Group) --</option>
                      {families.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="submit"
                    className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
                  >
                    Add Participant
                  </button>
                </form>
              </div>
            )}

            {isOrganizer && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4 text-blue-600" />
                  <span>Role Invitations &amp; Verified Promotions</span>
                </h3>

                {issuedInviteSecret && (
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3.5 text-xs text-emerald-900 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold">
                        Issued {issuedInviteSecret.grantedRole} invitation for{' '}
                        {issuedInviteSecret.participantName}
                      </span>
                      <button
                        type="button"
                        onClick={() => setIssuedInviteSecret(null)}
                        className="text-emerald-700 font-semibold hover:underline"
                      >
                        Dismiss
                      </button>
                    </div>
                    {issuedInviteSecret.emailSent && issuedInviteSecret.intendedEmail && (
                      <p className="text-[11px] text-emerald-800">
                        Verification-bound invitation email dispatched to{' '}
                        <strong>{issuedInviteSecret.intendedEmail}</strong>.
                      </p>
                    )}
                    <p className="text-[11px] text-emerald-800">
                      This one-time invite link will not be shown again once dismissed.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(issuedInviteSecret.claimUrl, 'Invitation link copied!')
                        }
                        className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-[11px] inline-flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Copy Invite Link</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(issuedInviteSecret.rawToken, 'Invitation token copied!')
                        }
                        className="px-2.5 py-1 rounded-lg border border-emerald-300 bg-white text-emerald-900 font-semibold text-[11px]"
                      >
                        Copy Token
                      </button>
                    </div>
                  </div>
                )}

                {trip.status !== 'CLOSED' && (
                  <form onSubmit={handleIssueParticipantInvite} className="space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <select
                        required
                        aria-label="Target Participant"
                        value={inviteParticipantId}
                        onChange={(e) => {
                          const selected = participants.find((pt) => pt.id === e.target.value);
                          setInviteParticipantId(e.target.value);
                          if (selected?.email) setInviteEmail(selected.email);
                        }}
                        className="rounded-xl border border-slate-300 px-2.5 py-2 text-xs bg-white"
                      >
                        <option value="">-- Select Participant * --</option>
                        {participants
                          .filter((p) => p.isActive)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.role}
                              {p.userId ? '' : ' • Guest'})
                            </option>
                          ))}
                      </select>

                      <select
                        aria-label="Invitation Role"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as TripRole)}
                        className="rounded-xl border border-slate-300 px-2.5 py-2 text-xs bg-white"
                      >
                        {TRIP_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <input
                        type="email"
                        required={isPrivilegedTripRole(inviteRole)}
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder={
                          isPrivilegedTripRole(inviteRole)
                            ? 'Verified Email Required *'
                            : 'Intended Email (Optional)'
                        }
                        className="sm:col-span-2 rounded-xl border border-slate-300 px-3 py-2 text-xs"
                      />
                      <select
                        aria-label="Invite Expiration"
                        value={inviteTtlHours}
                        onChange={(e) => setInviteTtlHours(Number.parseInt(e.target.value, 10))}
                        className="rounded-xl border border-slate-300 px-2.5 py-2 text-xs bg-white"
                      >
                        <option value={24}>24 hours</option>
                        <option value={48}>48 hours</option>
                        <option value={72}>72 hours</option>
                        <option value={168}>7 days</option>
                      </select>
                    </div>

                    <button
                      type="submit"
                      disabled={issuingInvite}
                      className="w-full py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold disabled:opacity-50"
                    >
                      {issuingInvite ? 'Issuing Invitation...' : 'Issue Role Invitation'}
                    </button>
                  </form>
                )}

                <div className="pt-2 border-t border-slate-100 space-y-2">
                  <div className="text-[11px] font-semibold text-slate-500">
                    Invitation History ({invitesQuery.data?.invites.length ?? 0})
                  </div>
                  {(invitesQuery.data?.invites ?? []).length === 0 ? (
                    <p className="text-xs text-slate-400">No role invitations issued yet.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {(invitesQuery.data?.invites ?? []).map((inv) => {
                        const isExpired =
                          !inv.usedAt &&
                          !inv.revokedAt &&
                          new Date(inv.expiresAt).getTime() <= Date.now();
                        const statusLabel = inv.usedAt
                          ? 'Redeemed'
                          : inv.revokedAt
                            ? 'Revoked'
                            : isExpired
                              ? 'Expired'
                              : 'Pending';

                        return (
                          <div
                            key={inv.id}
                            className="py-2 flex items-center justify-between gap-2 text-xs"
                          >
                            <div>
                              <div className="font-semibold text-slate-900">
                                {participantNameMap.get(inv.participantId) ?? 'Participant'} →{' '}
                                <span className="text-blue-700">{inv.grantedRole}</span>
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {inv.intendedEmail ?? 'Email-less claim'} • Status:{' '}
                                <strong>{statusLabel}</strong>
                              </div>
                            </div>
                            {statusLabel === 'Pending' && (
                              <button
                                type="button"
                                onClick={() => void handleRevokeInvite(inv.id)}
                                className="px-2.5 py-1 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-[11px] font-semibold shrink-0"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Family Mode: Family Groups Management */}
          {trip.mode === 'FAMILY' && (
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <h2 className="text-sm font-bold text-slate-900 mb-3">
                  Family Groups ({families.length})
                </h2>
                {families.length === 0 ? (
                  <p className="text-xs text-slate-500">No family groups created yet.</p>
                ) : (
                  <div className="space-y-2.5">
                    {families.map((fam) => {
                      const members = participants.filter((p) => p.familyId === fam.id);
                      return (
                        <div
                          key={fam.id}
                          className="p-3 rounded-xl border border-slate-200 bg-slate-50 text-xs"
                        >
                          <div className="font-bold text-slate-900">{fam.name}</div>
                          <div className="text-slate-600 mt-0.5">
                            Representative:{' '}
                            {fam.representativeId
                              ? participantNameMap.get(fam.representativeId) ?? 'Assigned'
                              : 'Not designated'}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            Members ({members.length}): {members.map((m) => m.name).join(', ') || 'None'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {isOrganizer && (
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                    Create Family Group
                  </h3>
                  <form onSubmit={handleAddFamily} className="space-y-3">
                    <input
                      type="text"
                      required
                      value={newFamilyName}
                      onChange={(e) => setNewFamilyName(e.target.value)}
                      placeholder="Family Group Name (e.g., Thapa Family) *"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                    />
                    <select
                      value={newFamilyRepId}
                      onChange={(e) => setNewFamilyRepId(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs bg-white"
                    >
                      <option value="">-- Select Representative (Optional) --</option>
                      {activeParticipants.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="w-full py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
                    >
                      Create Family Group
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: SETTLEMENTS & PARTIAL PAYMENTS */}
      {activeTab === 'SETTLEMENTS' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-3">
              Record Full or Partial Settlement
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Settlements reimburse participants directly and never modify original expense records. Only confirmed settlements reduce outstanding balances.
            </p>
            {trip.status === 'CLOSED' ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
                Trip is closed. Recording new settlements is disabled.
              </div>
            ) : (
            <form onSubmit={handleRecordSettlement} className="space-y-3">
              {trip.mode === 'FAMILY' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Settlement Mode
                  </label>
                  <div className="flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setSettlementViewMode('INDIVIDUAL')}
                      className={`flex-1 py-1.5 rounded-lg transition-colors ${
                        settlementViewMode === 'INDIVIDUAL'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Individual
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettlementViewMode('FAMILY')}
                      className={`flex-1 py-1.5 rounded-lg transition-colors ${
                        settlementViewMode === 'FAMILY'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Family
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Sender (Who Paid?) *
                  </label>
                  <select
                    required
                    value={settleFromId}
                    onChange={(e) => setSettleFromId(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs bg-white"
                  >
                    <option value="">Select Sender</option>
                    {activeParticipants.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Receiver (Paid To) *
                  </label>
                  <select
                    required
                    value={settleToId}
                    onChange={(e) => setSettleToId(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs bg-white"
                  >
                    <option value="">Select Receiver</option>
                    {activeParticipants.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Amount (NPR) *
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={settleAmountNpr}
                    onChange={(e) => setSettleAmountNpr(e.target.value)}
                    placeholder="e.g., 1500"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Payment Method
                  </label>
                  <select
                    value={settleMethod}
                    onChange={(e) => setSettleMethod(e.target.value as PaymentMethod)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs bg-white"
                  >
                    {PAYMENT_METHODS.map((pm) => (
                      <option key={pm} value={pm}>
                        {PAYMENT_METHOD_LABELS[pm]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Reference / Transaction Note (Optional)
                </label>
                <input
                  type="text"
                  value={settleNote}
                  onChange={(e) => setSettleNote(e.target.value)}
                  placeholder="e.g., eSewa TXN #99182"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm"
              >
                {isOrganizer ? 'Record & Confirm Settlement' : 'Report Settlement Payment'}
              </button>
            </form>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-3">
              Settlement History ({settlements.length})
            </h2>
            {settlements.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                No settlements recorded yet.
              </p>
            ) : (
              <div className="space-y-2.5">
                {settlements.map((s) => {
                  const isActiveActor = myParticipantRecord
                    ? myParticipantRecord.isActive === true
                    : false;
                  const receiverRecord = participantMap.get(s.toParticipantId);
                  const designatedFamily =
                    s.toFamilyId && s.toFamilyId === myParticipant.familyId
                      ? familyMap.get(s.toFamilyId)
                      : undefined;
                  const isDesignatedFamilyRep =
                    currentUser?.emailVerified === true &&
                    Boolean(currentUser?.id && myParticipantRecord?.userId === currentUser.id) &&
                    trip.mode === 'FAMILY' &&
                    s.settlementMode === 'FAMILY' &&
                    isActiveActor &&
                    myParticipant.role === 'FAMILY_REP' &&
                    Boolean(myParticipant.familyId) &&
                    Boolean(s.toFamilyId) &&
                    s.toFamilyId === myParticipant.familyId &&
                    Boolean(designatedFamily && designatedFamily.representativeId === myParticipant.id) &&
                    Boolean(
                      receiverRecord &&
                        receiverRecord.isActive === true &&
                        receiverRecord.familyId === s.toFamilyId
                    );
                  const canConfirm =
                    trip.status !== 'CLOSED' &&
                    s.status === 'REPORTED' &&
                    (isOrganizer ||
                      (isActiveActor && s.toParticipantId === myParticipant.id) ||
                      isDesignatedFamilyRep);

                  return (
                    <div
                      key={s.id}
                      className="p-3 rounded-xl border border-slate-200 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="font-semibold text-slate-900">
                            {participantNameMap.get(s.fromParticipantId) ?? 'Sender'} →{' '}
                            {participantNameMap.get(s.toParticipantId) ?? 'Receiver'}
                          </p>
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {s.settlementMode}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          {PAYMENT_METHOD_LABELS[s.paymentMethod] ?? s.paymentMethod} •{' '}
                          {new Date(s.settledAt).toLocaleDateString()}
                          {s.referenceNote ? ` • ${s.referenceNote}` : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <span className="font-mono font-bold tabular-nums text-slate-900 block">
                            {formatPaisaToNPR(s.amountPaisa)}
                          </span>
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              s.status === 'CONFIRMED'
                                ? 'bg-emerald-50 text-emerald-700'
                                : s.status === 'REJECTED'
                                  ? 'bg-rose-50 text-rose-700'
                                  : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {s.status}
                          </span>
                        </div>

                        {canConfirm && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Confirm settlement ${s.id}`}
                              onClick={() => void handleConfirmSettlement(s.id, 'CONFIRMED')}
                              title="Confirm Receipt"
                              className="p-1.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Reject settlement ${s.id}`}
                              onClick={() => void handleConfirmSettlement(s.id, 'REJECTED')}
                              title="Reject"
                              className="p-1.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-600"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 5: FORGOTTEN EXPENSE PROTECTION CHECKLIST */}
      {activeTab === 'CHECKLIST' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm max-w-3xl space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-blue-600 text-xs font-bold uppercase tracking-wider">
                <ShieldCheck className="w-4 h-4" />
                <span>Forgotten Expense Protection</span>
              </div>
              <h2 className="text-base font-bold text-slate-900 mt-1">
                Pre-Settlement Trip Expense Completion Checklist
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Verify that every common trip expense category has been recorded (or marked N/A) and all estimated expenses are confirmed before closing the trip.
              </p>
            </div>
            {isOrganizer && trip.status !== 'CLOSED' && (
              <button
                onClick={() => void handleCloseTrip()}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shrink-0"
              >
                Finalize & Close Trip
              </button>
            )}
          </div>

          <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2">
            {trip.checklist.map((item: ChecklistItem) => (
              <div
                key={item.category}
                className="py-3 flex items-center justify-between text-xs"
              >
                <div>
                  <span className="font-semibold text-slate-900">{item.label}</span>
                  {item.verifiedAt && (
                    <span className="text-[11px] text-emerald-600 ml-2">
                      ✓ Verified
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-700">
                    <input
                      type="checkbox"
                      disabled={!isOrganizer}
                      checked={item.checked}
                      onChange={(e) =>
                        void handleChecklistToggle(item.category, 'checked', e.target.checked)
                      }
                      className="rounded border-slate-300 text-emerald-600"
                    />
                    <span>All Recorded</span>
                  </label>

                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-500">
                    <input
                      type="checkbox"
                      disabled={!isOrganizer}
                      checked={item.notApplicable}
                      onChange={(e) =>
                        void handleChecklistToggle(
                          item.category,
                          'notApplicable',
                          e.target.checked
                        )
                      }
                      className="rounded border-slate-300 text-slate-600"
                    />
                    <span>N/A</span>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 6: REPORTS & PDF/EXCEL EXPORT */}
      {activeTab === 'REPORTS' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Export & Share Trip Financial Statement
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Download formatted PDF or multi-sheet Excel reports, or share the read-only public summary link with participants.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                onClick={() =>
                  exportTripReportToPDF({
                    trip,
                    totalApprovedExpensePaisa: ledger.totalApprovedExpensePaisa,
                    totalPackageExpensePaisa: ledger.totalPackageExpensePaisa,
                    totalAdditionalExpensePaisa: ledger.totalAdditionalExpensePaisa,
                    individualBalances: ledger.individualBalances,
                    familyBalances: ledger.familyBalances,
                    expenses,
                    settlements,
                    individualSettlementSuggestions,
                    familySettlementSuggestions,
                    participantNameMap,
                  })
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-sm"
              >
                <Download className="w-4 h-4" />
                <span>Download PDF Report</span>
              </button>

              <button
                onClick={() =>
                  exportTripReportToExcel({
                    trip,
                    totalApprovedExpensePaisa: ledger.totalApprovedExpensePaisa,
                    totalPackageExpensePaisa: ledger.totalPackageExpensePaisa,
                    totalAdditionalExpensePaisa: ledger.totalAdditionalExpensePaisa,
                    individualBalances: ledger.individualBalances,
                    familyBalances: ledger.familyBalances,
                    expenses,
                    settlements,
                    individualSettlementSuggestions,
                    familySettlementSuggestions,
                    participantNameMap,
                  })
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>Export Excel (.xlsx)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick-Add Expense Modal */}
      {showAddExpense && (
        <QuickAddExpenseModal
          tripId={trip.id}
          tripName={trip.name}
          tripMode={trip.mode}
          myParticipantId={myParticipant.id}
          participants={participants}
          families={families}
          onClose={() => setShowAddExpense(false)}
        />
      )}
    </div>
  );
}
