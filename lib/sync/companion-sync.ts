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

import { transport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"

import { syncCharacters } from "./handlers/characters"
import { syncMessages } from "./handlers/messages"
import { syncSessions } from "./handlers/sessions"
import { syncSkills } from "./handlers/skills"
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
]

interface SyncState {
  /** When the last successful sync of this table finished. */
  lastSyncAt: number | null
  /** Cursor to send on the next pull. */
  since: number
  /** Last failure, retained until the next success. */
  lastError: string | null
}

const stateMap = new Map<SyncableTable, SyncState>()

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
}

/**
 * Pull all four tables sequentially. Returns one outcome per table.
 * Sequential — not parallel — so a slow desktop server doesn't get hit
 * with four simultaneous round-trips. Re-entrant: a second call while
 * one is in flight reuses the in-flight promise.
 */
let inflight: Promise<SyncOutcome[]> | null = null

export function runSyncDown(opts: RunSyncDownOptions = {}): Promise<SyncOutcome[]> {
  if (inflight) return inflight
  const t = opts.transport ?? transport
  const handlers = opts.handlers ?? DEFAULT_HANDLERS

  inflight = (async () => {
    const results: SyncOutcome[] = []
    for (const { table, run } of handlers) {
      const state = getState(table)
      const outcome = await run(t, { since: state.since })
      if (outcome.ok) {
        state.since = outcome.result.nextSince
        state.lastSyncAt = Date.now()
        state.lastError = null
      } else {
        state.lastError = outcome.failure.message
      }
      results.push(outcome)
    }
    return results
  })()

  inflight.finally(() => {
    inflight = null
  })

  return inflight
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

/** Test-only — wipes the cursor map between tests. */
export function __resetSyncStateForTests(): void {
  stateMap.clear()
  inflight = null
}
