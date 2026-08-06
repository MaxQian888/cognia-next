/**
 * Shared types for the companion sync-down protocol (M4.7 / #51).
 *
 * The phone is a read-only client of the desktop's Dexie. It pulls deltas
 * via `_rpc/sync_pull`, applies them locally, and the existing Dexie
 * queries fall through to the warmed cache when the network is offline.
 */

import {
  COMPANION_SYNC_PROTOCOL_TABLE_NAMES,
  type CompanionSyncProtocolTableName,
} from "@/lib/data-governance/table-catalog"

/** The catalog is the single TypeScript authority for companion sync tables. */
export const SYNCABLE_TABLE_NAMES = COMPANION_SYNC_PROTOCOL_TABLE_NAMES
export type SyncableTable = CompanionSyncProtocolTableName

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
  /**
   * Set by paged tables (messages) when this page filled to the page size,
   * i.e. more rows exist past `next_since`. The mobile handler keeps pulling
   * while this is true so a long history streams in full. Omitted/false for
   * single-shot tables, which the handler pulls exactly once.
   */
  has_more?: boolean
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

/**
 * Persisted sync state per table (Dexie `hostSyncCursors`, v130 (was `syncCursors`, v44)).
 *
 * Pre-v44 installs ran with cursors only in memory; this table makes a
 * cold-started phone resume from the last successful `since` instead of
 * re-pulling the whole snapshot.
 */
export interface SyncCursorRow {
  /**
   * Which host this watermark belongs to — the host's **cursor namespace**,
   * `{accountNamespace}:{hostId}` (ADR-0097 D13; v130 keyed it by the device id
   * the host issued at pair time). Part of the compound primary key
   * `[serverKey+table]`.
   *
   * Before this existed the cursor was keyed by table alone, so a client that
   * paired to a different host resumed from the previous host's watermark and
   * asked the new one for everything since a timestamp that meant nothing
   * there, blending two machines' data into one local store. Keying by the
   * *device* id then over-corrected: it is minted per pairing, so re-pairing to
   * the same desktop also read as a different host and forced a full re-pull.
   *
   * Rows written by a pre-namespace build are adopted on first run — see
   * `companion-sync.ts:adoptLegacyCursorKeys`.
   */
  serverKey: string
  /** Part of the compound primary key — the SyncableTable name. */
  table: SyncableTable
  /** Last successful `next_since` cursor returned by the server. */
  since: number
  /** Epoch ms of the last successful pull. `null` until the first success. */
  lastSyncAt: number | null
  /** Last failure message, retained until the next success. */
  lastError: string | null
}

/**
 * Desktop-side tombstone (Dexie `syncTombstones`, v61).
 *
 * V1 of the sync protocol shipped `deleted_ids: []` always — desktop
 * deletions never reached the phone. We now record one tombstone per
 * genuine user deletion (session/message/workflow/character) so the next
 * `sync_pull` for that table surfaces the removed id and the phone calls
 * `bulkDelete`. Compound PK `[table+id]` keeps the same id distinct across
 * tables; pruned after a retention window by `pruneTombstones`.
 */
export interface SyncTombstoneRow {
  /** Which syncable table the deleted row belonged to. */
  table: SyncableTable
  /** The deleted row's primary key. */
  id: string
  /** Epoch ms the deletion was recorded; doubles as the cursor watermark. */
  deletedAt: number
}
