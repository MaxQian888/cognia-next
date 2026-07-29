/**
 * Persistent cursor store for the companion sync orchestrator (Wave 4 / ADR-0026).
 *
 * `lib/sync/companion-sync.ts` holds an in-memory `Map<SyncableTable, SyncState>`
 * for hot reads on every sync iteration. This module is the durable backstop —
 * the orchestrator hydrates the map from `loadCursors()` once at boot and
 * fire-and-forgets `saveCursor()` on every success/failure. The Dexie write is
 * intentionally off the critical path so handler latency is unchanged.
 *
 * Cursors are scoped to a host (`serverKey`, v130). The table layout
 * (`&[serverKey+table], table, lastSyncAt, since`) is defined in
 * `lib/db/schema.ts`; `lastSyncAt` / `since` stay indexed for diagnostic
 * ordering ("which table is most stale?").
 */

import { getDb } from "@/lib/db/schema"

import type { SyncCursorRow, SyncableTable } from "./types"

/**
 * Load one host's persisted cursors into a map keyed by table name.
 *
 * Returns an empty map if Dexie is unavailable (SSR, tests with no DB) — the
 * orchestrator then falls back to `since: 0`, which matches pre-v44 behaviour
 * and is always safe: a full re-pull, never a watermark from somewhere else.
 */
export async function loadCursors(serverKey: string): Promise<Map<SyncableTable, SyncCursorRow>> {
  const map = new Map<SyncableTable, SyncCursorRow>()
  try {
    const rows = await getDb().hostSyncCursors.where("serverKey").equals(serverKey).toArray()
    for (const row of rows) {
      map.set(row.table, row)
    }
  } catch {
    // Dexie unavailable (no IndexedDB, schema not opened yet). Safe to
    // return empty — the orchestrator treats missing rows as `since: 0`.
  }
  return map
}

/**
 * Upsert a single cursor row. Fire-and-forget from the orchestrator's
 * success/failure branches so handler latency is unaffected. Failures here
 * (e.g. quota exhaustion) are swallowed — the next successful sync will
 * overwrite the row anyway, and the in-memory cursor remains correct for
 * the current session.
 */
export async function saveCursor(row: SyncCursorRow): Promise<void> {
  try {
    await getDb().hostSyncCursors.put(row)
  } catch {
    // Intentionally swallowed — see jsdoc.
  }
}

/**
 * Wipe every persisted cursor, for every host. Used by
 * `__resetSyncStateForTests` and by the "Resync from scratch" diagnostic.
 */
export async function clearCursors(): Promise<void> {
  try {
    await getDb().hostSyncCursors.clear()
  } catch {
    // Same rationale as `saveCursor` — non-fatal.
  }
}

/** Wipe one host's cursors, leaving other hosts' intact. */
export async function clearCursorsForServer(serverKey: string): Promise<void> {
  try {
    await getDb().hostSyncCursors.where("serverKey").equals(serverKey).delete()
  } catch {
    // Same rationale as `saveCursor` — non-fatal.
  }
}
