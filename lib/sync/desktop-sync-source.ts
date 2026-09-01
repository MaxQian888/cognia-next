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
  AppSettings,
  Skill,
  StoredMessage,
  ChatSession,
  Character,
  McpServerSummary,
} from "@cognia/agent-config-types"
import { CROSS_PLATFORM_SETTING_KEYS } from "@cognia/agent-config-types/settings-sync"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { ExecutionRun } from "@/types/execution/run"
import type { TerminalHistoryRow } from "@/lib/db/terminal-history"
import type { ConnectorDraftRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { getDb } from "@/lib/db/schema"
import { resolveTurnServerCredentials } from "@/lib/credentials/turn-credentials"
import { getProvisionedTurnSnapshot } from "@/lib/signaling/provisioned-turn-state"
import { useAccountStore } from "@/stores/account/account-store"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"

import { readTombstonesSince } from "./tombstones"
import type { SyncDelta, SyncableTable } from "./types"
import { portableExecutionContext } from "@/lib/task-workspace/managed-workspace"
import { createProfileDekStore, type ProfileDekHandle } from "@/lib/rag/profile-dek-store"
import { createMemorySyncRowV1, MEMORY_SYNC_PROFILE_ID } from "./memory-content-protocol"

/** Page size for paged tables (messages). One round-trip pulls at most this many rows. */
const MESSAGES_PAGE_SIZE = 500
export const MEMORY_COLD_START_LIMIT = 500

interface SyncPullRequestEvent {
  request_id: string
  table: SyncableTable | string
  since: number
  account_id?: string
  content_protocol_version?: number
}

interface DesktopSyncContentDeps {
  getMemoryDek: () => Promise<ProfileDekHandle>
  memoryColdStartLimit?: number
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
    const delta = await readDexieDelta(table, since, request.content_protocol_version)
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
  since: number,
  contentProtocolVersion?: number,
  contentDeps: DesktopSyncContentDeps = {
    getMemoryDek: () => createProfileDekStore().getOrCreate(MEMORY_SYNC_PROFILE_ID),
  }
): Promise<SyncDelta<unknown>> {
  if (table === "memories" && contentProtocolVersion !== 1) {
    throw new Error("upgrade_required: retrieval content protocol v1 is required")
  }
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
    case "executionRuns":
      return readExecutionRunsDelta(since)
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
    case "sessionState":
      return readSessionStateDelta(since)
    case "twins":
      return readTwinsDelta(since)
    case "twinDrafts":
      return readTwinDraftsDelta(since)
    case "projects":
      return readProjectsDelta(since)
    case "issues":
      return readIssuesDelta(since)
    case "issueProjects":
      return readIssueProjectsDelta(since)
    case "labels":
      return readLabelsDelta(since)
    case "issueEvents":
      return readIssueEventsDelta(since)
    case "issueRuns":
      return readIssueRunsDelta(since)
    case "goals":
      return readGoalsDelta(since)
    case "plans":
      return readPlansDelta(since)
    case "memories":
      return readMemoriesDelta(since, contentDeps)
    case "agentTeamBoard":
      return readAgentTeamBoardDelta(since)
    case "agentTasks":
      return readAgentTasksDelta(since)
    case "agentTaskAttempts":
      return readAgentTaskAttemptsDelta(since)
    case "templateDefinitions":
      return readTemplateDefinitionsDelta(since)
    case "templatePackages":
      return readTemplatePackagesDelta(since)
    case "templateInstances":
      return readTemplateInstancesDelta(since)
    case "agentTeams":
      return readAgentTeamsDelta(since)
    case "agentTeammates":
      return readAgentTeammatesDelta(since)
    case "agentTeamTasks":
      return readAgentTeamTasksDelta(since)
    case "connectorDrafts":
      return readConnectorDraftsDelta(since)
    case "outboundQueue":
      return readOutboundQueueDelta(since)
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
  const rows = (await getDb().sessions.where("updatedAt").above(since).toArray()).map((row) =>
    row.executionContext
      ? { ...row, executionContext: portableExecutionContext(row.executionContext) }
      : row
  )
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

async function readTemplateDefinitionsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().templateDefinitions.where("updatedAt").above(since).toArray()
  return finalizeDelta("templateDefinitions", rows, since)
}

async function readTemplatePackagesDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().templatePackages.where("importedAt").above(since).toArray()
  return finalizeDelta(
    "templatePackages",
    rows.map((item) => ({ ...item, updatedAt: item.importedAt })),
    since
  )
}

