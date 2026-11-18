import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ExpenseCategory, PaymentMethod, SplitMethod } from '@tripledger/shared';
import {
  AUTH_STORAGE_KEY,
  captureAuthSessionSnapshot,
  isSameAuthSession,
  useAuthStore,
} from './authStore.js';

export const LEGACY_OFFLINE_QUEUE_STORAGE_KEY = 'tripledger-offline-expense-queue';
export const OFFLINE_QUEUE_STORAGE_PREFIX = 'tripledger-offline-expense-queue:user:';

export function getOfflineQueueStorageKey(userId: string): string {
  return `${OFFLINE_QUEUE_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function getMutationLockName(userId: string): string {
  return `tripledger:offline-queue:mutation:${encodeURIComponent(userId)}`;
}

function getSyncLockName(userId: string): string {
  return `tripledger:offline-queue:sync:${encodeURIComponent(userId)}`;
}

export interface QueuedOfflineExpense {
  clientMutationId: string;
  userId: string;
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

interface PersistedUserQueueEnvelope {
  version: 1;
  userId: string;
  queue: QueuedOfflineExpense[];
}

export interface OfflineQueueState {
  isOnline: boolean;
  isSyncing: boolean;
  activeUserId: string | null;
  queue: QueuedOfflineExpense[];
  legacyDiscardedCount: number;
  setOnlineStatus: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  dismissLegacyNotice: () => void;
  syncAuthContext: () => void;
  refreshUserQueueFromStorage: (expectedUserId?: string) => Promise<QueuedOfflineExpense[]>;
  tryWithUserSyncLock: (userId: string, work: () => Promise<void>) => Promise<boolean>;
  enqueueExpense: (
    item: Omit<QueuedOfflineExpense, 'syncStatus' | 'queuedAt'>
  ) => Promise<boolean>;
  markItemStatus: (
    clientMutationId: string,
    status: 'PENDING' | 'SYNCING' | 'FAILED',
    error?: string,
    expectedUserId?: string
  ) => Promise<void>;
  removeQueuedExpense: (clientMutationId: string, expectedUserId?: string) => Promise<void>;
  destroy: () => void;
}

export type OfflineQueueStore = UseBoundStore<StoreApi<OfflineQueueState>>;

function getLocalStorageSafely(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function getLockManagerSafely(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  try {
    const candidate = (navigator as Navigator & { locks?: LockManager }).locks;
    if (candidate && typeof candidate.request === 'function') {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveAuthenticatedUserId(): string | null {
  const auth = useAuthStore.getState();
  return auth.accessToken && auth.user?.id ? auth.user.id : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRawQueueEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isPlainRecord(parsed)) {
    if (Array.isArray(parsed.queue)) {
      return parsed.queue;
    }
    if (isPlainRecord(parsed.state) && Array.isArray(parsed.state.queue)) {
      return parsed.state.queue;
    }
  }
  return [];
}

function isValidQueueEntryForUser(
  entry: unknown,
  expectedUserId: string
): entry is QueuedOfflineExpense {
  if (!isPlainRecord(entry)) return false;
  if (typeof entry.userId !== 'string' || entry.userId !== expectedUserId) {
    return false;
  }
  if (typeof entry.clientMutationId !== 'string' || entry.clientMutationId.length === 0) {
    return false;
  }
  if (typeof entry.tripId !== 'string' || entry.tripId.length === 0) {
    return false;
  }
  if (typeof entry.tripName !== 'string') {
    return false;
  }
  if (!isPlainRecord(entry.payload)) {
    return false;
  }
  if (entry.payload.clientMutationId !== entry.clientMutationId) {
    return false;
  }
  if (
    entry.syncStatus !== 'PENDING' &&
    entry.syncStatus !== 'SYNCING' &&
    entry.syncStatus !== 'FAILED'
  ) {
    return false;
  }
  return true;
}

function readUserQueueFromStorage(
  userId: string,
  options: { recoverStuckSyncing?: boolean } = {}
): QueuedOfflineExpense[] {
  const storage = getLocalStorageSafely();
  if (!storage) return [];

  const storageKey = getOfflineQueueStorageKey(userId);
  let raw: string | null = null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isPlainRecord(parsed) &&
      typeof parsed.userId === 'string' &&
      parsed.userId !== userId
    ) {
      // Mismatched top-level owner metadata: refuse to trust entries under this key.
      storage.removeItem(storageKey);
      return [];
    }

    const rawEntries = extractRawQueueEntries(parsed);
    const seenIds = new Set<string>();
    const validEntries: QueuedOfflineExpense[] = [];
    let droppedInvalidEntries = false;

    for (const candidate of rawEntries) {
      if (!isValidQueueEntryForUser(candidate, userId)) {
        droppedInvalidEntries = true;
        continue;
      }
      if (seenIds.has(candidate.clientMutationId)) {
        droppedInvalidEntries = true;
        continue;
      }
      seenIds.add(candidate.clientMutationId);
      // Recover items left in SYNCING across reloads/logouts back to PENDING cleanly,
      // while preserving live SYNCING markers for concurrent sibling operations in active sessions.
      validEntries.push(
        options.recoverStuckSyncing && candidate.syncStatus === 'SYNCING'
          ? { ...candidate, syncStatus: 'PENDING' }
          : candidate
      );
    }

    if (droppedInvalidEntries) {
      writeUserQueueToStorage(userId, validEntries);
    }
    return validEntries;
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // ignore storage cleanup errors
    }
    return [];
  }
}

function writeUserQueueToStorage(userId: string, queue: QueuedOfflineExpense[]): void {
  const storage = getLocalStorageSafely();
  if (!storage) return;

  const storageKey = getOfflineQueueStorageKey(userId);
  const ownedQueue = queue.filter((q) => q.userId === userId);
  try {
    if (ownedQueue.length === 0) {
      storage.removeItem(storageKey);
      return;
    }
    const envelope: PersistedUserQueueEnvelope = {
      version: 1,
      userId,
      queue: ownedQueue,
    };
    storage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    // ignore storage quota/availability errors cleanly
  }
}

/**
 * Legacy pre-Phase-3.1.6 `tripledger-offline-expense-queue` entries lacked verifiable
 * `userId` ownership. Never attribute or replay them automatically; discard them safely
 * so another account on a shared browser cannot view or submit them.
 */
function discardLegacyUnscopedQueue(): number {
  const storage = getLocalStorageSafely();
  if (!storage) return 0;

  let raw: string | null = null;
  try {
    raw = storage.getItem(LEGACY_OFFLINE_QUEUE_STORAGE_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;

  let discardedCount = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    discardedCount = extractRawQueueEntries(parsed).length;
  } catch {
    discardedCount = 0;
  }

  try {
    storage.removeItem(LEGACY_OFFLINE_QUEUE_STORAGE_KEY);
  } catch {
    // ignore cleanup error
  }
  return discardedCount;
}

/**
 * Creates a user-scoped offline expense queue store instance.
 *
 * Cross-tab concurrency guarantees:
 * - Primary: When the Web Locks API (`navigator.locks`) is available, queue read-merge-write
 *   mutations serialize under an exclusive per-user mutation lock, and queue flushing uses
 *   `{ ifAvailable: true }` leader election under a separate per-user sync lock.
 * - Fallback: When `navigator.locks` is unavailable (older browsers or Node/non-lock test hosts),
 *   a per-tab Promise mutex serializes operations within the tab and reconciles against live
 *   `localStorage` state before writing, without claiming cross-tab atomic mutual exclusion;
 *   server-side `(tripId, clientMutationId)` idempotency remains the final guard against duplicate
 *   expense creation.
 */
export function createOfflineQueueStore(options: { bindWindowEvents?: boolean } = {}): OfflineQueueStore {
  const bindWindowEvents = options.bindWindowEvents ?? true;
  const inTabMutationChains = new Map<string, Promise<void>>();

  const runWithUserQueueLock = <T,>(userId: string, work: () => Promise<T> | T): Promise<T> => {
    const prevChain = inTabMutationChains.get(userId) ?? Promise.resolve();
    const runOperation = async (): Promise<T> => {
      const lockManager = getLockManagerSafely();
      if (lockManager) {
        return lockManager.request(
          getMutationLockName(userId),
          { mode: 'exclusive' },
          () => Promise.resolve(work())
        );
      }
      return work();
    };

    const resultPromise = prevChain.then(runOperation, runOperation);
    const tailPromise = resultPromise.then(
      () => undefined,
      () => undefined
    );
    inTabMutationChains.set(userId, tailPromise);
    void tailPromise.finally(() => {
      if (inTabMutationChains.get(userId) === tailPromise) {
        inTabMutationChains.delete(userId);
      }
    });
    return resultPromise;
  };

  const initialAuthUserId = resolveAuthenticatedUserId();
  const initialLegacyDiscarded =
    initialAuthUserId !== null ? discardLegacyUnscopedQueue() : 0;
  const initialQueue =
    initialAuthUserId !== null
      ? readUserQueueFromStorage(initialAuthUserId, { recoverStuckSyncing: true })
      : [];

  const store = create<OfflineQueueState>()((set, get) => ({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isSyncing: false,
    activeUserId: initialAuthUserId,
    queue: initialQueue,
    legacyDiscardedCount: initialLegacyDiscarded,
    setOnlineStatus: (isOnline) => set({ isOnline }),
    setSyncing: (isSyncing) => set({ isSyncing }),
    dismissLegacyNotice: () => set({ legacyDiscardedCount: 0 }),
    syncAuthContext: () => {
      const nextUserId = resolveAuthenticatedUserId();
      const discardedNow = discardLegacyUnscopedQueue();
      const prevState = get();

      if (nextUserId === null) {
        if (
          prevState.activeUserId !== null ||
          prevState.queue.length > 0 ||
          prevState.isSyncing ||
          prevState.legacyDiscardedCount !== 0
        ) {
          set({
            activeUserId: null,
            queue: [],
            isSyncing: false,
            legacyDiscardedCount: 0,
          });
        }
        return;
      }

      if (prevState.activeUserId !== nextUserId) {
        const nextQueue = readUserQueueFromStorage(nextUserId, { recoverStuckSyncing: true });
        set({
          activeUserId: nextUserId,
          queue: nextQueue,
          isSyncing: false,
          legacyDiscardedCount: discardedNow,
        });
        return;
      }

      const sanitizedInMemory = prevState.queue.filter((q) => q.userId === nextUserId);
      if (
        sanitizedInMemory.length !== prevState.queue.length ||
        discardedNow > 0
      ) {
        if (sanitizedInMemory.length !== prevState.queue.length) {
          writeUserQueueToStorage(nextUserId, sanitizedInMemory);
        }
        set((state) => ({
          queue: sanitizedInMemory,
          legacyDiscardedCount: state.legacyDiscardedCount + discardedNow,
        }));
      }
    },
    refreshUserQueueFromStorage: async (expectedUserId) => {
      const targetUserId = expectedUserId ?? get().activeUserId;
      if (!targetUserId) {
        return [];
      }
      return runWithUserQueueLock(targetUserId, () => {
        const storage = getLocalStorageSafely();
        const latestQueue = storage
          ? readUserQueueFromStorage(targetUserId, { recoverStuckSyncing: false })
          : get().queue.filter((q) => q.userId === targetUserId);
        if (get().activeUserId === targetUserId) {
          set({ queue: latestQueue });
        }
        return latestQueue;
      });
    },
    tryWithUserSyncLock: async (userId, work) => {
      const lockManager = getLockManagerSafely();
      if (lockManager) {
        return lockManager.request(
          getSyncLockName(userId),
          { mode: 'exclusive', ifAvailable: true },
          async (lock) => {
            if (!lock) {
              return false;
            }
            await work();
            return true;
          }
        );
      }
      await work();
      return true;
    },
    enqueueExpense: async (item) => {
      const startSession = captureAuthSessionSnapshot();
      const currentUserId = resolveAuthenticatedUserId();
      if (
        !currentUserId ||
        !startSession.hasAccessToken ||
        startSession.userId !== currentUserId ||
        typeof item.userId !== 'string' ||
        item.userId !== currentUserId
      ) {
        return false;
      }

      return runWithUserQueueLock(currentUserId, () => {
        if (!isSameAuthSession(startSession, { requireAuthenticated: true })) {
          return false;
        }
        if (get().activeUserId !== currentUserId) {
          get().syncAuthContext();
          if (get().activeUserId !== currentUserId) {
            return false;
          }
        }

        const storage = getLocalStorageSafely();
        const baseQueue = storage
          ? readUserQueueFromStorage(currentUserId, { recoverStuckSyncing: false })
          : get().queue.filter((q) => q.userId === currentUserId);

        if (baseQueue.some((q) => q.clientMutationId === item.clientMutationId)) {
          if (get().activeUserId === currentUserId) {
            set({ queue: baseQueue });
          }
          return true;
        }

        const nextQueue: QueuedOfflineExpense[] = [
          ...baseQueue,
          {
            ...item,
            userId: currentUserId,
            queuedAt: new Date().toISOString(),
            syncStatus: 'PENDING',
          },
        ];
        writeUserQueueToStorage(currentUserId, nextQueue);
        if (get().activeUserId === currentUserId) {
          set({ queue: nextQueue });
        }
        return true;
      });
    },
    markItemStatus: async (clientMutationId, syncStatus, lastError, expectedUserId) => {
      const targetUserId = expectedUserId ?? get().activeUserId;
      if (!targetUserId) {
        return;
      }

      await runWithUserQueueLock(targetUserId, () => {
        const storage = getLocalStorageSafely();
        const baseQueue = storage
          ? readUserQueueFromStorage(targetUserId, { recoverStuckSyncing: false })
          : get().queue.filter((q) => q.userId === targetUserId);

        const nextQueue = baseQueue.map((q) =>
          q.clientMutationId === clientMutationId
            ? { ...q, syncStatus, lastError }
            : q
        );
        writeUserQueueToStorage(targetUserId, nextQueue);
        if (get().activeUserId === targetUserId) {
          set({ queue: nextQueue });
        }
      });
    },
    removeQueuedExpense: async (clientMutationId, expectedUserId) => {
      const targetUserId = expectedUserId ?? get().activeUserId;
      if (!targetUserId) {
        return;
      }

      await runWithUserQueueLock(targetUserId, () => {
        const storage = getLocalStorageSafely();
        const baseQueue = storage
          ? readUserQueueFromStorage(targetUserId, { recoverStuckSyncing: false })
          : get().queue.filter((q) => q.userId === targetUserId);

        const nextQueue = baseQueue.filter(
          (q) => q.userId === targetUserId && q.clientMutationId !== clientMutationId
        );
        writeUserQueueToStorage(targetUserId, nextQueue);
        if (get().activeUserId === targetUserId) {
          set({ queue: nextQueue });
        }
      });
    },
    destroy: () => {
      unsubscribeAuth();
      if (storageListener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('storage', storageListener);
      }
      inTabMutationChains.clear();
    },
  }));

  const unsubscribeAuth = useAuthStore.subscribe((state, prevState) => {
    const prevUserId = prevState.accessToken && prevState.user?.id ? prevState.user.id : null;
    const nextUserId = state.accessToken && state.user?.id ? state.user.id : null;
    if (
      prevUserId !== nextUserId ||
      state.sessionGeneration !== prevState.sessionGeneration ||
      Boolean(state.accessToken) !== Boolean(prevState.accessToken)
    ) {
      store.getState().syncAuthContext();
    }
  });

  let storageListener: ((event: StorageEvent) => void) | null = null;
  if (
    bindWindowEvents &&
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    storageListener = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key === null) {
        // Storage was cleared globally: ensure auth context & queue state are reconciled,
        // never leaving activeUserId stale or hydrating another user's items.
        store.setState({ queue: [], isSyncing: false, legacyDiscardedCount: 0 });
        store.getState().syncAuthContext();
        return;
      }

      const activeUserId = store.getState().activeUserId;
      const isAuthOrLegacyKey =
        event.key === AUTH_STORAGE_KEY || event.key === LEGACY_OFFLINE_QUEUE_STORAGE_KEY;
      const isCurrentUserQueueKey =
        Boolean(activeUserId) && event.key === getOfflineQueueStorageKey(activeUserId!);

      if (!isAuthOrLegacyKey && !isCurrentUserQueueKey) {
        return;
      }

      store.getState().syncAuthContext();
      const latestActiveUserId = store.getState().activeUserId;
      if (
        latestActiveUserId &&
        event.key === getOfflineQueueStorageKey(latestActiveUserId)
      ) {
        void store.getState().refreshUserQueueFromStorage(latestActiveUserId);
      }
    };
    window.addEventListener('storage', storageListener);
  }

  return store;
}

export const useOfflineQueueStore = createOfflineQueueStore();
