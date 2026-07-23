"use client"

/**
 * Reattach to PTY sessions that survived a webview reload (1C).
 *
 * The Tauri Rust process — and thus every live `PtySession` — outlives a
 * webview reload (F5 / HMR). Only the JS Channel + the in-memory
 * session-registry are torn down. On boot we ask Rust for its sessions
 * (`terminal_list_all`), skip the ones whose shell has already exited,
 * rebuild the dock rows for the rest, reattach a fresh Channel to each
 * (replaying the retained buffer so recent scrollback comes back), and
 * re-wire events to the store via the same `wireSessionToStore` the spawn
 * path uses.
 *
 * Sessions are NOT restored across a full app restart — the Rust process
 * and its PTYs are gone then, so `terminal_list_all` returns nothing.
 *
 * Reload-safe UI metadata is restored only after every surviving PTY has
 * registered. That ordering lets the store validate split groups, focus,
 * active tabs, and custom titles against the authoritative Rust session list
 * and discard stale metadata from a full app restart.
 */

import { listAllTerminals, TerminalSession } from "./session"
import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export interface RehydrateResult {
  restored: number
  failed: number
}

type RehydrateStore = TerminalStoreLike & {
  restorePersistedLayout?: () => void
}

export async function rehydrateTerminals(
  opts: {
    store?: RehydrateStore
    list?: typeof listAllTerminals
    reattach?: typeof TerminalSession.reattach
  } = {}
): Promise<RehydrateResult> {
  const store = opts.store ?? useTerminalStore.getState()
  const list = opts.list ?? listAllTerminals
  const reattach = opts.reattach ?? TerminalSession.reattach.bind(TerminalSession)

  let infos: Awaited<ReturnType<typeof listAllTerminals>>
  try {
    infos = await list()
  } catch {
    return { restored: 0, failed: 0 }
  }

  let restored = 0
  let failed = 0
  for (const info of infos) {
    // Rust keeps exited sessions in its store so scrollback survives the shell
    // exiting, so the list is not a liveness list. Restoring a dead one gives
    // the user a tab whose PTY is gone. `undefined` means a transport that
    // predates the flag — assume alive, as before.
    if (info.alive === false) continue
    try {
      // Order matters: reattach (which makes the live session) and register it
      // in the live registry BEFORE adding the store row. The store row is what
      // makes the dock mount the `TerminalInstance`, whose setup effect reads
      // `getLiveSession(id)` once and bails permanently if it's missing. Adding
      // the row first (as the original code did) let the instance mount during
      // the `await reattach` gap — before the live session existed — leaving a
      // dead, black terminal. This mirrors the spawn path (spawn-orchestrator).
      const session = await reattach(info.id, 0)
      registerLiveSession(session)
      store.registerSession({
        id: info.id,
        projectId: info.projectId,
        extensionId: info.extensionId,
        origin: info.origin,
        shell: info.shell,
      })
      wireSessionToStore(session, store)
      restored++
    } catch {
      failed++
    }
  }
  // Apply the saved layout as one transaction after all rows exist. Calling
  // this for an empty successful list clears stale ids from a full app restart;
  // a failed list keeps the snapshot so a transient IPC failure cannot erase it.
  store.restorePersistedLayout?.()
  return { restored, failed }
}
