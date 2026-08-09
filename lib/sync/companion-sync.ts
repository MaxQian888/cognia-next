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
import { transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import type { Transport } from "@/lib/tauri/transport-types"

import { clearCursors, loadCursors, saveCursor } from "./cursor-store"
import { syncAdapterInstances } from "./handlers/adapter-instances"
import { syncAgentTeamBoard } from "./handlers/agent-team-board"
import { syncAgentTaskAttempts, syncAgentTasks } from "./handlers/agent-tasks"
import { syncAppSettings } from "./handlers/app-settings"
import { syncCharacters } from "./handlers/characters"
import { syncConversationOverrides } from "./handlers/conversation-overrides"
import { syncGoals } from "./handlers/goals"
import { syncMcpServers } from "./handlers/mcp-servers"
import { syncMemories } from "./handlers/memory"
import { syncMessages } from "./handlers/messages"
import { syncPlugins } from "./handlers/plugins"
import { syncSessions } from "./handlers/sessions"
import { syncSkills } from "./handlers/skills"
import { syncTerminalHistory } from "./handlers/terminal-history"
import { syncTwinProfile } from "./handlers/twin-profile"
import { syncWorkflows } from "./handlers/workflows"
import { syncWorkflowRuns } from "./handlers/workflow-runs"
import {
  syncTemplateDefinitions,
  syncTemplateInstances,
  syncTemplatePackages,
} from "./handlers/template-platform"
import type { SyncCursor, SyncOutcome, SyncableTable } from "./types"

export type SyncFn = (transport: Transport, cursor: SyncCursor) => Promise<SyncOutcome>

interface RegisteredHandler {
  table: SyncableTable
  run: SyncFn
}

const DEFAULT_HANDLERS: RegisteredHandler[] = [
  { table: "characters", run: syncCharacters },
  { table: "skills", run: syncSkills },
  { table: "sessions", run: syncSessions },
  { table: "agentTasks", run: syncAgentTasks },
  { table: "agentTaskAttempts", run: syncAgentTaskAttempts },
  { table: "messages", run: syncMessages },
  // Wave 4 / ADR-0026 — five more tables wired so the mobile shell can
  // serve workflow viewer, twin profile, plugin toggles, connector policy,
  // and per-device preferences from Dexie when the server is unreachable.
  { table: "workflows", run: syncWorkflows },
  { table: "twinProfile", run: syncTwinProfile },
  { table: "plugins", run: syncPlugins },
  { table: "adapterInstances", run: syncAdapterInstances },
  { table: "settings", run: syncAppSettings },
  // v49 — Inbox optimization. Mobile reads pinned/archived/unread state
  // from conversationOverrides; without this handler the orchestrator
  // never pulls it and the mobile inbox renders every conversation as
  // unread + unpinned.
  { table: "conversationOverrides", run: syncConversationOverrides },
  // Companion read-mostly views (Goals console + long-term memory). Mobile
  // mirrors these so the phone can show goal progress / recalled memories
  // from Dexie offline; both are authored on the desktop.
  { table: "goals", run: syncGoals },
  { table: "memories", run: syncMemories },
  // Workflow run history — mirrors execution state so the mobile library
  // badges, runs feed, and active-runs card reflect runs (incl. phone-
  // triggered ones). Definitions sync via `workflows` above; this is runs.
  { table: "workflowRuns", run: syncWorkflowRuns },
  // ADR-0056 (Wave 4) — configured MCP servers. Read-only mirror so the
  // mobile `/me/mcp` page can list the desktop's servers (the phone has no
  // MCP push RPC and the standalone engine runs no MCP).
  { table: "mcpServers", run: syncMcpServers },
  // ADR-0039 (phase 2) — durable terminal command history. One-way read-only
  // mirror (desktop → phone) powering the mobile `/me/command-history` browse
  // /search viewer; the phone has no shell, so it never writes back.
  { table: "terminalHistory", run: syncTerminalHistory },
  // v104 — Agent-Team board projection (team-board CQRS). One-way mirror of
  // the desktop task board (tasks + team-meta rows) so the mobile workspace
  // can render the kanban offline; controls travel back as Companion RPC.
  { table: "agentTeamBoard", run: syncAgentTeamBoard },
  { table: "templateDefinitions", run: syncTemplateDefinitions },
  { table: "templatePackages", run: syncTemplatePackages },
  { table: "templateInstances", run: syncTemplateInstances },
]

/**
 * Tables sync'd by the orchestrator, in execution order. Exported so the
 * Settings → Mobile Companion → "Sync status" card can list every handler
 * without hard-coding the names — keeps the UI in lock-step with the
 * registry above.
 */
export const SYNC_HANDLER_TABLES: readonly SyncableTable[] = DEFAULT_HANDLERS.map((h) => h.table)

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
  /** Override the handler list (tests). */
  handlers?: RegisteredHandler[]
  /**
   * Restrict the run to a subset of tables (settings UI: "Sync now"
   * for a single row). When set, the handler list is filtered to just
   * these tables in their registered order — empty array means "no
   * handlers", which resolves to an empty outcomes array.
   */
  only?: readonly SyncableTable[]
}

/**
 * Pull all four tables sequentially. Returns one outcome per table.
 * Sequential — not parallel — so a slow desktop server doesn't get hit
 * with four simultaneous round-trips. Re-entrant: a second call while
 * one is in flight reuses the in-flight promise.
 *
 * Per-table runs (`opts.only`) bypass the re-entrancy gate so the user
 * can sync one row from the SyncStatusCard even when a full pull is
 * already in flight — otherwise the UI would silently wait on whatever
 * the orchestrator is doing.
 */
let inflight: Promise<SyncOutcome[]> | null = null

export function runSyncDown(opts: RunSyncDownOptions = {}): Promise<SyncOutcome[]> {
  const isTargeted = opts.only !== undefined
  if (inflight && !isTargeted) return inflight
  const t = opts.transport ?? transport
  let handlers = opts.handlers ?? DEFAULT_HANDLERS
  if (opts.only) {
    const onlySet = new Set(opts.only)
    handlers = handlers.filter((h) => onlySet.has(h.table))
  }

  const runPromise: Promise<SyncOutcome[]> = (async () => {
    await ensureHydrated()
    const results: SyncOutcome[] = []
    for (const { table, run } of handlers) {
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
  const unsub = t.subscribe<{ table?: SyncableTable }>("sync://invalidate", () => {
    void runSyncDown(opts)
  })
  return unsub
}

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
  hydratePromise = null
  // Also forget which host we were hydrated for, or the next test's first
  // `ensureHydrated` would see a "host change" and wipe the tables it just
  // seeded.
  hydratedServerKey = null
  void clearCursors()
}
