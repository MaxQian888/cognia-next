/**
 * Rows of the four local tables account sync keeps beside the synced data
 * (ADR-0215 phase 3, protocol §7–9). All are device-local: they describe
 * this device's view of the op log and are never backed up or synced.
 */

import type { HlcTime, Op, RowClocks } from "@cognia/sync-protocol"

/** A synced table, or `settings` for the per-key virtual rows of the settings singleton. */
export type SyncedTableName =
  "sessions" | "messages" | "characters" | "skills" | "memories" | "settings"

/** One row (or one settings key) with changes this device has not pushed yet. */
export interface AccountSyncOutboxRow {
  table: SyncedTableName
  rowId: string
  /** Fields written since the last push, by their sync names. */
  fields: string[]
  /** The row was deleted; `fields` is then empty. */
  deleted: boolean
  /** Send every synced field: the row survived a remote delete (protocol §9). */
  resend?: boolean
  /** Bumped on every capture; a push removes the row only if it is unchanged. */
  rev: number
  /** First capture since the last push, ms. */
  since: number
}

/** Per-field clocks of one row (protocol §9), plus fields from a newer schema. */
export interface SyncFieldClocksRow extends RowClocks {
  table: SyncedTableName
  rowId: string
  /** Fields this build does not know, kept and re-sent untouched (§9 schema skew). */
  unknown?: Record<string, [value: unknown, hlc: string]>
}

/** The classes a device syncs: chats and other content, and shared settings. */
export interface SyncClasses {
  content: boolean
  settings: boolean
}

/**
 * `capture`: whether and as which device this database records changes.
 * Read inside every captured write's own transaction, so writes made before
 * the engine starts are still recorded, and so two tabs never mint the same clock.
 */
export interface AccountSyncCaptureState {
  id: "capture"
  spaceId: string
  deviceId: string
  /** Per class: off stops capture and apply for that class on this device. */
  classes: SyncClasses
  /** The last clock this database issued or adopted. */
  hlc: HlcTime | null
}

/** `cursor`: how far this database has pulled and pushed. */
export interface AccountSyncCursorState {
  id: "cursor"
  spaceId: string
  /** Last serverSeq applied (or parked). */
  serverSeq: number
  /** Last deviceSeq the server acknowledged. */
  deviceSeq: number
}

export type AccountSyncStateRow = AccountSyncCaptureState | AccountSyncCursorState

/** A pulled op this device cannot apply yet. */
export interface AccountSyncInboxRow {
  serverSeq: number
  op: Op
  /** `schema`: written by a newer build; `key`: sealed under an epoch key not held yet. */
  reason: "schema" | "key"
  receivedAt: number
}
