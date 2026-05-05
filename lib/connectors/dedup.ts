/**
 * Inbound dedup layer — Task 28.
 *
 * Delegates to `lib/db/inbound-ledger.ts:recordInbound` and schedules a lazy
 * prune every PRUNE_EVERY calls to keep the table capped at 10,000 rows.
 */

import { recordInbound, pruneOldest } from "@/lib/db/inbound-ledger"

const PRUNE_EVERY = 200
const LEDGER_CAP = 10_000

let callCount = 0

/**
 * Record an inbound message and return whether it is new.
 *
 * @returns `true` if this is the first time we've seen (adapterId, platformMessageId),
 *          `false` if it's a duplicate.
 */
export async function recordAndCheckInbound(
  adapterId: string,
  platformMessageId: string
): Promise<boolean> {
  callCount++

  const isNew = await recordInbound(adapterId, platformMessageId)

  // Lazy prune on every PRUNE_EVERY-th call
  if (callCount % PRUNE_EVERY === 0) {
    // Awaited so the cap is enforced before this call returns.
    // Non-fatal: a prune failure is logged silently.
    await pruneOldest(LEDGER_CAP).catch(() => undefined)
  }

  return isNew
}

/** Test-only: reset the call counter so prune-threshold tests are deterministic. */
export function __resetPruneCounterForTesting(): void {
  callCount = 0
}
