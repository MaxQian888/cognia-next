"use client"

/**
 * Companion sync orchestrator (M4.7 / #51).
 *
 * Drives the four per-table handlers, persists per-table cursors in
 * memory, and exposes a small status observable for the UI to show
 * "synced X seconds ago" badges. Persisted cursors are V2 work — V1's
 * in-memory map matches the issue's "no new Dexie table" constraint.
 *
 * Trigger points wired here:
 *   1. **Manual** — `runSyncDown()` is exported so the UI can call it
 *      from a "Sync now" button.
 *   2. **Foreground** — `installForegroundSync()` re-runs on
 *      `visibilitychange === 'visible'`; idempotent registration.
 *   3. **WS deltas** — `installEventDrivenSync()` subscribes to a
 *      catch-all `sync://invalidate` channel; the server emits one
 *      whenever it commits a sync-relevant write (left for HITL Rust
 *      work).
 *
 * This file does not call the transport directly — it goes through
 * `lib/tauri.ts:transport`, so the same code runs on Tauri (no-op,
 * data is local), Capacitor (real sync), and web (no-op, no companion
 * paired).
 */

import { subscribeResume } from "@/lib/capacitor/app"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import { companionCursorNamespace } from "@/lib/companion/credential-book/legacy-migration"
import { getDb } from "@/lib/db/schema"
import { transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import type { Transport } from "@/lib/tauri/transport-types"
import type { RunStatus } from "@/types/workflow/visual"

import { clearCursors, loadCursors, saveCursor } from "./cursor-store"
import { whenIdle, yieldToMain } from "./scheduling"
import { syncAdapterInstances } from "./handlers/adapter-instances"
import { syncAgentTeamBoard } from "./handlers/agent-team-board"
import { syncAgentTaskAttempts, syncAgentTasks } from "./handlers/agent-tasks"
import { syncAppSettings } from "./handlers/app-settings"
import { syncCharacters } from "./handlers/characters"
import { syncConversationOverrides } from "./handlers/conversation-overrides"
import { syncExecutionRuns } from "./handlers/execution-runs"
import { syncGoals } from "./handlers/goals"
import { syncPlans } from "./handlers/plans"
import { syncMcpServers } from "./handlers/mcp-servers"
import { syncMemories } from "./handlers/memory"
import { syncMessages } from "./handlers/messages"
import { syncPlugins } from "./handlers/plugins"
import { syncSessions } from "./handlers/sessions"
import { syncSkills } from "./handlers/skills"
import { syncConnectorDrafts } from "./handlers/connector-drafts"
import { syncOutboundQueue } from "./handlers/outbound-queue"
import { syncTerminalHistory } from "./handlers/terminal-history"
import { syncTwinProfile } from "./handlers/twin-profile"
import { syncWorkflows } from "./handlers/workflows"
import { syncWorkflowRuns } from "./handlers/workflow-runs"
import {
  syncTemplateDefinitions,
  syncTemplateInstances,
  syncTemplatePackages,
} from "./handlers/template-platform"
import {
  syncAgentTeamTasks,
  syncAgentTeammates,
  syncAgentTeams,
} from "./handlers/agent-team-definitions"
import type { SyncCursor, SyncOutcome, SyncableTable } from "./types"

export type SyncFn = (transport: Transport, cursor: SyncCursor) => Promise<SyncOutcome>

interface RegisteredHandler {
  table: SyncableTable
  stage: SyncStage
  run: SyncFn
}

/** A handler as a caller may supply it — {@link RegisteredHandler} with an optional stage. */
export type SyncHandlerOverride = Omit<RegisteredHandler, "stage"> & { stage?: SyncStage }

/**
 * Sync stages — the order a client learns about its Host.
 *
 * Every table used to be pulled in one uninterrupted run before the shell was
 * allowed to call itself online, so a paired client sat on "connecting" for as
 * long as the slowest table took, and the surfaces that were ready long before
 * the last template package landed stayed dark anyway.
 *
 * The stages answer one question per table: *what is this client unable to
 * show until this table arrives?*
 *
 *   `critical`     the first screen. Preferences, the chat list and the state
 *                  that decides how it is bucketed. Nothing renders honestly
 *                  without these, so the connection is not "online" until they
 *                  land — and there are only four of them.
 *   `interactive`  what the user reaches for next: transcripts, plans, tasks,
 *                  runs, the Inbox. Wanted within seconds, not needed to paint.
 *   `background`   libraries and configuration surfaces — skills, workflows,
 *                  memories, plugins, MCP servers, templates. A settings page
 *                  the user has not opened can afford to fill in behind them.
 *
 * A stage is a scheduling statement, not an authority one: every table still
 * has the same Host authority and the same tombstone policy
 * ({@link COMPANION_SYNC_DOMAINS}). Re-ordering a table changes when it shows
 * up, never whether it is trusted.
 */
export const SYNC_STAGES = ["critical", "interactive", "background"] as const

export type SyncStage = (typeof SYNC_STAGES)[number]

/** Stage assumed for an injected handler that does not declare one. */
const DEFAULT_HANDLER_STAGE: SyncStage = "critical"

const DEFAULT_HANDLERS: RegisteredHandler[] = [
  // ── critical ──────────────────────────────────────────────────────────
  // Device preferences first: the shell reads them while painting, and the
  // merge is a single row.
  { table: "settings", stage: "critical", run: syncAppSettings },
  // Characters before sessions: a session row names a character, and a chat
  // list that arrives first renders rows with no identity for one frame.
  { table: "characters", stage: "critical", run: syncCharacters },
  { table: "sessions", stage: "critical", run: syncSessions },
  // v49 — Inbox optimization. Mobile reads pinned/archived/unread state
  // from conversationOverrides; without this handler the orchestrator
  // never pulls it and the mobile inbox renders every conversation as
  // unread + unpinned. It is critical for the same reason `sessions` is:
  // the list is wrong, not merely empty, without it.
  { table: "conversationOverrides", stage: "critical", run: syncConversationOverrides },

  // ── interactive ───────────────────────────────────────────────────────
  // The transcript tail. Paged, and the largest payload in the pipeline —
  // which is exactly why it must not gate the first paint.
  { table: "messages", stage: "interactive", run: syncMessages },
  { table: "agentTasks", stage: "interactive", run: syncAgentTasks },
  { table: "agentTaskAttempts", stage: "interactive", run: syncAgentTaskAttempts },
  // ADR-0045 — AgentPlan rows. The companion mounts the approval dock and the
  // step tracker; without this pull they read an empty local table and a
  // plan-mode turn taken through the companion has nothing to approve.
  { table: "plans", stage: "interactive", run: syncPlans },
  // Companion read-mostly views (Goals console). Mobile mirrors these so the
  // phone can show goal progress from Dexie offline; authored on the desktop.
  { table: "goals", stage: "interactive", run: syncGoals },
  // v104 — Agent-Team board projection (team-board CQRS). One-way mirror of
  // the desktop task board (tasks + team-meta rows) so the mobile workspace
  // can render the kanban offline; controls travel back as Companion RPC.
  { table: "agentTeamBoard", stage: "interactive", run: syncAgentTeamBoard },
  // Canonical, remote-safe run summaries. Detailed/private event rows remain
  // on the executing host and are never part of companion sync.
  { table: "executionRuns", stage: "interactive", run: syncExecutionRuns },
  // Workflow run history — mirrors execution state so the mobile library
  // badges, runs feed, and active-runs card reflect runs (incl. phone-
  // triggered ones). Definitions sync in `background`; this is runs.
  { table: "workflowRuns", stage: "interactive", run: syncWorkflowRuns },
  // ADR-0131 cross-shell inbox relay — drafts in full (the phone edits and
  // approves them), outbound as a status projection (`syncedFromHost`), so a
  // thin client's Inbox shows delivery state without running any adapter.
  { table: "connectorDrafts", stage: "interactive", run: syncConnectorDrafts },
  { table: "outboundQueue", stage: "interactive", run: syncOutboundQueue },

  // ── background ────────────────────────────────────────────────────────
  { table: "skills", stage: "background", run: syncSkills },
  // Wave 4 / ADR-0026 — the workflow viewer, twin profile, plugin toggles and
  // connector policy: settings-shaped surfaces, served from Dexie when the
  // server is unreachable, and none of them on the first screen.
  { table: "workflows", stage: "background", run: syncWorkflows },
  { table: "twinProfile", stage: "background", run: syncTwinProfile },
  { table: "plugins", stage: "background", run: syncPlugins },
  { table: "adapterInstances", stage: "background", run: syncAdapterInstances },
  // Long-term memory. Decrypts row by row against the profile DEK, so it is
  // the most CPU-expensive apply in the pipeline — last, and interruptible.
  { table: "memories", stage: "background", run: syncMemories },
  // ADR-0056 (Wave 4) — configured MCP servers. Read-only mirror so the
  // mobile `/me/mcp` page can list the desktop's servers (the phone has no
  // MCP push RPC and the standalone engine runs no MCP).
  { table: "mcpServers", stage: "background", run: syncMcpServers },
  // ADR-0039 (phase 2) — durable terminal command history. One-way read-only
  // mirror (desktop → phone) powering the mobile `/me/command-history` browse
  // /search viewer; the phone has no shell, so it never writes back.
  { table: "terminalHistory", stage: "background", run: syncTerminalHistory },
  { table: "templateDefinitions", stage: "background", run: syncTemplateDefinitions },
  { table: "templatePackages", stage: "background", run: syncTemplatePackages },
  { table: "templateInstances", stage: "background", run: syncTemplateInstances },
  // v215 — Squad definitions. Background, and after the runs they explain: a
  // roster arriving before its squad is a row with nothing to attach to.
  { table: "agentTeams", stage: "background", run: syncAgentTeams },
  { table: "agentTeammates", stage: "background", run: syncAgentTeammates },
  { table: "agentTeamTasks", stage: "background", run: syncAgentTeamTasks },
]

/** Which stage each table is pulled in. */
export const SYNC_TABLE_STAGES: Readonly<Record<SyncableTable, SyncStage>> = Object.freeze(
  Object.fromEntries(DEFAULT_HANDLERS.map((h) => [h.table, h.stage]))
) as Readonly<Record<SyncableTable, SyncStage>>

/** The tables in a stage, in the order the orchestrator runs them. */
export function syncTablesForStage(stage: SyncStage): readonly SyncableTable[] {
  return DEFAULT_HANDLERS.filter((h) => h.stage === stage).map((h) => h.table)
}

/**
 * Tables sync'd by the orchestrator, in execution order. Exported so the
 * Settings → Mobile Companion → "Sync status" card can list every handler
 * without hard-coding the names — keeps the UI in lock-step with the
 * registry above.
 */
export const SYNC_HANDLER_TABLES: readonly SyncableTable[] = DEFAULT_HANDLERS.map((h) => h.table)

export interface CompanionSyncDomainDescriptor {
  authority: "host"
  direction: "host-to-client"
  sensitivity: "internal" | "confidential"
  cursor: "updated-at" | "opaque"
  deletionPolicy: "tombstone" | "append-only" | "ttl"
  allowedWrites: readonly ["host"]
}

const syncDomain = (
  deletionPolicy: CompanionSyncDomainDescriptor["deletionPolicy"],
  sensitivity: CompanionSyncDomainDescriptor["sensitivity"] = "confidential",
  cursor: CompanionSyncDomainDescriptor["cursor"] = "updated-at"
): CompanionSyncDomainDescriptor => ({
  authority: "host",
  direction: "host-to-client",
  sensitivity,
  cursor,
  deletionPolicy,
  allowedWrites: ["host"],
})

/** Governance contract for every installed table handler. */
export const COMPANION_SYNC_DOMAINS: Readonly<
  Record<SyncableTable, CompanionSyncDomainDescriptor>
> = Object.freeze({
  characters: syncDomain("tombstone"),
  skills: syncDomain("tombstone"),
  sessions: syncDomain("tombstone"),
  agentTasks: syncDomain("tombstone"),
  agentTaskAttempts: syncDomain("append-only"),
  messages: syncDomain("tombstone"),
  workflows: syncDomain("tombstone"),
  twinProfile: syncDomain("tombstone"),
  plugins: syncDomain("tombstone"),
  adapterInstances: syncDomain("tombstone"),
  settings: syncDomain("tombstone", "internal"),
  conversationOverrides: syncDomain("tombstone"),
  goals: syncDomain("tombstone"),
  plans: syncDomain("tombstone"),
  memories: syncDomain("tombstone"),
  executionRuns: syncDomain("append-only", "confidential", "opaque"),
  workflowRuns: syncDomain("append-only", "confidential", "opaque"),
  mcpServers: syncDomain("tombstone"),
  terminalHistory: syncDomain("ttl", "confidential", "opaque"),
  agentTeamBoard: syncDomain("tombstone"),
  templateDefinitions: syncDomain("tombstone"),
  templatePackages: syncDomain("tombstone"),
  templateInstances: syncDomain("tombstone"),
  agentTeams: syncDomain("tombstone"),
  agentTeammates: syncDomain("tombstone"),
  agentTeamTasks: syncDomain("tombstone"),
  connectorDrafts: syncDomain("tombstone"),
  // Terminal projections age out client-side (handlers/outbound-queue.ts);
  // the host prunes without tombstones after 14 days.
  outboundQueue: syncDomain("ttl"),
})

interface SyncState {
  /** When the last successful sync of this table finished. */
  lastSyncAt: number | null
  /** Cursor to send on the next pull. */
  since: number
  /** Last failure, retained until the next success. */
  lastError: string | null
}

const stateMap = new Map<SyncableTable, SyncState>()

/**
 * Hydration guard — `runSyncDown` awaits this once on first invocation so
 * we never serve a stale `since: 0` to the server when v44+ cursors are
 * persisted in Dexie. Tests reset this via `__resetSyncStateForTests`.
 */
let hydratePromise: Promise<void> | null = null

interface HostCursorKeys {
  /** The key this host's cursors are written under now. */
  key: string
  /** Keys the same host's cursors were written under by earlier builds. */
  legacy: readonly string[]
}

/**
 * Which host these cursors belong to (ADR-0097 D13).
 *
 * The key is the host's **cursor namespace** — `{accountNamespace}:{hostId}`
 * — not the device id it issued at pair time. Two things change with that:
 *
 *   • The same desktop reached from two local accounts no longer shares one
 *     watermark, so account A's pull cannot advance account B's cursor.
 *   • A *re-pair to the same host* keeps its watermark. `deviceId` is minted
 *     per pairing, so it used to read as a different host and forced a full
 *     re-pull of every table; `hostId` is stable across re-pairs.
 *
 * Unpaired clients get `""`, which is a real key: it keeps their (empty)
 * cursors from colliding with any host's, and the moment they pair, the key
 * changes and the reconciliation below runs.
 *
 * `legacy` carries the pre-namespace key for the *same* host so an existing
 * install can adopt its own cursors instead of mistaking them for another
 * host's — see {@link adoptLegacyCursorKeys}.
 */
function currentHostCursorKeys(): HostCursorKeys {
  const config = loadCompanionConfig()
  if (!config) return { key: "", legacy: [] }
  const key = companionCursorNamespace(config)
  const legacy = config.deviceId && config.deviceId !== key ? [config.deviceId] : []
  return { key, legacy }
}

/** The host whose cursors `stateMap` currently holds. */
let hydratedServerKey: string | null = null

async function ensureHydrated(): Promise<void> {
  const { key: serverKey, legacy } = currentHostCursorKeys()
  // The host changed under us — a re-pair, or a switch. Everything in memory
  // belongs to the previous one. The mirrored *rows* are reconciled below,
  // from the database rather than from this in-memory comparison.
  if (hydratedServerKey !== null && hydratedServerKey !== serverKey) {
    hydratePromise = null
    stateMap.clear()
  }
  if (hydratePromise) return hydratePromise
  hydratedServerKey = serverKey
  hydratePromise = (async () => {
    await adoptLegacyCursorKeys(serverKey, legacy)
    await resetMirrorsSharedWithAnotherHost(serverKey)
    const persisted = await loadCursors(serverKey)
    for (const [table, row] of persisted) {
      stateMap.set(table, {
        since: row.since,
        lastSyncAt: row.lastSyncAt,
        lastError: row.lastError,
      })
    }
  })()
  return hydratePromise
}

/**
 * Re-file cursors an earlier build wrote under this same host's bare device id.
 *
 * Without this, the first run after the key changed to a cursor namespace would
 * see the install's own rows under a key it no longer recognises, classify them
 * as another host's, and wipe the mirror of the host it is still paired to —
 * a full re-pull of every table on upgrade.
 *
 * The credential-book migration re-files these too, but it runs from
 * `hydrateCompanionConfig()`, and a sync tick can beat it: `loadCompanionConfig`
 * reads a cache, so the orchestrator can observe the new key before the
 * migration has moved anything. Both paths are idempotent, so whichever runs
 * first wins and the other finds nothing.
 *
 * A cursor already under the canonical key wins — it was written by this build
 * against the key we are about to resume from, so the legacy row is a stale
 * duplicate, not a newer watermark.
 */
async function adoptLegacyCursorKeys(
  serverKey: string,
  legacyKeys: readonly string[]
): Promise<void> {
  if (serverKey === "" || legacyKeys.length === 0) return
  const canonical = await loadCursors(serverKey)
  const { clearCursorsForServer } = await import("./cursor-store")
  for (const legacyKey of legacyKeys) {
    const rows = await loadCursors(legacyKey)
    if (rows.size === 0) continue
    for (const [table, row] of rows) {
      if (canonical.has(table)) continue
      const adopted = { ...row, serverKey }
      await saveCursor(adopted)
      canonical.set(table, adopted)
    }
    await clearCursorsForServer(legacyKey)
  }
}

/**
 * Drop the mirrored rows when this database also holds another host's state.
 *
 * Partitioning the cursors alone is not enough *when two hosts share one
 * database*. It stops a client resuming from the wrong watermark, but the
 * *rows* pulled from the previous host are still sitting in the same tables,
 * so the two hosts' sessions, messages and characters would simply pile up
 * together. These tables are a cache of a host's state, not the client's own
 * data, so clearing and re-pulling loses nothing.
 *
 * Failures are swallowed: a wipe that could not run leaves a stale cache,
 * which is what the user had before, whereas throwing here would break sync
 * entirely.
 */
async function resetMirrorsForHostChange(previousServerKeys: readonly string[]): Promise<void> {
  if (previousServerKeys.length === 0) return
  try {
    const { getDb } = await import("@/lib/db/schema")
    const db = getDb()
    await Promise.all(
      SYNC_HANDLER_TABLES.map(async (table) => {
        // `settings` is a singleton the client also writes locally; clearing it
        // would throw away device-local preferences the host never had. The
        // mirrored subset is overwritten by the first pull anyway.
        if (table === "settings") return
        try {
          await (db as unknown as Record<string, { clear: () => Promise<void> }>)[table]?.clear()
        } catch {
          // One table failing must not stop the rest.
        }
      })
    )
    const { clearCursorsForServer } = await import("./cursor-store")
    for (const key of previousServerKeys) {
      await clearCursorsForServer(key)
    }
  } catch {
    // See jsdoc.
  }
}

/**
 * Decide whether the wipe above is needed at all, from the database itself.
 *
 * The rule is one question: **does the database we are about to sync into
 * already hold cursors for a host other than this one?** Cursors are written
 * per host on every handler run into the same database as the mirrored rows,
 * so a foreign key here means that host's rows are in these very tables, and
 * nothing else does.
 *
 * Asking the database rather than tracking the switch in memory is what lets
 * host switching stop being destructive (ADR-0061 L3 / ADR-0097 D13). Once an
 * account has runtime targets, each host's mirror lives in its *own* Dexie
 * database (`activateAccountDatabase(accountId, targetId)` — see
 * `lib/runtime/account-runtime-target.ts`), so switching activates the other
 * host's database and this scan finds nothing foreign: both hosts keep their
 * mirror and their watermark, and switching back re-pulls nothing. When the
 * two hosts *do* share one database — an install with no runtime target, and
 * the legacy account-level database — the scan finds the foreign key and the
 * wipe still fires, exactly as before.
 *
 * It also covers the switch this process never saw. Re-pairing is normally a
 * restart, and on iOS the app is routinely killed between the
 * `CompanionConfig` write and the next sync tick, so an in-memory check alone
 * let host A's rows sit in the tables while host B's cursors started from
 * zero — the exact blend per-host cursors were introduced to prevent.
 *
 * An unpaired client (`serverKey === ""`) never wipes. It is not "talking to a
 * different host" yet, and `loadCompanionConfig` reads a cache that is empty
 * until `hydrateCompanionConfig` resolves at boot — so a sync that races
 * hydration would otherwise destroy the mirror of the host it is still paired
 * to.
 */
async function resetMirrorsSharedWithAnotherHost(serverKey: string): Promise<void> {
  if (serverKey === "") return
  const { listCursorServerKeys } = await import("./cursor-store")
  const foreign = (await listCursorServerKeys()).filter((key) => key !== serverKey)
  await resetMirrorsForHostChange(foreign)
}

function getState(table: SyncableTable): SyncState {
  let state = stateMap.get(table)
  if (!state) {
    state = { lastSyncAt: null, since: 0, lastError: null }
    stateMap.set(table, state)
  }
  return state
}

export function getSyncStateFor(table: SyncableTable): Readonly<SyncState> {
  return { ...getState(table) }
}

export function snapshotSyncStates(): Record<SyncableTable, SyncState> {
  const snapshot = {} as Record<SyncableTable, SyncState>
  for (const { table } of DEFAULT_HANDLERS) {
    snapshot[table] = { ...getState(table) }
  }
  return snapshot
}

export interface RunSyncDownOptions {
  /** Override the transport (tests). */
  transport?: Transport
  /**
   * Override the handler list (tests).
   *
   * `stage` may be omitted: an injected handler that does not declare one runs
   * in `critical`, so a test that never mentions stages keeps getting the whole
   * list on every run.
   */
  handlers?: SyncHandlerOverride[]
  /**
   * Restrict the run to a subset of tables (settings UI: "Sync now"
   * for a single row). When set, the handler list is filtered to just
   * these tables in their registered order — empty array means "no
   * handlers", which resolves to an empty outcomes array.
   */
  only?: readonly SyncableTable[]
  /**
   * Restrict the run to whole stages (see {@link SYNC_STAGES}). Composes with
   * `only`: both filters apply, so a stage run can still be narrowed to one
   * table. Omitted means every stage, which is what every existing caller —
   * "Sync now", the resync coordinator, the network/resume triggers — asks
   * for and keeps getting.
   */
  stages?: readonly SyncStage[]
}

/**
 * Pull every registered table sequentially. Returns one outcome per table.
 * Sequential — not parallel — so a slow desktop server doesn't get hit
 * with 25 simultaneous round-trips. Re-entrant: a second call while
 * one is in flight reuses the in-flight promise.
 *
 * Per-table runs (`opts.only`) bypass the re-entrancy gate so the user
 * can sync one row from the SyncStatusCard even when a full pull is
 * already in flight — otherwise the UI would silently wait on whatever
 * the orchestrator is doing. Stage runs (`opts.stages`) bypass it for the
 * same reason: {@link runStagedSyncDown} drives its later stages while the
 * caller is already awaiting the earlier one.
 */
let inflight: Promise<SyncOutcome[]> | null = null

export function runSyncDown(opts: RunSyncDownOptions = {}): Promise<SyncOutcome[]> {
  const isTargeted = opts.only !== undefined || opts.stages !== undefined
  if (inflight && !isTargeted) return inflight
  const t = opts.transport ?? transport
  let handlers: RegisteredHandler[] = opts.handlers
    ? opts.handlers.map((handler) => ({ stage: DEFAULT_HANDLER_STAGE, ...handler }))
    : DEFAULT_HANDLERS
  if (opts.stages) {
    const stageSet = new Set(opts.stages)
    handlers = handlers.filter((h) => stageSet.has(h.stage))
  }
  if (opts.only) {
    const onlySet = new Set(opts.only)
    handlers = handlers.filter((h) => onlySet.has(h.table))
  }

  const runPromise: Promise<SyncOutcome[]> = (async () => {
    await ensureHydrated()
    const results: SyncOutcome[] = []
    for (let index = 0; index < handlers.length; index++) {
      const { table, run } = handlers[index]
      // Hand the thread back before every table but the first. A pull is
      // request → parse → Dexie write, and back-to-back that is one unbroken
      // run of main-thread work per table; the gap is what lets the shell
      // paint the rows that already landed while the rest are still arriving.
      if (index > 0) await yieldToMain()
      const state = getState(table)
      const sinceAtStart = state.since
      const outcome = await run(t, { since: sinceAtStart })
      if (outcome.ok) {
        // Monotonic cursor guard: a targeted "sync now" run (opts.only) and a
        // full background pull share `stateMap` entries (see getState), so a
        // slower outcome can finish after a faster one and would otherwise
        // regress the cursor on `state.since = outcome.result.nextSince`. We
        // only advance when the freshly observed nextSince is strictly newer
        // than whatever else already wrote during our `await run(...)`. ADR-
        // 0027's "monotonic cursor" invariant.
        if (outcome.result.nextSince > state.since) {
          state.since = outcome.result.nextSince
        }
        state.lastSyncAt = Date.now()
        state.lastError = null
      } else {
        state.lastError = outcome.failure.message
      }
      // Fire-and-forget Dexie persistence so the next cold start can resume
      // from this cursor. Failures are swallowed by `cursor-store.saveCursor`.
      void saveCursor({
        serverKey: hydratedServerKey ?? "",
        table,
        since: state.since,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
      })
      results.push(outcome)
    }
    return results
  })()

  if (!isTargeted) {
    inflight = runPromise
    runPromise.finally(() => {
      inflight = null
    })
  }

  return runPromise
}

/** What a staged run hands back. Both promises; neither rejects. */
export interface StagedSyncRun {
  /**
   * Settles when the `critical` stage has finished — the point at which the
   * client can paint its first screen honestly. This is what a boot path
   * awaits.
   *
   * It REJECTS if the pipeline itself broke (hydration, transport
   * construction). Per-table failures are not that: those are recorded as
   * `{ ok: false }` outcomes and resolve normally. Swallowing the pipeline
   * failure here would flip a client to "online" over a sync that never ran,
   * and skip the reconnect the caller schedules on exactly that rejection.
   */
  critical: Promise<SyncOutcome[]>
  /**
   * Settles when every stage has drained, with the outcomes of all of them.
   *
   * Awaiting it is for tests and for a deliberate "sync everything now"; the
   * boot path does not, which is the whole point of staging. Unlike `critical`
   * it never rejects: nobody is awaiting it, so a throw here would be an
   * unhandled rejection on a connection that is already usable. A stage that
   * breaks is skipped and the later ones still get their turn.
   */
  whenComplete: Promise<SyncOutcome[]>
}

/**
 * Pull the Host's state in stages, letting the caller continue as soon as the
 * client can honestly paint.
 *
 * This exists because the boot path used to await *everything*: a paired client
 * showed "connecting" until the last table landed, so one slow or large table
 * held the whole shell dark and the tables that had already arrived went
 * unrendered. Now `critical` settles first, the connection goes online, and
 * `interactive` then `background` fill in behind the running UI — each waiting
 * for an idle moment, so they interleave with whatever the user has started
 * doing rather than competing with it.
 *
 * Re-entrant like {@link runSyncDown}: a second staged run while one is in
 * flight reuses it, so a reconnect storm cannot stack three drains onto one
 * transport.
 */
let stagedInflight: StagedSyncRun | null = null

export function runStagedSyncDown(opts: RunSyncDownOptions = {}): StagedSyncRun {
  if (stagedInflight) return stagedInflight

  const critical = runSyncDown({ ...opts, stages: ["critical"] })

  const whenComplete = (async () => {
    const outcomes: SyncOutcome[] = []
    try {
      outcomes.push(...(await critical))
    } catch {
      // The caller owns this failure — it is awaiting `critical` and reacts to
      // the rejection there. Catching it here is only so the later stages still
      // run, and so this promise stays the one that never rejects.
    }
    for (const stage of SYNC_STAGES.slice(1)) {
      try {
        // Between stages the correct answer is "later", not "next macrotask":
        // the shell is mid-first-paint and the rows this stage carries are not
        // on screen yet. The deadline inside `whenIdle` keeps a busy or
        // backgrounded tab from stalling here forever.
        await whenIdle()
        outcomes.push(...(await runSyncDown({ ...opts, stages: [stage] })))
      } catch {
        // Per-table failures are already recorded as outcomes; reaching here
        // means the pipeline itself broke (hydration, transport construction).
        // Later stages still get their turn — one broken stage is not a reason
        // to abandon the rest of the mirror.
      }
    }
    return outcomes
  })()

  const run: StagedSyncRun = { critical, whenComplete }
  stagedInflight = run
  void whenComplete.finally(() => {
    if (stagedInflight === run) stagedInflight = null
  })
  return run
}

/**
 * Re-run the sync whenever the document becomes visible. Returns a
 * teardown function that detaches the listener; safe to call inside
 * useEffect.
 */
export function installForegroundSync(opts: RunSyncDownOptions = {}): () => void {
  if (typeof document === "undefined") return () => {}
  const handler = () => {
    if (document.visibilityState === "visible") {
      void runSyncDown(opts)
    }
  }
  document.addEventListener("visibilitychange", handler)
  return () => document.removeEventListener("visibilitychange", handler)
}

/**
 * Subscribe to the server's `sync://invalidate` channel. Whenever the
 * desktop emits a delta event the orchestrator re-pulls the relevant
 * table. The channel design is server-defined; we accept either a
 * `{ table }` payload (selective pull) or no payload (pull all).
 */
export function installEventDrivenSync(opts: RunSyncDownOptions = {}): () => void {
  const t = opts.transport ?? transport
  // ADR-0131: a chatty connector host (an ai-run reply touches the outbound
  // row three times, an inbound burst adds N messages) still yields one
  // `sync_pull` per table per window. Keyed invalidations coalesce per table;
  // an untabled ("pull everything") frame collapses every pending window into
  // one full run.
  const pending = new Map<SyncableTable | "*", ReturnType<typeof setTimeout>>()
  let disposed = false
  const flush = (key: SyncableTable | "*"): void => {
    pending.delete(key)
    if (disposed) return
    if (key === "*") {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      void runSyncDown(opts)
      return
    }
    const only = opts.only === undefined ? [key] : opts.only.filter((table) => table === key)
    if (only.length === 0) return
    void runSyncDown({ ...opts, only })
  }
  const unsub = t.subscribe<{ table?: SyncableTable }>("sync://invalidate", (payload) => {
    if (disposed) return
    const key: SyncableTable | "*" = payload?.table ?? "*"
    if (pending.has(key)) return
    // Skip tables this installer was scoped away from — no timer, no pull.
    if (key !== "*" && opts.only !== undefined && !opts.only.includes(key)) return
    if (key === "*") {
      // A full pull supersedes every keyed window already armed.
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    } else if (pending.has("*")) {
      return
    }
    pending.set(
      key,
      setTimeout(() => flush(key), EVENT_SYNC_COALESCE_MS)
    )
  })
  return () => {
    disposed = true
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    unsub()
  }
}

const WORKFLOW_RUN_STATUS_CHANNEL = "workflow://run-status"
const WORKFLOW_RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
])
const TERMINAL_WORKFLOW_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
])

