"use client"

/**
 * Reattach to PTY sessions that survived a webview reload (1C).
 *
 * The Tauri Rust process — and thus every live `PtySession` — outlives a
 * webview reload (F5 / HMR). Only the JS Channel + the in-memory
 * session-registry are torn down. On boot we ask Rust which sessions are
 * still alive (`terminal_list_all`), rebuild the dock rows, reattach a
 * fresh Channel to each (replaying the retained buffer so recent
 * scrollback comes back), and re-wire events to the store via the same
 * `wireSessionToStore` the spawn path uses.
 *
 * Sessions are NOT restored across a full app restart — the Rust process
 * and its PTYs are gone then, so `terminal_list_all` returns nothing.
 *
 * Split-pane layout is intentionally not persisted across reload (1C
 * scope): former split members come back as individual tabs. The
 * processes — the thing that matters — survive.
 */

import { listAllTerminals, TerminalSession } from "./session"
import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export interface RehydrateResult {
  restored: number
  failed: number
}

export async function rehydrateTerminals(
  opts: {
    store?: TerminalStoreLike
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
    try {
      store.registerSession({
        id: info.id,
        projectId: info.projectId,
        extensionId: info.extensionId,
        origin: info.origin,
        shell: info.shell,
      })
      const session = await reattach(info.id, 0)
      registerLiveSession(session)
      wireSessionToStore(session, store)
      restored++
    } catch {
      failed++
    }
  }
  return { restored, failed }
}
