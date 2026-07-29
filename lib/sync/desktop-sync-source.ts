"use client"

/**
 * Desktop-side counterpart of the Rust `companion::sync_bridge`
 * (M4.7 / #51).
 *
 * On every Tauri-only boot, this module subscribes to the
 * `companion://sync-pull-request` event the Rust HTTP handler emits when
 * the phone calls `_rpc/sync_pull`. For each request we run the
 * appropriate Dexie query, build a [`SyncDelta`], and ship it back via
 * the `companion_sync_pull_response` Tauri command.
 *
 * The phone never talks directly to Dexie — it asks Rust, Rust asks the
 * desktop WebView, the WebView reads Dexie, and the same string of
 * primitives carries the answer all the way back.
 */

import type {
  Skill,
  StoredMessage,
  ChatSession,
  Character,
  McpServer,
} from "@cognia/agent-config-types"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TerminalHistoryRow } from "@/lib/db/terminal-history"
import { getDb } from "@/lib/db/schema"
import { useAccountStore } from "@/stores/account/account-store"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"

import { readTombstonesSince } from "./tombstones"
import type { SyncDelta, SyncableTable } from "./types"

/** Page size for paged tables (messages). One round-trip pulls at most this many rows. */
const MESSAGES_PAGE_SIZE = 500

interface SyncPullRequestEvent {
  request_id: string
  table: SyncableTable | string
  since: number
  account_id?: string
}

const REQUEST_EVENT = "companion://sync-pull-request"
const RESPONSE_COMMAND = "companion_sync_pull_response"

/** Tiny Tauri shape so the file types-check in pure-web tests too. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

let installed = false

export interface InstallOptions {
  /** Inject a Tauri bridge for tests; defaults to the dynamic real one. */
  bridge?: TauriBridge
  /** Override the singleton-guard for tests. */
  forceReinstall?: boolean
}

export async function installDesktopSyncSource(opts: InstallOptions = {}): Promise<() => void> {
  if (installed && !opts.forceReinstall) return () => {}
  installed = true

  let bridge: TauriBridge
  if (opts.bridge) {
    bridge = opts.bridge
  } else {
    try {
      bridge = { listen, invoke }
    } catch {
      installed = false
      return () => {}
    }
  }

  const unlisten = await bridge.listen<SyncPullRequestEvent>(REQUEST_EVENT, (event) => {
    void respondToSyncRequest(event.payload, bridge)
  })

  return () => {
    installed = false
    unlisten()
  }
}