interface WorkflowRunStatusFrame {
  runId: string
  workflowId: string
  status: RunStatus
  lastStepId?: string
}

/** Apply live Host run transitions to the paired client's existing mirror. */
export function installWorkflowRunStatusSync(opts: RunSyncDownOptions = {}): () => void {
  const t = opts.transport ?? transport
  let disposed = false
  const unsubscribe = t.subscribe<WorkflowRunStatusFrame>(WORKFLOW_RUN_STATUS_CHANNEL, (frame) => {
    if (
      disposed ||
      !frame ||
      typeof frame.runId !== "string" ||
      !frame.runId ||
      typeof frame.workflowId !== "string" ||
      !frame.workflowId ||
      !WORKFLOW_RUN_STATUSES.has(frame.status)
    ) {
      return
    }
    void (async () => {
      const run = await getDb().workflowRuns.get(frame.runId)
      if (!run) {
        await runSyncDown({ ...opts, only: ["workflowRuns"] })
        return
      }
      // WS replay must never move a terminal mirror back into an active state.
      if (
        TERMINAL_WORKFLOW_RUN_STATUSES.has(run.status) &&
        !TERMINAL_WORKFLOW_RUN_STATUSES.has(frame.status)
      ) {
        return
      }
      await getDb().workflowRuns.update(frame.runId, {
        status: frame.status,
        ...(typeof frame.lastStepId === "string" && frame.lastStepId
          ? { lastCompletedStepId: frame.lastStepId }
          : {}),
      })
    })().catch(() => {
      if (!disposed) void runSyncDown({ ...opts, only: ["workflowRuns"] })
    })
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}

/** Per-table coalescing window for `sync://invalidate` → `sync_pull` (ADR-0131). */
export const EVENT_SYNC_COALESCE_MS = 100

/**
 * Re-run the sync whenever the network reports `connected: true`. This is
 * the mobile-critical trigger — sessions/messages that piled up while the
 * phone was on airplane mode are pulled the moment Wi-Fi comes back.
 *
 * Mirrors `lib/queue/outbound-queue.ts`'s subscription model so the two
 * runners share the same event source; `@capacitor/network` plugin listeners
 * are multi-subscriber-safe.
 */
export function installNetworkSync(opts: RunSyncDownOptions = {}): Promise<() => void> {
  return subscribeNetwork((status) => {
    if (status.connected) {
      void runSyncDown(opts)
    }
  })
}

/**
 * Re-run the sync whenever the OS reports the app resumed to foreground.
 * Falls back to `document.visibilitychange === "visible"` on web/Tauri.
 * Layered on top of `installForegroundSync` — the two cover slightly
 * different surfaces (the visibility API fires on web tab focus changes;
 * the `resume` event fires when the app process is restored on mobile).
 */
export function installResumeSync(opts: RunSyncDownOptions = {}): Promise<() => void> {
  return subscribeResume(() => {
    void runSyncDown(opts)
  })
}

/** Test-only — wipes the cursor map between tests. */
export function __resetSyncStateForTests(): void {
  stateMap.clear()
  inflight = null
  stagedInflight = null
  hydratePromise = null
  // Also forget which host we were hydrated for, or the next test's first
  // `ensureHydrated` would see a "host change" and wipe the tables it just
  // seeded.
  hydratedServerKey = null
  void clearCursors()
}
