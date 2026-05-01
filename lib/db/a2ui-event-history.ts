// CRUD for the `a2uiEventHistory` Dexie table (v13). Capped append-only
// log used by Settings → A2UI → Debugger. All writes are best-effort: we
// silently swallow IndexedDB errors so the UI never breaks because of a
// debugger feature.

import { getDb } from "./schema"
import type { A2UIEventHistoryRow } from "./a2ui-types"

const MAX_ROWS = 1000
/** Trim batch size: when count > MAX_ROWS we delete this many oldest. */
const TRIM_BATCH = 100

export async function appendEvent(row: A2UIEventHistoryRow): Promise<void> {
  try {
    const db = getDb()
    await db.a2uiEventHistory.put(row)
    const count = await db.a2uiEventHistory.count()
    if (count > MAX_ROWS) {
      const oldest = await db.a2uiEventHistory.orderBy("timestamp").limit(TRIM_BATCH).toArray()
      await db.a2uiEventHistory.bulkDelete(oldest.map((e) => e.id))
    }
  } catch {
    // Swallow — debugger ledger is best-effort.
  }
}

export interface ListEventsOptions {
  surfaceId?: string
  type?: A2UIEventHistoryRow["type"]
  limit?: number
}

export async function listEvents(opts: ListEventsOptions = {}): Promise<A2UIEventHistoryRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, MAX_ROWS))
  const db = getDb()
  let coll = db.a2uiEventHistory.orderBy("timestamp").reverse()
  if (opts.surfaceId) {
    coll = db.a2uiEventHistory
      .where("[surfaceId+timestamp]")
      .between([opts.surfaceId, 0], [opts.surfaceId, Number.MAX_SAFE_INTEGER])
      .reverse()
  }
  const rows = await coll.limit(limit).toArray()
  return opts.type ? rows.filter((r) => r.type === opts.type) : rows
}

export async function clearEvents(): Promise<number> {
  try {
    const db = getDb()
    const count = await db.a2uiEventHistory.count()
    await db.a2uiEventHistory.clear()
    return count
  } catch {
    return 0
  }
}
