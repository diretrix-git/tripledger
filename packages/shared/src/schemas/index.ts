import { z } from 'zod';
import {
  EXPENSE_APPROVAL_STATUSES,
  EXPENSE_CATEGORIES,
  MEMBER_TYPES,
  PAYMENT_METHODS,
  SETTLEMENT_MODES,
  SETTLEMENT_STATUSES,
  SPLIT_METHODS,
  TRIP_MODES,
  TRIP_ROLES,
  TRIP_STATUSES,
} from '../constants/index.js';

export const registerUserSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().email('Please enter a valid email address').toLowerCase(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(/[A-Za-z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  phone: z.string().trim().max(25).optional(),
});

export const loginUserSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address').toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().max(25).optional(),
});

export const createTripSchema = z.object({
  name: z.string().trim().min(2, 'Trip name is required').max(120),
  description: z.string().trim().max(500).optional(),
  mode: z.enum(TRIP_MODES),
  budgetPaisa: z.number().int().min(0).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  organizerFamilyName: z.string().trim().max(100).optional(),
});

export const updateTripSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  status: z.enum(TRIP_STATUSES).optional(),
  budgetPaisa: z.number().int().min(0).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  shareEnabled: z.boolean().optional(),
});

export const updateChecklistItemSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  checked: z.boolean().optional(),
  notApplicable: z.boolean().optional(),
});

export const createFamilySchema = z.object({
  name: z.string().trim().min(2, 'Family name is required').max(100),
  representativeId: z.string().optional().nullable(),
  defaultWeight: z.number().positive().default(1),
  notes: z.string().trim().max(300).optional(),
});

export const updateFamilySchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  representativeId: z.string().optional().nullable(),
  defaultWeight: z.number().positive().optional(),
  notes: z.string().trim().max(300).optional(),
});

export const createParticipantSchema = z.object({
  name: z.string().trim().min(1, 'Participant name is required').max(80),
  email: z.string().trim().email().toLowerCase().optional().or(z.literal('')),
  phone: z.string().trim().max(25).optional(),
  role: z.enum(TRIP_ROLES).default('PARTICIPANT'),
  memberType: z.enum(MEMBER_TYPES).default('ADULT'),
  familyId: z.string().optional().nullable(),
  defaultWeight: z.number().positive().default(1),
});

export const updateParticipantSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().toLowerCase().optional().or(z.literal('')),
  phone: z.string().trim().max(25).optional(),
  role: z.enum(TRIP_ROLES).optional(),
  memberType: z.enum(MEMBER_TYPES).optional(),
  familyId: z.string().optional().nullable(),
  defaultWeight: z.number().positive().optional(),
  isActive: z.boolean().optional(),
});

export const expensePaymentSchema = z.object({
  participantId: z.string().min(1, 'Payer participantId is required'),
  amountPaisa: z.number().int().positive('Contribution amount must be > 0 paisa'),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  notes: z.string().trim().max(200).optional(),
});

export const customShareSchema = z.object({
  participantId: z.string().min(1),
  amountPaisa: z.number().int().min(0),
});

export const weightedShareSchema = z.object({
  participantId: z.string().min(1),
  weight: z.number().positive(),
});

export const familyWeightSchema = z.object({
  familyId: z.string().min(1),
  weight: z.number().positive(),
});

export const createExpenseSchema = z.object({
  title: z.string().trim().min(1, 'Expense title is required').max(150),
  description: z.string().trim().max(500).optional(),
  category: z.enum(EXPENSE_CATEGORIES),
  amountPaisa: z.number().int().positive('Expense amount must be > 0 paisa'),
  isEstimated: z.boolean().default(false),
  isPackage: z.boolean().default(false),
  packageRatePerPersonPaisa: z.number().int().positive().optional(),
  splitMethod: z.enum(SPLIT_METHODS),
  paymentMethod: z.enum(PAYMENT_METHODS).default('CASH'),
  incurredAt: z.string().optional(),
  payments: z.array(expensePaymentSchema).min(1, 'At least one payer is required'),
  includedParticipantIds: z.array(z.string()).optional(),
  includedFamilyIds: z.array(z.string()).optional(),
  customShares: z.array(customShareSchema).optional(),
  weights: z.array(weightedShareSchema).optional(),
  familyWeights: z.array(familyWeightSchema).optional(),
  clientMutationId: z.string().trim().max(100).optional(),
});

export const updateExpenseSchema = createExpenseSchema.partial().extend({
  approvalStatus: z.enum(EXPENSE_APPROVAL_STATUSES).optional(),
});

export const approveExpenseSchema = z.object({
  approvalStatus: z.enum(['APPROVED', 'REJECTED']),
  actualAmountPaisa: z.number().int().positive().optional(),
});

export const createSettlementSchema = z.object({
  settlementMode: z.enum(SETTLEMENT_MODES).default('INDIVIDUAL'),
  fromParticipantId: z.string().min(1, 'Sender participant is required'),
  toParticipantId: z.string().min(1, 'Receiver participant is required'),
  fromFamilyId: z.string().optional().nullable(),
  toFamilyId: z.string().optional().nullable(),
  amountPaisa: z.number().int().positive('Settlement amount must be > 0 paisa'),
  paymentMethod: z.enum(PAYMENT_METHODS).default('CASH'),
  status: z.enum(SETTLEMENT_STATUSES).optional(),
  referenceNote: z.string().trim().max(300).optional(),
  settledAt: z.string().optional(),
});

export const updateSettlementStatusSchema = z.object({
  status: z.enum(['CONFIRMED', 'REJECTED']),
  referenceNote: z.string().trim().max(300).optional(),
});
