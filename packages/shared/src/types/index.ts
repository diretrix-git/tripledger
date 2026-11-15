import type {
  ExpenseApprovalStatus,
  ExpenseCategory,
  MemberType,
  PaymentMethod,
  SettlementMode,
  SettlementStatus,
  SplitMethod,
  TripMode,
  TripRole,
  TripStatus,
} from '../constants/index.js';

export interface ParticipantEntity {
  id: string;
  tripId: string;
  userId?: string | null;
  familyId?: string | null;
  name: string;
  email?: string;
  phone?: string;
  role: TripRole;
  memberType: MemberType;
  defaultWeight: number;
  isActive: boolean;
}

export interface FamilyEntity {
  id: string;
  tripId: string;
  name: string;
  representativeId?: string | null;
  defaultWeight: number;
  notes?: string;
}

export interface ExpensePaymentInput {
  participantId: string;
  amountPaisa: number;
  paymentMethod?: PaymentMethod;
  notes?: string;
}

export interface ExpenseShareRecord {
  participantId: string;
  familyId?: string | null;
  sharePaisa: number;
  weightUsed?: number;
}

export interface ExpenseRecord {
  id: string;
  tripId: string;
  title: string;
  description?: string;
  category: ExpenseCategory;
  amountPaisa: number;
  isEstimated: boolean;
  isPackage: boolean;
  packageConfig?: {
    ratePerUnitPaisa: number;
    unitCount: number;
  };
  /**
   * Persisted split configuration that cannot be reconstructed from ExpenseShare rows alone
   * (currently only PER_FAMILY). Used to preserve configuration when an amount is re-scaled.
   */
  splitConfig?: {
    includedFamilyIds?: string[];
    familyWeights?: Array<{ familyId: string; weight?: number }>;
  };
  splitMethod: SplitMethod;
  paymentMethod: PaymentMethod;
  approvalStatus: ExpenseApprovalStatus;
  incurredAt: string;
  createdByParticipantId: string;
  approvedByParticipantId?: string | null;
  clientMutationId?: string;
  isDeleted: boolean;
  payments: ExpensePaymentInput[];
  shares: ExpenseShareRecord[];
}

export interface SettlementRecord {
  id: string;
  tripId: string;
  settlementMode: SettlementMode;
  fromParticipantId: string;
  toParticipantId: string;
  fromFamilyId?: string | null;
  toFamilyId?: string | null;
  amountPaisa: number;
  paymentMethod: PaymentMethod;
  status: SettlementStatus;
  referenceNote?: string;
  settledAt: string;
  reportedByParticipantId: string;
  confirmedByParticipantId?: string | null;
  isDeleted?: boolean;
}

export interface IndividualBalanceSummary {
  participantId: string;
  participantName: string;
  familyId: string | null;
  familyName: string | null;
  role: TripRole;
  memberType: MemberType;
  totalPaidPaisa: number;
  totalSharePaisa: number;
  netExpenseBalancePaisa: number;
  settlementsSentPaisa: number;
  settlementsReceivedPaisa: number;
  outstandingBalancePaisa: number;
  status: 'CREDITOR' | 'DEBTOR' | 'SETTLED';
}

export interface FamilyBalanceSummary {
  familyId: string;
  familyName: string;
  representativeId: string | null;
  representativeName: string | null;
  memberIds: string[];
  memberCount: number;
  totalPaidPaisa: number;
  totalSharePaisa: number;
  netExpenseBalancePaisa: number;
  settlementsSentPaisa: number;
  settlementsReceivedPaisa: number;
  outstandingBalancePaisa: number;
  status: 'CREDITOR' | 'DEBTOR' | 'SETTLED';
  memberBalances: IndividualBalanceSummary[];
}

export interface SettlementSuggestion {
  mode: SettlementMode;
  fromParticipantId: string;
  fromParticipantName: string;
  toParticipantId: string;
  toParticipantName: string;
  fromFamilyId?: string | null;
  fromFamilyName?: string | null;
  toFamilyId?: string | null;
  toFamilyName?: string | null;
  amountPaisa: number;
}

export interface ChecklistItem {
  category: ExpenseCategory;
  label: string;
  checked: boolean;
  notApplicable: boolean;
  verifiedAt?: string | null;
}

export interface TripSummaryEntity {
  id: string;
  name: string;
  description?: string;
  mode: TripMode;
  status: TripStatus;
  currency: string;
  budgetPaisa?: number;
  startDate?: string;
  endDate?: string;
  inviteCode: string;
  shareToken: string;
  shareEnabled: boolean;
  checklist: ChecklistItem[];
}
