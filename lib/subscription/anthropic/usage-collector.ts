// Drains `anthropic-ratelimit-*` header snapshots from the sidecar's
// `usage_headers` event and persists them to the `subscriptionUsage` Dexie
// table. Designed to be cheap on the hot path: a single Dexie write per
// useful sample, with debounce + capping.
//
// Two entry points:
//
//   subscribeToUsageHeaders()  — start the live subscription. Returns an
//                                async unsubscribe.
//   recordUsageSnapshot()      — write a snapshot directly. The active probe
//                                loop calls this with source="probe".

import { onClaudeMessage } from "@/lib/claude/ipc"
import { getDb } from "@/lib/db/schema"

import type { SubscriptionUsageRow, UsageSnapshot, UsageSource } from "../core/types"
import { hasUsageHeaders, parseUsageHeaders } from "./parser"

const CAP = 1000

/**
 * Minimum gap between two persisted samples *of the same source*. Real chat
 * traffic can fire 5+ requests/second during streaming; we collapse those to
 * one row per minute since the unified-* values move on a 5-hour / 7-day
 * scale. The probe loop handles its own cadence — its writes still respect
 * this floor as a defence-in-depth.
 */
const PERSIST_DEBOUNCE_MS = 60_000

const lastPersistedAt: Record<UsageSource, number | null> = {
  passive: null,
  probe: null,
}

export async function recordUsageSnapshot(
  snapshot: UsageSnapshot
): Promise<SubscriptionUsageRow | null> {
  const lastAt = lastPersistedAt[snapshot.source]
  if (lastAt != null && snapshot.fetchedAt - lastAt < PERSIST_DEBOUNCE_MS) {
    return null
  }
  lastPersistedAt[snapshot.source] = snapshot.fetchedAt

  const db = getDb()
  const row: SubscriptionUsageRow = { ...snapshot }
  const localId = (await db.subscriptionUsage.add(row)) as number
  row.localId = localId

  const total = await db.subscriptionUsage.count()
  if (total > CAP) {
    const overflow = total - CAP
    const toDelete = await db.subscriptionUsage.orderBy("fetchedAt").limit(overflow).primaryKeys()
    if (toDelete.length > 0) {
      await db.subscriptionUsage.bulkDelete(toDelete)
    }
  }

  return row
}

/** Test-only: reset the debounce floor between cases. */
export function _resetPersistDebounce(): void {
  lastPersistedAt.passive = null
  lastPersistedAt.probe = null
}

/**
 * Subscribe to live `usage_headers` events from the sidecar and persist each
 * one as a passive snapshot. Returns the same `Unlisten` shape Tauri uses
 * elsewhere.
 *
 * Outside Tauri (browser dev mode), `onClaudeMessage` throws synchronously;
 * callers should `try`/`catch` or guard with `isTauri()` upstream.
 */
export async function subscribeToUsageHeaders(): Promise<() => void> {
  const unlisten = await onClaudeMessage((event) => {
    if (event.type !== "usage_headers") return
    if (!hasUsageHeaders(event.headers)) return
    const snapshot = parseUsageHeaders(event.headers, "passive")
    void recordUsageSnapshot(snapshot)
  })
  return unlisten
}