async function respondToSyncRequest(
  request: SyncPullRequestEvent,
  bridge: TauriBridge
): Promise<void> {
  const { request_id, table, since } = request
  try {
    assertRequestAccountMatchesActiveAccount(request)
    const delta = await readDexieDelta(table, since)
    await bridge.invoke(RESPONSE_COMMAND, { requestId: request_id, delta, error: null })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId: request_id,
      delta: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function assertRequestAccountMatchesActiveAccount(request: SyncPullRequestEvent): void {
  const activeAccountId = useAccountStore.getState().unlockedAccountId
  if (!activeAccountId) {
    throw new Error("sync pull rejected: no unlocked local account")
  }
  if (!request.account_id) {
    throw new Error("sync pull rejected: missing local account id")
  }
  if (request.account_id !== activeAccountId) {
    throw new Error("sync pull rejected: account mismatch")
  }
}

/** Exposed for tests — production callers use the listener installed above. */
export async function readDexieDelta(
  table: SyncableTable | string,
  since: number
): Promise<SyncDelta<unknown>> {
  switch (table) {
    case "characters":
      return readCharactersDelta(since)
    case "skills":
      return readSkillsDelta(since)
    case "sessions":
      return readSessionsDelta(since)
    case "messages":
      return readMessagesDelta(since)
    case "workflows":
      return readWorkflowsDelta(since)
    case "workflowRuns":
      return readWorkflowRunsDelta(since)
    case "twinProfile":
      return readTwinProfileDelta(since)
    case "plugins":
      return readPluginsDelta(since)
    case "adapterInstances":
      return readAdapterInstancesDelta(since)
    case "mcpServers":
      return readMcpServersDelta(since)
    case "terminalHistory":
      return readTerminalHistoryDelta(since)
    case "settings":
      return readSettingsDelta(since)
    case "conversationOverrides":
      return readConversationOverridesDelta(since)
    case "goals":
      return readGoalsDelta(since)
    case "memories":
      return readMemoriesDelta(since)
    case "agentTeamBoard":
      return readAgentTeamBoardDelta(since)
    default:
      throw new Error(`unknown sync table: ${table}`)
  }
}

async function readCharactersDelta(since: number): Promise<SyncDelta<Character>> {
  const rows = (await getDb().characters.where("updatedAt").above(since).toArray()).filter(
    (row) => !row.isBuiltIn
  )
  return finalizeDelta("characters", rows, since)
}

async function readSkillsDelta(since: number): Promise<SyncDelta<Skill>> {
  // skills carries an `updatedAt` index (schema `id, name, updatedAt, ...`),
  // so pull only the rows past the cursor instead of scanning the whole
  // table into memory and filtering — a large skill library otherwise
  // hydrated every row on every pull. Mirrors readSessionsDelta.
  const rows = await getDb().skills.where("updatedAt").above(since).toArray()
  return finalizeDelta("skills", rows, since)
}

async function readSessionsDelta(since: number): Promise<SyncDelta<ChatSession>> {
  const rows = await getDb().sessions.where("updatedAt").above(since).toArray()
  return finalizeDelta("sessions", rows, since)
}

async function readMessagesDelta(since: number): Promise<SyncDelta<StoredMessage>> {
  const index = getDb().messages.orderBy("[createdAt+id]")

  if (since === 0) {
    // Cold-start fold: transfer only the newest global tail. The session rows
    // already carry list previews, and opening a conversation hydrates its
    // complete transcript through `message_get_by_session`. This bounds boot
    // payload/round-trips independently of account age while retaining full
    // history on demand.
    const newest = await index.reverse().limit(MESSAGES_PAGE_SIZE).toArray()
    newest.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    return finalizeDelta("messages", newest, since, false)
  }

  // Incremental pulls still drain every newly-created row after the durable
  // cursor, in ascending order, so live/offline changes are never folded away.
  const page = await getDb()
    .messages.where("[createdAt+id]")
    .above([since, ""])
    .limit(MESSAGES_PAGE_SIZE)
    .toArray()
  return finalizeDelta("messages", page, since, page.length === MESSAGES_PAGE_SIZE)
}

async function readWorkflowsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().workflows.where("updatedAt").above(since).toArray()
  return finalizeDelta("workflows", rows as UpdatedAtRow[], since)
}

/**
 * Workflow RUN history. Unlike the other tables, run rows carry no
 * `updatedAt` — a run is written at creation (`startedAt`) and again at
 * completion (`completedAt`), and the mobile run surfaces only care about the
 * status flip across those two moments. So the cursor rides
 * `max(startedAt, completedAt)`: a run crosses the wire once when it starts
 * (status "running") and once when it finishes (final status), which is
 * exactly what the library badges / runs feed need.
 *
 * Both `startedAt` and `completedAt` are indexed (schema v22), so we union the
 * two range queries instead of scanning the whole table. The first sync
 * (`since === 0`) is bounded to the last 30 days, and the result is paged
 * (oldest-activity first) so a heavy run history streams across several pulls
 * rather than one multi-MB payload — each run embeds its `workflowSnapshot`.
 */
const RUN_FIRST_SYNC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const RUN_PAGE_SIZE = 200

function runActivityAt(run: WorkflowRunRow): number {
  return Math.max(run.startedAt ?? 0, run.completedAt ?? 0)
}

async function readWorkflowRunsDelta(since: number): Promise<SyncDelta<WorkflowRunRow>> {
  const db = getDb()
  // Floor the first full sync to a recent window so a years-deep run history
  // doesn't hydrate in one shot; incremental pulls use the real cursor.
  const floor = since === 0 ? Math.max(0, Date.now() - RUN_FIRST_SYNC_WINDOW_MS) : since
  const [started, completed] = await Promise.all([
    db.workflowRuns.where("startedAt").above(floor).toArray(),
    db.workflowRuns.where("completedAt").above(floor).toArray(),
  ])
  const byId = new Map<string, WorkflowRunRow>()
  for (const run of [...started, ...completed]) {
    if (runActivityAt(run) > since) byId.set(run.id, run)
  }
  const ordered = [...byId.values()].sort((a, b) => runActivityAt(a) - runActivityAt(b))
  const page = ordered.slice(0, RUN_PAGE_SIZE)
  const hasMore = ordered.length > RUN_PAGE_SIZE
  return finalizeDelta("workflowRuns", page, since, hasMore, runActivityAt)
}

async function readTwinProfileDelta(since: number): Promise<SyncDelta<unknown>> {
  // twinProfile rows track changes via updatedAt; older rows without an
  // updatedAt always sync once and then settle.
  const all = await getDb().twinProfile.toArray()
  const rows = all.filter((row) => Number((row as { updatedAt?: number }).updatedAt ?? 0) > since)
  return finalizeDelta("twinProfile", rows as UpdatedAtRow[], since)
}

async function readPluginsDelta(since: number): Promise<SyncDelta<unknown>> {
  const all = await getDb().plugins.toArray()
  const rows = all.filter((row) => Number((row as { updatedAt?: number }).updatedAt ?? 0) > since)
  return finalizeDelta("plugins", rows as UpdatedAtRow[], since)
}

async function readAdapterInstancesDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().adapterInstances.where("updatedAt").above(since).toArray()
  return finalizeDelta("adapterInstances", rows as UpdatedAtRow[], since)
}

