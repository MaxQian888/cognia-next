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
import { transport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"

import { clearCursors, loadCursors, saveCursor } from "./cursor-store"
import { syncAdapterInstances } from "./handlers/adapter-instances"
import { syncAppSettings } from "./handlers/app-settings"
import { syncCharacters } from "./handlers/characters"
import { syncConversationOverrides } from "./handlers/conversation-overrides"
import { syncGoals } from "./handlers/goals"
import { syncMemories } from "./handlers/memory"
import { syncMessages } from "./handlers/messages"
import { syncPlugins } from "./handlers/plugins"
import { syncSessions } from "./handlers/sessions"
import { syncSkills } from "./handlers/skills"
import { syncTwinProfile } from "./handlers/twin-profile"
import { syncWorkflows } from "./handlers/workflows"
import { syncWorkflowRuns } from "./handlers/workflow-runs"
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

async function ensureHydrated(): Promise<void> {
  if (hydratePromise) return hydratePromise
  hydratePromise = (async () => {
    const persisted = await loadCursors()
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
  void clearCursors()
}
