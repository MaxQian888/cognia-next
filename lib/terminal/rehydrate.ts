"use client"

/**
 * Reattach to host-owned sessions that survived a renderer or app restart.
 *
 * The lightweight terminal host outlives the Tauri UI process. Only the JS
 * channel and in-memory session registry are torn down. On boot we ask the host
 * for its sessions
 * through the active local/LAN/WAN transport, skip exited shells, rebuild
 * the dock rows for the rest, and reattach a fresh logical stream to each
 * (replaying the retained buffer so recent scrollback comes back), and
 * re-wire events to the store via the same `wireSessionToStore` the spawn
 * path uses.
 *
 * Reload-safe UI metadata is restored only after every surviving PTY has
 * registered. That ordering lets the store validate split groups, focus,
 * active tabs, and custom titles against the authoritative Rust session list
 * and discard stale metadata from a full app restart.
 */

import { listAllTerminals, TerminalSession } from "./session"
import { RemoteTerminalSession } from "./transport-ws"
import { selectTerminalTransportChain, type TerminalTransportKind } from "./pick-transport"
import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { classifyTerminalHostError } from "./host-state"
import type { BaseTerminalSession } from "./base-session"
import type { SessionInfo } from "./types"

export interface RehydrateResult {
  restored: number
  failed: number
}

type RehydrateStore = TerminalStoreLike & {
  restorePersistedLayout?: () => void
}

async function tryTransportChain<T>(
  operation: (transport: TerminalTransportKind) => Promise<T>
): Promise<T> {
  let lastError: unknown = new Error("terminal transport unavailable")
  for (const transport of selectTerminalTransportChain()) {
    try {
      return await operation(transport)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function listFromActiveHost(): Promise<SessionInfo[]> {
  return tryTransportChain((transport) => {
    switch (transport) {
      case "tauri-channel":
        return listAllTerminals()
      case "ws":
        return RemoteTerminalSession.listLan()
      case "webrtc":
        return RemoteTerminalSession.listWan()
      default:
        return Promise.reject(new Error("terminal transport unavailable"))
    }
  })
}

function reattachToActiveHost(
  sessionId: string,
  resumeAfter: number
): Promise<BaseTerminalSession> {
  return tryTransportChain((transport) => {
    switch (transport) {
      case "tauri-channel":
        return TerminalSession.reattach(sessionId, resumeAfter)
      case "ws":
        return RemoteTerminalSession.reattachLan(sessionId, resumeAfter)
      case "webrtc":
        return RemoteTerminalSession.reattachWan(sessionId, resumeAfter)
      default:
        return Promise.reject(new Error("terminal transport unavailable"))
    }
  })
}

export async function rehydrateTerminals(
  opts: {
    store?: RehydrateStore
    list?: () => Promise<SessionInfo[]>
    reattach?: (sessionId: string, resumeAfter: number) => Promise<BaseTerminalSession>
  } = {}
): Promise<RehydrateResult> {
  const store = opts.store ?? useTerminalStore.getState()
  const list = opts.list ?? listFromActiveHost
  const reattach = opts.reattach ?? reattachToActiveHost

  let infos: Awaited<ReturnType<typeof listAllTerminals>>
  try {
    infos = await list()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.setHostState?.(classifyTerminalHostError(error), message)
    return { restored: 0, failed: 0 }
  }
  store.setHostState?.("online")

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
  // this for an empty successful list clears stale ids from a host with no sessions;
  // a failed list keeps the snapshot so a transient IPC failure cannot erase it.
  store.restorePersistedLayout?.()
  return { restored, failed }
}
