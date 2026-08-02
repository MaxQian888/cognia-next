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
 *
 * Wave 2 additions: workflows / twinProfile / plugins / adapterInstances
 * / settings (the singleton AppSettings row). These power the mobile
 * read paths for workflow viewer, twin switcher, plugin toggles,
 * connector policy, and per-device preferences.
 */
export type SyncableTable =
  | "characters"
  | "skills"
  | "sessions"
  | "messages"
  | "workflows"
  | "twinProfile"
  | "plugins"
  | "adapterInstances"
  | "settings"
  // v49 — per-conversation overrides (pinned / archived / lastReadAt /
  // allowComputerUse / allowGoalDriving / mode / character / quietHours).
  // Mobile mirrors these so the Inbox can render pinned/unread state when
  // the companion server is unreachable.
  | "conversationOverrides"
  // Companion read-mostly views: mirror /goal console + long-term memory so
  // the phone can show goal progress and recalled memories from Dexie while
  // the desktop is unreachable. Both are authored on the desktop; mobile is
  // a viewer.
  | "goals"
  | "memories"
  // Workflow RUN history. Workflow *definitions* (`workflows`) already sync,
  // but their runs never did — so every mobile run surface (the library's
  // "active"/"sending" badges, RecentRunsFeed, MobileRunsList, the home
  // active-runs card) sat permanently empty, and a workflow triggered from
  // the phone vanished the moment its outbound job was sent. The phone is a
  // read-only viewer; runs are authored on the desktop that executes them.
  | "workflowRuns"
  // ADR-0056 (Wave 4) — configured MCP servers. The standalone webview engine
  // runs no MCP, and the phone has no `mcp_set_enabled` push RPC, so the mobile
  // `/me/mcp` page is a paired-only read-only viewer of the desktop's servers.
  // Mirroring this table is what lets it list the desktop's MCP config offline.
  | "mcpServers"
  // ADR-0039 (phase 2) — durable terminal command history. Authored on the
  // desktop by the terminal spawn-orchestrator; the phone has no shell and
  // never writes back, so this is a one-way read-only mirror powering the
  // mobile `/me/command-history` browse/search viewer. Rows carry no
  // `updatedAt`/`createdAt` — recency lives on the indexed `ts`, which the
  // desktop projector cursors on (see readTerminalHistoryDelta).
  | "terminalHistory"
  // v104 — Agent-Team board projection (team-board CQRS). One-way mirror of
  // the desktop agent-team-store (tasks + team-meta rows) so the phone can
  // render the kanban offline. Mobile is a viewer; edits travel back as
  // Companion RPC commands (`team_task_*`), never as data-level writes.
  | "agentTeamBoard"
  // Unified template platform portable projections. Device bindings,
  // credentials, local Twin preferences, and migration rollback snapshots
  // deliberately have no sync table.
  | "templateDefinitions"
  | "templatePackages"
  | "templateInstances"

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