async function readTemplateInstancesDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().templateInstances.where("updatedAt").above(since).toArray()
  return finalizeDelta("templateInstances", rows, since)
}

/**
 * Squad definitions. `updatedAt` is stamped by the Dexie mirror rather than by
 * the domain types, which never had one, so the cursor is the mirror's record
 * of when it last wrote the row.
 */
async function readAgentTeamsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().agentTeams.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTeams", rows, since)
}

async function readAgentTeammatesDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().agentTeammates.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTeammates", rows, since)
}

async function readAgentTeamTasksDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().agentTeamTasks.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTeamTasks", rows, since)
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

/**
 * Strip the fields that only mean something on the machine that wrote them.
 *
 * `lease.expiresAt` is an absolute timestamp from the *executing desktop's*
 * clock, and the receiving client judges liveness with its own `Date.now()`
 * (`run-lease.ts:isLive`). Copying the row whole therefore hands a phone a
 * lease it can consider live or stale purely by clock skew, owned by an
 * `ownerId` that names a process it cannot reach. `cancelRequestedAt` is the
 * same shape of mistake: it is a request addressed to the lease holder.
 *
 * Nothing downstream of the sync needs either — the mobile surfaces read status
 * and timing — so they are projected out rather than translated.
 */
function projectRunForSync(run: WorkflowRunRow): WorkflowRunRow {
  if (run.lease === undefined && run.cancelRequestedAt === undefined) return run
  const { lease: _lease, cancelRequestedAt: _cancelRequestedAt, ...remote } = run
  return remote as WorkflowRunRow
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
  const page = ordered.slice(0, RUN_PAGE_SIZE).map(projectRunForSync)
  const hasMore = ordered.length > RUN_PAGE_SIZE
  return finalizeDelta("workflowRuns", page, since, hasMore, runActivityAt)
}

/**
 * Canonical execution summaries. Event rows stay device-local because they can
 * carry private detail; `latestSnapshot` is the deliberately remote-safe
 * projection consumed by Agent Runs and the execution monitor.
 */
async function readExecutionRunsDelta(since: number): Promise<SyncDelta<ExecutionRun>> {
  const rows = await getDb()
    .executionRuns.where("updatedAt")
    .above(since)
    .limit(RUN_PAGE_SIZE)
    .toArray()
  return finalizeDelta("executionRuns", rows, since, rows.length === RUN_PAGE_SIZE)
}

/**
 * Per-session unread pointers.
 *
 * Two shapes worth naming. The primary key is `sessionId`, not `id`, so the
 * wire row carries an `id` alias for the generic client handler; the handler
 * strips it again before writing. And the cursor is `updatedAt` rather than
 * `lastReadAt`, because `bumpUnread` preserves `lastReadAt` on purpose, so a
 * conversation going unread would otherwise never advance the watermark.
 * Legacy rows predate `updatedAt` and fall back to `lastReadAt`, which crosses
 * them once.
 *
 * No tombstones: a deleted session is already tombstoned on `sessions`, and an
 * orphaned state row counts toward nothing, because every reader resolves the
 * session before counting it (`aggregateGuildUnread` drops the misses).
 */
async function readSessionStateDelta(since: number): Promise<SyncDelta<unknown>> {
  const all = await getDb().sessionState.toArray()
  const rows = all
    .map((row) => ({ ...row, id: row.sessionId, updatedAt: row.updatedAt ?? row.lastReadAt ?? 0 }))
    .filter((row) => row.updatedAt > since)
  return finalizeDelta("sessionState", rows as UpdatedAtRow[], since)
}