async function readMcpServersDelta(since: number): Promise<SyncDelta<McpServer>> {
  // mcpServers carries `updatedAt` (set on every create/update) but the index
  // is `id, name, enabled` — no `updatedAt` index — so we read all and filter,
  // mirroring readPluginsDelta. The configured-server set is small. The mobile
  // `/me/mcp` page is a read-only viewer, so deltas only ever flow desktop→phone.
  const all = await getDb().mcpServers.toArray()
  const rows = all.filter((row) => Number(row.updatedAt ?? 0) > since)
  return finalizeDelta("mcpServers", rows, since)
}

/**
 * Durable terminal command history (ADR-0039 phase 2). Unlike every other
 * synced table, `terminalHistory` rows carry no `updatedAt`/`createdAt` — the
 * only monotonic field is `ts` (last-execution epoch ms), which schema v74
 * indexes. So we range-query on `ts` and ride the cursor on `ts` via the
 * `finalizeDelta` override, exactly the way `readWorkflowRunsDelta` cursors on
 * `max(startedAt, completedAt)`.
 *
 * Re-run semantics are correct as-is: re-executing a command bumps `ts` on the
 * same `id`, so the row re-crosses the wire and the phone's `bulkPut`
 * overwrites in place. Prune-deletions are not tombstoned (same as
 * mcpServers/settings) — the phone ages stale rows out passively.
 */
async function readTerminalHistoryDelta(since: number): Promise<SyncDelta<TerminalHistoryRow>> {
  const rows = await getDb().terminalHistory.where("ts").above(since).toArray()
  return finalizeDelta("terminalHistory", rows, since, false, (r) => r.ts)
}

async function readConversationOverridesDelta(since: number): Promise<SyncDelta<unknown>> {
  // v49 table; carries an `updatedAt` index (schema `&id, &conversationKey,
  // sessionId, pinned, archived, updatedAt`). Mobile mirrors pinned /
  // archived / lastReadAt so the Inbox renders correct buckets offline.
  const rows = await getDb().conversationOverrides.where("updatedAt").above(since).toArray()
  return finalizeDelta("conversationOverrides", rows as unknown as UpdatedAtRow[], since)
}

