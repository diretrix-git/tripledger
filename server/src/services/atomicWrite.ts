import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../utils/http.js';

/**
 * Multi-collection write helper (`runAtomically`).
 *
 * MongoDB multi-document ACID transactions require a replica set (or sharded cluster); a
 * standalone `mongod` instance rejects transactions with `IllegalOperation`. This module detects
 * topology support at runtime via the `{ hello: 1 }` admin command and enforces the following
 * policy:
 *
 * 1. **Replica Set / Sharded Cluster (`mode: 'transaction'`):**
 *    `work(session)` executes inside `session.withTransaction(...)`. Every collection write passed
 *    the `session` commits or aborts as a single ACID unit with snapshot isolation, and the
 *    MongoDB driver automatically retries `TransientTransactionError`s.
 *
 * 2. **Production Fail-Closed Guarantee (`NODE_ENV === 'production'` or `MONGO_TRANSACTIONS=required`):**
 *    In production, `resolveTransactionMode()` ALWAYS returns `'required'` regardless of
 *    `MONGO_TRANSACTIONS`. Production can NEVER silently fall back to non-transactional
 *    compensating writes; if the connected deployment does not support transactions, `runAtomically`
 *    refuses the write before mutating any collection and throws `503 TRANSACTIONS_UNAVAILABLE`.
 *
 * 3. **Standalone Dev / Test Compensating Fallback (`mode: 'compensated'`, non-production only):**
 *    When running against a standalone `mongod` in local development or automated tests (`auto` or
 *    `disabled`), `work(null)` executes and, if an error is thrown, the caller-supplied `rollback()`
 *    handler runs to compensate.
 *
 *    IMPORTANT LIMITATIONS — COMPENSATING ROLLBACK IS NOT EQUIVALENT TO A REAL TRANSACTION:
 *    - **No Snapshot Isolation:** Concurrent readers can observe intermediate state between steps.
 *    - **Not Crash-Safe:** If the Node.js process terminates (`SIGKILL`, power loss, OOM) mid-write
 *      before `rollback()` finishes, partial state can remain in the database.
 *    - **Network Failure Risk:** If the database becomes unreachable mid-write, `rollback()` itself
 *      may fail to execute.
 */
export type TransactionMode = 'required' | 'auto' | 'disabled';

export function resolveTransactionMode(): TransactionMode {
  const currentNodeEnv = process.env.NODE_ENV ?? env.NODE_ENV;
  // Production must never fall back to non-transactional compensation, even if MONGO_TRANSACTIONS is set.
  if (currentNodeEnv === 'production') {
    return 'required';
  }
  const raw = (process.env.MONGO_TRANSACTIONS ?? '').toLowerCase();
  if (raw === 'required' || raw === 'auto' || raw === 'disabled') {
    return raw;
  }
  return 'auto';
}

const supportCache = new WeakMap<object, boolean>();
let warnedFallback = false;

export async function supportsTransactions(): Promise<boolean> {
  const client = mongoose.connection.getClient();
  const cached = supportCache.get(client);
  if (cached !== undefined) return cached;

  let supported = false;
  try {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    supported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    supported = false;
  }
  supportCache.set(client, supported);
  return supported;
}

export interface AtomicResult {
  /** `transaction` when committed inside a MongoDB ACID transaction; `compensated` when standalone fallback ran. */
  mode: 'transaction' | 'compensated';
}

export async function runAtomically(
  work: (session: ClientSession | null) => Promise<void>,
  rollback: () => Promise<void>
): Promise<AtomicResult> {
  const mode = resolveTransactionMode();
  const transactional = mode !== 'disabled' && (await supportsTransactions());

  if (transactional) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await work(session);
      });
    } finally {
      await session.endSession();
    }
    return { mode: 'transaction' };
  }

  if (mode === 'required') {
    throw new AppError(
      'This operation requires MongoDB transactions, but the connected deployment does not support them (a replica set is required).',
      503,
      'TRANSACTIONS_UNAVAILABLE'
    );
  }

  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      '[tripledger] MongoDB transactions are unavailable (standalone server). ' +
        'Multi-collection writes use best-effort compensation only. Use a replica set for atomicity.'
    );
  }

  try {
    await work(null);
  } catch (err) {
    try {
      await rollback();
    } catch (rollbackErr) {
      console.error('[tripledger] CRITICAL: compensating rollback failed', rollbackErr);
    }
    throw err;
  }
  return { mode: 'compensated' };
}