/**
 * The Twin registry itself. Carries an `updatedAt` index, so this is a plain
 * range read like `skills`.
 */
async function readTwinsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().twins.where("updatedAt").above(since).toArray()
  return finalizeDelta("twins", rows as UpdatedAtRow[], since)
}

/**
 * Distilled drafts awaiting review.
 *
 * `TwinDraft` has no `updatedAt` at all — a draft is written once and then
 * mutated exactly once more, when it is reviewed. So the cursor is
 * `max(createdAt, reviewedAt)`: without the review half, a phone that pulled a
 * draft while it was pending would never learn it had been accepted, and the
 * review queue would keep offering an action the Host has already taken.
 *
 * Full scan rather than a range read because the table indexes neither field
 * (`&id, twinId, jobId, kind, status, ...`). Drafts are bounded by the output
 * of the distill jobs a user has actually run, which is the same shape
 * `readSessionStateDelta` and `readTwinProfileDelta` already scan. Adding an
 * index here would cost every existing install a schema upgrade for a table
 * measured in tens of rows.
 */
async function readTwinDraftsDelta(since: number): Promise<SyncDelta<unknown>> {
  const all = await getDb().twinDrafts.toArray()
  const rows = all
    .map((row) => ({ ...row, updatedAt: Math.max(row.createdAt ?? 0, row.reviewedAt ?? 0) }))
    .filter((row) => row.updatedAt > since)
  return finalizeDelta("twinDrafts", rows as UpdatedAtRow[], since)
}

/**
 * Workspaces.
 *
 * `Project` stores `createdAt` / `updatedAt` / `lastAccessedAt` as `Date`
 * objects, which JSON turns into ISO strings. The three consumers on the
 * phone (the header chip, the switcher, and the issue board's scope) sort and
 * compare them, so the wire carries epoch ms and `handlers/issues.ts` revives
 * them. Sending the `Date`s untouched would put strings in Dexie where the
 * type promises `Date`, which fails at the first `.getTime()`.
 *
 * The table indexes only `id` and `lastAccessedAt`, so this scans. There are
 * as many rows as the user has workspaces.
 */
async function readProjectsDelta(since: number): Promise<SyncDelta<unknown>> {
  const all = await getDb().projects.toArray()
  const rows = all
    .map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt).getTime(),
      updatedAt: new Date(row.updatedAt).getTime(),
      lastAccessedAt: new Date(row.lastAccessedAt).getTime(),
    }))
    .filter((row) => row.updatedAt > since)
  return finalizeDelta("projects", rows as UpdatedAtRow[], since)
}

async function readIssuesDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().issues.where("updatedAt").above(since).toArray()
  return finalizeDelta("issues", rows as UpdatedAtRow[], since)
}

async function readIssueProjectsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().issueProjects.where("updatedAt").above(since).toArray()
  return finalizeDelta("issueProjects", rows as UpdatedAtRow[], since)
}

async function readLabelsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().labels.where("updatedAt").above(since).toArray()
  return finalizeDelta("labels", rows as UpdatedAtRow[], since)
}

/**
 * The activity trail.
 *
 * An event is appended and never edited, so it carries no `updatedAt` and the
 * cursor is `ts`, which is indexed. `finalizeDelta` reads `updatedAt ??
 * createdAt` by default and would find neither, so the watermark is passed
 * explicitly rather than aliased onto the row: an `updatedAt` written here
 * would end up persisted on a type that has no such field.
 */
async function readIssueEventsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().issueEvents.where("ts").above(since).toArray()
  return finalizeDelta("issueEvents", rows as UpdatedAtRow[], since, false, (row) =>
    Number((row as { ts?: number }).ts ?? 0)
  )
}

/**
 * Dispatch history. Unlike the trail, a run row IS rewritten in place when the
 * engine settles it, so `updatedAt` is both present and indexed.
 */