async function readGoalsDelta(since: number): Promise<SyncDelta<unknown>> {
  // chatGoals carries an `updatedAt` index (schema `…, createdAt, updatedAt`),
  // so pull only the rows past the cursor instead of scanning the whole table.
  const rows = await getDb().chatGoals.where("updatedAt").above(since).toArray()
  return finalizeDelta("goals", rows as UpdatedAtRow[], since)
}

async function readMemoriesDelta(since: number): Promise<SyncDelta<unknown>> {
  // memories has an `updatedAt` field but NOT an index on it (schema indexes
  // scope/type/status/…), so we can't `.where("updatedAt").above`. Read all
  // and filter — mirrors readPluginsDelta. The personal memory store is small.
  const all = await getDb().memories.toArray()
  const rows = all.filter((row) => Number((row as { updatedAt?: number }).updatedAt ?? 0) > since)
  return finalizeDelta("memories", rows as UpdatedAtRow[], since)
}

async function readAgentTeamBoardDelta(since: number): Promise<SyncDelta<unknown>> {
  // v104 board projection rows carry an indexed `updatedAt` stamped by the
  // desktop projector (`lib/db/agent-team-projection.ts`) — cursor directly.
  const rows = await getDb().agentTeamBoard.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTeamBoard", rows as UpdatedAtRow[], since)
}

/**
 * Settings is a singleton row keyed `"singleton"`. We don't have a
 * per-row `updatedAt` field on it, so the rule is: emit the row whenever
 * the caller has never pulled it (`since === 0`) OR if it was changed
 * since the cursor. The mobile cache then warms once and any subsequent
 * pulls return an empty delta until the cursor is reset.
 */
async function readSettingsDelta(since: number): Promise<SyncDelta<unknown>> {
  const row = await getDb().settings.get("singleton")
  if (!row) return { rows: [], deleted_ids: [], next_since: since }
  const updatedAt = Number((row as { updatedAt?: number }).updatedAt ?? 0)
  if (since === 0 || updatedAt > since) {
    return {
      rows: [row],
      deleted_ids: [],
      next_since: updatedAt > 0 ? updatedAt : Date.now(),
    }
  }
  return { rows: [], deleted_ids: [], next_since: since }
}

interface UpdatedAtRow {
  id: string
  updatedAt?: number
  createdAt?: number
}

async function finalizeDelta<T extends UpdatedAtRow>(
  table: SyncableTable,
  rows: T[],
  since: number,
  hasMore = false,
  /**
   * How to read a row's cursor watermark. Defaults to `updatedAt ?? createdAt`
   * — the shape every other table carries. `workflowRuns` has neither, so it
   * passes `max(startedAt, completedAt)` instead (see readWorkflowRunsDelta).
   */
  cursorOf: (row: T) => number = (row) => Number(row.updatedAt ?? row.createdAt ?? 0)
): Promise<SyncDelta<T>> {
  // Fold in tombstones recorded since the cursor (v61). The phone applies
  // `deleted_ids` via `bulkDelete`, so a desktop deletion finally reaches
  // it. `deletedAt` shares the cursor space with `updatedAt` — both feed
  // `next_since` so each upsert and each tombstone crosses the wire once.
  const { ids: deletedIds, maxDeletedAt } = await readTombstonesSince(table, since)

  let highestCursor = since
  for (const row of rows) {
    const candidate = cursorOf(row)
    if (candidate > highestCursor) highestCursor = candidate
  }
  if (maxDeletedAt > highestCursor) highestCursor = maxDeletedAt

  return {
    rows,
    deleted_ids: deletedIds,
    next_since: highestCursor,
    has_more: hasMore,
  }
}

/** Test-only — reset the install guard. */
export function __resetInstalledForTests(): void {
  installed = false
}
