import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExpenseCategory, PaymentMethod, SplitMethod } from '@tripledger/shared';

export interface QueuedOfflineExpense {
  clientMutationId: string;
  tripId: string;
  tripName: string;
  queuedAt: string;
  syncStatus: 'PENDING' | 'SYNCING' | 'FAILED';
  lastError?: string;
  payload: {
    title: string;
    description?: string;
    category: ExpenseCategory;
    amountPaisa: number;
    isEstimated: boolean;
    isPackage: boolean;
    packageRatePerPersonPaisa?: number;
    splitMethod: SplitMethod;
    paymentMethod: PaymentMethod;
    incurredAt: string;
    payments: Array<{
      participantId: string;
      amountPaisa: number;
      paymentMethod?: PaymentMethod;
    }>;
    includedParticipantIds?: string[];
    includedFamilyIds?: string[];
    customShares?: Array<{ participantId: string; amountPaisa: number }>;
    weights?: Array<{ participantId: string; weight: number }>;
    clientMutationId: string;
  };
}

interface OfflineQueueState {
  isOnline: boolean;
  isSyncing: boolean;
  queue: QueuedOfflineExpense[];
  setOnlineStatus: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  enqueueExpense: (item: Omit<QueuedOfflineExpense, 'syncStatus' | 'queuedAt'>) => void;
  markItemStatus: (
    clientMutationId: string,
    status: 'PENDING' | 'SYNCING' | 'FAILED',
    error?: string
  ) => void;
  removeQueuedExpense: (clientMutationId: string) => void;
}

export const useOfflineQueueStore = create<OfflineQueueState>()(
  persist(
    (set) => ({
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      isSyncing: false,
      queue: [],
      setOnlineStatus: (isOnline) => set({ isOnline }),
      setSyncing: (isSyncing) => set({ isSyncing }),
      enqueueExpense: (item) =>
        set((state) => {
          // Deduplicate by clientMutationId
          if (state.queue.some((q) => q.clientMutationId === item.clientMutationId)) {
            return state;
          }
          return {
            queue: [
              ...state.queue,
              {
                ...item,
                queuedAt: new Date().toISOString(),
                syncStatus: 'PENDING',
              },
            ],
          };
        }),
      markItemStatus: (clientMutationId, syncStatus, lastError) =>
        set((state) => ({
          queue: state.queue.map((q) =>
            q.clientMutationId === clientMutationId
              ? { ...q, syncStatus, lastError }
              : q
          ),
        })),
      removeQueuedExpense: (clientMutationId) =>
        set((state) => ({
          queue: state.queue.filter((q) => q.clientMutationId !== clientMutationId),
        })),
    }),
    {
      name: 'tripledger-offline-expense-queue',
      partialize: (state) => ({ queue: state.queue }),
    }
  )
);