async function readIssueRunsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().issueRuns.where("updatedAt").above(since).toArray()
  return finalizeDelta("issueRuns", rows as UpdatedAtRow[], since)
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

async function readMcpServersDelta(since: number): Promise<SyncDelta<McpServerSummary>> {
  const rows = await getDb().mcpServerSummaries.where("updatedAt").above(since).toArray()
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

/**
 * ADR-0131 inbox relay — drafts are mirrored in FULL (segments included): a
 * thin client renders and edits them before approving. Cursor is the v173
 * `updatedAt` index that every writer in `lib/db/connector-drafts.ts` stamps.
 */
async function readConnectorDraftsDelta(since: number): Promise<SyncDelta<ConnectorDraftRow>> {
  const rows = await getDb().connectorDrafts.where("updatedAt").above(since).toArray()
  return finalizeDelta("connectorDrafts", rows, since)
}

/**
 * The status PROJECTION of one outbound job as mirrored to a thin client
 * (ADR-0131). Deliberately excludes the payload — `request.segments` is
 * emptied and only the delivery-target reference + metadata travel — so the
 * wire carries delivery state, not message bodies (those already sync
 * through `messages`), and a client can never re-dispatch it:
 * `nextAttemptAt: 0` + `syncedFromHost: true` keep it out of every local
 * runner query (`lib/db/outbound-jobs.ts:isLocallyDispatchable`).
 */
export type OutboundQueueProjectionRow = Pick<
  OutboundJobRow,
  | "id"
  | "adapterId"
  | "conversationKey"
  | "status"
  | "lastError"
  | "lastErrorCode"
  | "attempts"
  | "createdAt"
  | "updatedAt"
  | "orderSeq"
  | "source"
  | "platformMessageId"
  | "idempotencyKey"
> & {
  request: Pick<OutboundRequest, "conversationRef" | "metadata"> & { segments: [] }
  nextAttemptAt: 0
  syncedFromHost: true
}

export function projectOutboundJobRow(row: OutboundJobRow): OutboundQueueProjectionRow {
  return {
    id: row.id,
    adapterId: row.adapterId,
    conversationKey: row.conversationKey,
    status: row.status,
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    ...(row.lastErrorCode !== undefined ? { lastErrorCode: row.lastErrorCode } : {}),
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
    ...(row.orderSeq !== undefined ? { orderSeq: row.orderSeq } : {}),
    source: row.source,
    ...(row.platformMessageId !== undefined ? { platformMessageId: row.platformMessageId } : {}),
    idempotencyKey: row.idempotencyKey,
    request: {
      conversationRef: row.request.conversationRef,
      segments: [],
      metadata: row.request.metadata,
    },
    nextAttemptAt: 0,
    syncedFromHost: true,
  }
}

async function readOutboundQueueDelta(
  since: number
): Promise<SyncDelta<OutboundQueueProjectionRow>> {
  const rows = await getDb().outboundQueue.where("updatedAt").above(since).toArray()
  // Never re-export a projection this host itself mirrored from a further
  // upstream host (desktop-as-thin-client): its own paired phones would see a
  // row this host does not own.
  const owned = rows.filter((row) => row.syncedFromHost !== true)
  return finalizeDelta("outboundQueue", owned.map(projectOutboundJobRow), since)
}

async function readGoalsDelta(since: number): Promise<SyncDelta<unknown>> {
  // chatGoals carries an `updatedAt` index (schema `…, createdAt, updatedAt`),
  // so pull only the rows past the cursor instead of scanning the whole table.
  const rows = await getDb().chatGoals.where("updatedAt").above(since).toArray()
  return finalizeDelta("goals", rows as UpdatedAtRow[], since)
}

async function readPlansDelta(since: number): Promise<SyncDelta<unknown>> {
  // `agentPlans` carries an `updatedAt` index (schema v71), so this is a range
  // read rather than a table scan — same shape as `readGoalsDelta`.
  const rows = await getDb().agentPlans.where("updatedAt").above(since).toArray()
  return finalizeDelta("plans", rows as UpdatedAtRow[], since)
}

async function readMemoriesDelta(
  since: number,
  contentDeps: DesktopSyncContentDeps
): Promise<SyncDelta<unknown>> {
  const coldStartLimit = contentDeps.memoryColdStartLimit ?? MEMORY_COLD_START_LIMIT
  if (!Number.isInteger(coldStartLimit) || coldStartLimit < 1) {
    throw new Error("Memory cold-start limit must be positive")
  }
  const rows =
    since === 0
      ? await getDb().memories.orderBy("updatedAt").reverse().limit(coldStartLimit).toArray()
      : await getDb().memories.where("updatedAt").above(since).toArray()
  if (rows.length === 0) return finalizeDelta("memories", [], since)
  const dek = await contentDeps.getMemoryDek()
  const encryptedRows = await Promise.all(rows.map((row) => createMemorySyncRowV1(row, dek)))
  return finalizeDelta("memories", encryptedRows, since)
}

async function readAgentTeamBoardDelta(since: number): Promise<SyncDelta<unknown>> {
  // v104 board projection rows carry an indexed `updatedAt` stamped by the
  // desktop projector (`lib/db/agent-team-projection.ts`) — cursor directly.
  const rows = await getDb().agentTeamBoard.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTeamBoard", rows as UpdatedAtRow[], since)
}

async function readAgentTasksDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().agentTasks.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTasks", rows, since)
}

