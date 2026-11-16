export const TRIP_MODES = ['FRIENDS', 'FAMILY'] as const;
export type TripMode = (typeof TRIP_MODES)[number];

export const TRIP_STATUSES = ['PLANNING', 'ACTIVE', 'REVIEW', 'CLOSED'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const TRIP_ROLES = ['ORGANIZER', 'CONTRIBUTOR', 'FAMILY_REP', 'PARTICIPANT'] as const;
export type TripRole = (typeof TRIP_ROLES)[number];

export const PRIVILEGED_TRIP_ROLES = ['ORGANIZER', 'FAMILY_REP'] as const;
export type PrivilegedTripRole = (typeof PRIVILEGED_TRIP_ROLES)[number];

export const DEFAULT_OPEN_INVITE_ROLE = 'PARTICIPANT' as const satisfies TripRole;

export function isPrivilegedTripRole(role: TripRole): role is PrivilegedTripRole {
  return (PRIVILEGED_TRIP_ROLES as readonly string[]).includes(role);
}

export const DEFAULT_PARTICIPANT_INVITE_TTL_HOURS = 48;
export const MAX_PARTICIPANT_INVITE_TTL_HOURS = 168;
export const EMAIL_VERIFICATION_TTL_MINUTES = 30;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

export const EMAIL_DELIVERY_PROVIDERS = ['DISABLED', 'MEMORY', 'SMTP', 'WEBHOOK'] as const;
export type EmailDeliveryProvider = (typeof EMAIL_DELIVERY_PROVIDERS)[number];

export const MEMBER_TYPES = ['ADULT', 'CHILD', 'DEPENDENT'] as const;
export type MemberType = (typeof MEMBER_TYPES)[number];

export const EXPENSE_CATEGORIES = [
  'TRANSPORTATION',
  'FUEL',
  'ACCOMMODATION',
  'FOOD_DRINKS',
  'SNACKS_WATER',
  'PARKING_TOLLS',
  'ENTRY_FEES',
  'ACTIVITIES',
  'PACKAGE',
  'SHOPPING',
  'MISCELLANEOUS',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  TRANSPORTATION: 'Transportation',
  FUEL: 'Fuel',
  ACCOMMODATION: 'Accommodation',
  FOOD_DRINKS: 'Food & Drinks',
  SNACKS_WATER: 'Snacks & Water',
  PARKING_TOLLS: 'Parking & Tolls',
  ENTRY_FEES: 'Entry Fees & Tickets',
  ACTIVITIES: 'Activities & Tours',
  PACKAGE: 'Fixed Package',
  SHOPPING: 'Shopping',
  MISCELLANEOUS: 'Miscellaneous',
};

export const FORGOTTEN_EXPENSE_CHECKLIST_CATEGORIES: ExpenseCategory[] = [
  'TRANSPORTATION',
  'FUEL',
  'ACCOMMODATION',
  'FOOD_DRINKS',
  'SNACKS_WATER',
  'PARKING_TOLLS',
  'ENTRY_FEES',
  'ACTIVITIES',
  'SHOPPING',
  'MISCELLANEOUS',
];

export const SPLIT_METHODS = [
  'EQUAL',
  'CUSTOM',
  'SELECTIVE',
  'PER_FAMILY',
  'WEIGHTED',
  'PACKAGE',
] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

export const PAYMENT_METHODS = [
  'CASH',
  'ESEWA',
  'KHALTI',
  'FONEPAY',
  'BANK_TRANSFER',
  'CARD',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  ESEWA: 'eSewa',
  KHALTI: 'Khalti',
  FONEPAY: 'Fonepay QR',
  BANK_TRANSFER: 'Bank Transfer',
  CARD: 'Card',
  OTHER: 'Other',
};

export const EXPENSE_APPROVAL_STATUSES = [
  'APPROVED',
  'PENDING_APPROVAL',
  'PENDING_CONFIRMATION',
  'REJECTED',
] as const;
export type ExpenseApprovalStatus = (typeof EXPENSE_APPROVAL_STATUSES)[number];

export const SETTLEMENT_STATUSES = [
  'PENDING',
  'REPORTED',
  'CONFIRMED',
  'REJECTED',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_MODES = ['INDIVIDUAL', 'FAMILY'] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];
