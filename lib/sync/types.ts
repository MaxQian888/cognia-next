/**
 * Shared types for the companion sync-down protocol (M4.7 / #51).
 *
 * The phone is a read-only client of the desktop's Dexie. It pulls deltas
 * via `_rpc/sync_pull`, applies them locally, and the existing Dexie
 * queries fall through to the warmed cache when the network is offline.
 */

/**
 * Tables the phone is allowed to mirror. Each value matches the production
 * Dexie table name in `lib/db/schema.ts` so the handler implementations
 * can do `db[name]` without an extra adapter layer.
 */
export type SyncableTable = "characters" | "skills" | "sessions" | "messages"

export interface SyncCursor {
  /** Server-defined opaque cursor; defaults to 0 for the first sync. */
  since: number
}

export interface SyncDelta<TRow> {
  /** Upserts. The phone calls `table.bulkPut(rows)`. */
  rows: TRow[]
  /** Tombstones. The phone calls `table.bulkDelete(deleted_ids)`. */
  deleted_ids: string[]
  /** Cursor to pass on the next pull. */
  next_since: number
}

export interface SyncResult {
  table: SyncableTable
  /** Rows applied (upserts + deletes). */
  applied: number
  /** Cursor saved after this run. */
  nextSince: number
  /** Server time the snapshot was taken; for diagnostics only. */
  serverTime?: number
}

export interface SyncFailure {
  table: SyncableTable
  reason: "transport" | "not_implemented" | "schema" | "unknown"
  message: string
}

export type SyncOutcome = { ok: true; result: SyncResult } | { ok: false; failure: SyncFailure }