async function readAgentTaskAttemptsDelta(since: number): Promise<SyncDelta<unknown>> {
  const rows = await getDb().agentTaskAttempts.where("updatedAt").above(since).toArray()
  return finalizeDelta("agentTaskAttempts", rows, since)
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
  const provisionedTurn = getProvisionedTurnSnapshot()
  const updatedAt = Math.max(
    Number((row as { updatedAt?: number }).updatedAt ?? 0),
    provisionedTurn.updatedAt
  )
  if (since === 0 || updatedAt > since) {
    return {
      rows: [await projectMirroredSettings(row, provisionedTurn.servers, updatedAt)],
      deleted_ids: [],
      next_since: updatedAt > 0 ? updatedAt : Date.now(),
    }
  }
  return { rows: [], deleted_ids: [], next_since: since }
}

/**
 * Narrow the settings singleton to the fields a paired client is allowed to
 * see, before it goes on the wire.
 *
 * This used to emit the whole row. The client only *applied* the mirrored
 * subset, so the omission looked harmless — but the full row had already
 * crossed the wire, which meant every paired device received the host's
 * `apiKey`, `apiBaseUrl`, `providerSettings`, `customProviders`,
 * `searchProviders`, `skillsShToken`, `subscriptionSettings`, `webdavSync`
 * credentials and `networkProxy` auth. The `app_settings_update` allowlist
 * documented "provider configuration stays desktop-only", but that only ever
 * constrained the write direction; nothing constrained the read direction.
 *
 * Redacting at the source rather than at the client is the point: a client
 * cannot un-receive a secret, and non-first-party clients speak this same wire
 * protocol.
 */
async function projectMirroredSettings(
  row: AppSettings,
  provisionedTurnServers: RTCIceServer[],
  updatedAt: number
): Promise<Partial<AppSettings>> {
  // `id` and `updatedAt` are envelope fields, not preferences: the client keys
  // its singleton by `id` and the cursor arithmetic above reads `updatedAt`.
  const projected: Record<string, unknown> = {
    id: row.id,
    updatedAt,
  }
  for (const key of CROSS_PLATFORM_SETTING_KEYS) {
    if (row[key] !== undefined) projected[key] = row[key]
  }
  const staticTurnServers = row.turnServers
    ? await resolveTurnServerCredentials(row.turnServers)
    : []
  if (row.turnServers !== undefined || provisionedTurnServers.length > 0) {
    projected.turnServers = [...staticTurnServers, ...provisionedTurnServers]
  }
  return projected as Partial<AppSettings>
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
