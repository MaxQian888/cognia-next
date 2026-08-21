// App-lifetime owner of the external-agent session-history fs-watch (ADR-0062).
//
// The watcher used to be owned by `useSessionImportWatch` inside
// `SessionImportDialog`, which made "Live sync" a lie in three separate ways:
//
//   1. Closing the dialog unmounted the hook. Its cleanup only dropped the
//      Tauri LISTENER — `session_import_watch_stop` was never invoked — so the
//      Rust watcher kept running for the rest of the process with nobody
//      listening. Live sync silently stopped working while still consuming an
//      OS watch handle per root.
//   2. `enabled` was plain component state, so reopening the dialog showed the
//      switch as OFF even though the native watcher was still installed, and
//      toggling it back on installed a second one.
//   3. Nothing persisted the choice, so it never survived a restart — while the
//      copy promises "Keep watching these agents and import new sessions
//      automatically".
//
// This module is that owner: a single process-wide watch, started/stopped from
// the persisted `AppSettings.sessionImportWatch` preference by
// `SessionImportWatchInitializer`. It is deliberately NOT a React hook — the
// lifetime it manages is the app's, not any component's.

import { createLogger } from "@cognia/logging"
import { isTauri as isTauriDefault } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { collectWatchRoots, runWatchImport } from "./watch-import"

const log = createLogger("session-import-watch")

/** The Tauri event the Rust watcher emits on a debounced change burst. */
export const SESSION_IMPORT_CHANGED_EVENT = "session-import://changed"

export interface SessionImportWatchDeps {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  listen?: (
    event: string,
    handler: (event: { payload?: { path?: string } }) => void
  ) => Promise<() => void>
  isTauri?: () => boolean
  collectWatchRoots?: typeof collectWatchRoots
  runWatchImport?: typeof runWatchImport
}

interface ActiveWatch {
  unlisten: (() => void) | null
  /** Workspace new sessions are stamped with; updated in place on a re-target. */
  projectId?: string
}

let active: ActiveWatch | null = null
/** Serializes start/stop so a rapid toggle can't interleave into two watchers. */
let queue: Promise<void> = Promise.resolve()

/**
 * Chain `step` onto the queue and hand the caller its result.
 *
 * The chain itself is kept SETTLED: `p.then(cb)` on a rejected `p` skips `cb`
 * entirely and re-rejects, so letting one failed start poison `queue` would
 * turn every later start *and stop* into a silent no-op for the rest of the
 * process — live sync dead, the persisted toggle still reading "on", and the
 * native watcher unreachable. The caller still sees the rejection (and the
 * initializer's `void` call still needs its own `.catch`).
 */
function enqueue(step: () => Promise<void>): Promise<void> {
  const run = queue.then(step)
  queue = run.catch(() => undefined)
  return run
}

async function defaultInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke(cmd, args)
}

async function defaultListen(
  event: string,
  handler: (e: { payload?: { path?: string } }) => void
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event")
  return listen<{ path?: string }>(event, handler)
}

/** True when a watch is currently installed in this process. */
export function isSessionImportWatchActive(): boolean {
  return active !== null
}

/**
 * Re-point an already-running watch at another workspace without tearing the
 * OS watch down. The listener closes over the mutable record, so a workspace
 * switch takes effect on the very next filesystem event — the old hook captured
 * `projectId` in the `start` closure and kept importing into the workspace that
 * happened to be active when live sync was switched on.
 */
export function retargetSessionImportWatch(projectId?: string): void {
  if (active) active.projectId = projectId
}

/**
 * Install the watch (idempotent). Re-targets instead of restarting when one is
 * already running. A no-op off Tauri: the roots are desktop paths and the
 * watcher is a Tauri command.
 */
export function startSessionImportWatch(
  opts: { projectId?: string; deps?: SessionImportWatchDeps } = {}
): Promise<void> {
  const d = opts.deps ?? {}
  const isTauriFn = d.isTauri ?? isTauriDefault
  const invokeFn = d.invoke ?? defaultInvoke
  const listenFn = d.listen ?? defaultListen
  const collectRoots = d.collectWatchRoots ?? collectWatchRoots
  const doImport = d.runWatchImport ?? runWatchImport

  return enqueue(async () => {
    if (!isTauriFn()) return
    if (active) {
      active.projectId = opts.projectId
      return
    }
    // Claim the slot BEFORE the first await: two `startSessionImportWatch`
    // calls are serialized by `queue`, but claiming late would still let a
    // `stop` that lands mid-start be undone by this start's own assignment.
    const record: ActiveWatch = { unlisten: null, projectId: opts.projectId }
    active = record
    try {
      const roots = await collectRoots()
      await invokeFn("session_import_watch_start", { roots })
      const unlisten = await listenFn(SESSION_IMPORT_CHANGED_EVENT, (event) => {
        // Errors here reach nobody: the watch is a background job with no
        // surface to fail into. Logging beats an unhandled rejection.
        void doImport({ changedPath: event.payload?.path, projectId: record.projectId }).catch(
          (error) => log.error("session-import-watch-import-failed", { error })
        )
      })
      if (active !== record) {
        // A stop landed while we were awaiting — honour it.
        safeUnlisten(unlisten)
        try {
          await invokeFn("session_import_watch_stop")
        } catch {
          // Best-effort teardown.
        }
        return
      }
      record.unlisten = unlisten
    } catch (error) {
      if (active === record) active = null
      log.error("session-import-watch-start-failed", { error })
      throw error
    }
  })
}

/** Tear the watch down, native side included. Idempotent. */
export function stopSessionImportWatch(deps: SessionImportWatchDeps = {}): Promise<void> {
  const isTauriFn = deps.isTauri ?? isTauriDefault
  const invokeFn = deps.invoke ?? defaultInvoke

  return enqueue(async () => {
    const record = active
    active = null
    if (record) safeUnlisten(record.unlisten)
    // Stop unconditionally when a watch was installed, and also when it wasn't:
    // a previous process-level start whose listener died (hot reload, crashed
    // render) can leave the Rust watcher installed with no record here.
    if (!isTauriFn()) return
    try {
      await invokeFn("session_import_watch_stop")
    } catch (error) {
      log.warn("session-import-watch-stop-failed", { error })
    }
  })
}

/** Test-only: drop the in-process record without touching the native side. */
export function __resetSessionImportWatchForTesting(): void {
  if (active) safeUnlisten(active.unlisten)
  active = null
  queue = Promise.resolve()
}
