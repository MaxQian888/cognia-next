/**
 * Inbound dedup layer — Task 28 (extended in v38 for connector callbacks).
 *
 * Delegates to `lib/db/inbound-ledger.ts:recordInbound` and schedules a lazy
 * prune every PRUNE_EVERY calls to keep the table capped at 10,000 rows.
 *
 * Accepts an optional `namespace` so callers handling connector callbacks
 * (Slack block_actions, Lark card actions, Telegram callback_query,
 * Discord component interactions) can dedupe on the same machinery without
 * needing a parallel table.
 */

import type { InboundLedgerNamespace } from "@/lib/db/connector-types"
import { recordInbound, pruneOldest } from "@/lib/db/inbound-ledger"

const PRUNE_EVERY = 200
const LEDGER_CAP = 10_000

let callCount = 0

/**
 * Record an inbound message (or callback) and return whether it is new.
 *
 * @param adapterId         the adapter instance.
 * @param platformMessageId the platform-native id we dedup on.
 * @param namespace         sliding-window bucket; defaults to `"inbound"`
 *                          for back-compat with every pre-v38 caller.
 *
 * @returns `true` if this is the first time we've seen
 *          (adapterId, namespace, platformMessageId), `false` otherwise.
 */
export async function recordAndCheckInbound(
  adapterId: string,
  platformMessageId: string,
  namespace: InboundLedgerNamespace = "inbound"
): Promise<boolean> {
  callCount++

  const isNew = await recordInbound(adapterId, platformMessageId, namespace)

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
