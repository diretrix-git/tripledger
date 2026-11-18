import { create } from 'zustand';
import type { ExpenseCategory, PaymentMethod, SplitMethod } from '@tripledger/shared';
import { AUTH_STORAGE_KEY, useAuthStore } from './authStore.js';

export const LEGACY_OFFLINE_QUEUE_STORAGE_KEY = 'tripledger-offline-expense-queue';
export const OFFLINE_QUEUE_STORAGE_PREFIX = 'tripledger-offline-expense-queue:user:';

export function getOfflineQueueStorageKey(userId: string): string {
  return `${OFFLINE_QUEUE_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
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

interface OfflineQueueState {
  isOnline: boolean;
  isSyncing: boolean;
  activeUserId: string | null;
  queue: QueuedOfflineExpense[];
  legacyDiscardedCount: number;
  setOnlineStatus: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  dismissLegacyNotice: () => void;
  syncAuthContext: () => void;
  enqueueExpense: (item: Omit<QueuedOfflineExpense, 'syncStatus' | 'queuedAt'>) => boolean;
  markItemStatus: (
    clientMutationId: string,
    status: 'PENDING' | 'SYNCING' | 'FAILED',
    error?: string,
    expectedUserId?: string
  ) => void;
  removeQueuedExpense: (clientMutationId: string, expectedUserId?: string) => void;
}

function getLocalStorageSafely(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
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

function readUserQueueFromStorage(userId: string): QueuedOfflineExpense[] {
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
      // Recover items left in SYNCING across reloads/logouts back to PENDING cleanly.
      validEntries.push(
        candidate.syncStatus === 'SYNCING'
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

const initialAuthUserId = resolveAuthenticatedUserId();
const initialLegacyDiscarded =
  initialAuthUserId !== null ? discardLegacyUnscopedQueue() : 0;
const initialQueue =
  initialAuthUserId !== null ? readUserQueueFromStorage(initialAuthUserId) : [];

export const useOfflineQueueStore = create<OfflineQueueState>()((set, get) => ({
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
      const nextQueue = readUserQueueFromStorage(nextUserId);
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
  enqueueExpense: (item) => {
    const currentUserId = resolveAuthenticatedUserId();
    if (!currentUserId || typeof item.userId !== 'string' || item.userId !== currentUserId) {
      return false;
    }

    if (get().activeUserId !== currentUserId) {
      get().syncAuthContext();
    }

    let enqueued = false;
    set((state) => {
      if (state.activeUserId !== currentUserId) {
        return state;
      }
      const ownedQueue = state.queue.filter((q) => q.userId === currentUserId);
      // Deduplicate by clientMutationId
      if (ownedQueue.some((q) => q.clientMutationId === item.clientMutationId)) {
        enqueued = true;
        return ownedQueue.length === state.queue.length ? state : { queue: ownedQueue };
      }
      const nextQueue: QueuedOfflineExpense[] = [
        ...ownedQueue,
        {
          ...item,
          userId: currentUserId,
          queuedAt: new Date().toISOString(),
          syncStatus: 'PENDING',
        },
      ];
      writeUserQueueToStorage(currentUserId, nextQueue);
      enqueued = true;
      return { queue: nextQueue };
    });
    return enqueued;
  },
  markItemStatus: (clientMutationId, syncStatus, lastError, expectedUserId) =>
    set((state) => {
      const targetUserId = expectedUserId ?? state.activeUserId;
      if (!targetUserId) {
        return state;
      }

      if (state.activeUserId === targetUserId) {
        const nextQueue = state.queue
          .filter((q) => q.userId === targetUserId)
          .map((q) =>
            q.clientMutationId === clientMutationId
              ? { ...q, syncStatus, lastError }
              : q
          );
        writeUserQueueToStorage(targetUserId, nextQueue);
        return { queue: nextQueue };
      }

      // Session changed while an in-flight sync completed/failed for targetUserId:
      // update only targetUserId's persisted storage without mutating the active user's queue.
      const storedQueue = readUserQueueFromStorage(targetUserId);
      const updatedStoredQueue = storedQueue.map((q) =>
        q.clientMutationId === clientMutationId
          ? { ...q, syncStatus, lastError }
          : q
      );
      writeUserQueueToStorage(targetUserId, updatedStoredQueue);
      return state;
    }),
  removeQueuedExpense: (clientMutationId, expectedUserId) =>
    set((state) => {
      const targetUserId = expectedUserId ?? state.activeUserId;
      if (!targetUserId) {
        return state;
      }

      if (state.activeUserId === targetUserId) {
        const nextQueue = state.queue.filter(
          (q) => q.userId === targetUserId && q.clientMutationId !== clientMutationId
        );
        writeUserQueueToStorage(targetUserId, nextQueue);
        return { queue: nextQueue };
      }

      const storedQueue = readUserQueueFromStorage(targetUserId);
      const updatedStoredQueue = storedQueue.filter(
        (q) => q.clientMutationId !== clientMutationId
      );
      writeUserQueueToStorage(targetUserId, updatedStoredQueue);
      return state;
    }),
}));

let offlineQueueBindingsRegistered = false;

export function initOfflineQueueAuthIsolation(): void {
  if (offlineQueueBindingsRegistered) return;
  offlineQueueBindingsRegistered = true;

  useAuthStore.subscribe((state, prevState) => {
    const prevUserId = prevState.accessToken && prevState.user?.id ? prevState.user.id : null;
    const nextUserId = state.accessToken && state.user?.id ? state.user.id : null;
    if (
      prevUserId !== nextUserId ||
      state.sessionGeneration !== prevState.sessionGeneration ||
      Boolean(state.accessToken) !== Boolean(prevState.accessToken)
    ) {
      useOfflineQueueStore.getState().syncAuthContext();
    }
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }
      const activeUserId = useOfflineQueueStore.getState().activeUserId;
      if (
        event.key === null ||
        event.key === AUTH_STORAGE_KEY ||
        event.key === LEGACY_OFFLINE_QUEUE_STORAGE_KEY ||
        (activeUserId && event.key === getOfflineQueueStorageKey(activeUserId))
      ) {
        if (event.key === null && activeUserId) {
          useOfflineQueueStore.setState({ queue: [], legacyDiscardedCount: 0 });
          return;
        }
        useOfflineQueueStore.getState().syncAuthContext();
        const latestActiveUserId = useOfflineQueueStore.getState().activeUserId;
        if (
          latestActiveUserId &&
          event.key === getOfflineQueueStorageKey(latestActiveUserId)
        ) {
          useOfflineQueueStore.setState({
            queue: readUserQueueFromStorage(latestActiveUserId),
          });
        }
      }
    });
  }
}

initOfflineQueueAuthIsolation();
