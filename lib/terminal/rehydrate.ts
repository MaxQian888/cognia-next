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
import { SshTerminalSession } from "./ssh-session"
import { RemoteTerminalSession } from "./transport-ws"
import { selectTerminalTransportChain, type TerminalTransportKind } from "./pick-transport"
import { getLiveSession, registerLiveSession } from "./session-registry"
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

function registerReattachedSession(
  info: SessionInfo,
  session: BaseTerminalSession,
  store: TerminalStoreLike
): void {
  // The dock mounts from the row, so the live handle must exist first.
  registerLiveSession(session)
  store.registerSession({
    id: info.id,
    projectId: info.projectId,
    extensionId: info.extensionId,
    origin: info.origin,
    shell: info.shell,
    kind: info.kind,
    profileId: info.profileId,
    hostId: info.hostId,
    remoteHost: session.info.remoteHost !== undefined ? session.info.remoteHost : info.remoteHost,
  })
  wireSessionToStore(session, store)
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
  info: SessionInfo,
  resumeAfter: number
): Promise<BaseTerminalSession> {
  return tryTransportChain((transport) => {
    switch (transport) {
      case "tauri-channel":
        // An SSH session reattaches through the same host command, but as an
        // `SshTerminalSession` so its host-key verdict and profile id survive
        // the reload. Rebuilding it as a plain `TerminalSession` still moves
        // bytes — the `ssh_terminal_*` commands are aliases of their generic
        // twins — but silently drops the fingerprint the user was shown.
        return (
          info.kind === "ssh"
            ? SshTerminalSession.reattach(info, resumeAfter)
            : TerminalSession.reattach(info.id, resumeAfter)
        ).then((session) => {
          // Origin describes the spawning client, which may have been a phone;
          // reattaching over the desktop channel identifies the owning host.
          session.info.remoteHost = null
          return session
        })
      case "ws":
        return RemoteTerminalSession.reattachLan(info.id, resumeAfter)
      case "webrtc":
        return RemoteTerminalSession.reattachWan(info.id, resumeAfter)
      default:
        return Promise.reject(new Error("terminal transport unavailable"))
    }
  })
}

/** Recover only a named native CLI before spawning, including a detached process. */
export class TerminalProfileRecoveryError extends Error {
  constructor(
    readonly code: "ambiguous" | "not-native" | "identity-changed",
    message: string
  ) {
    super(message)
    this.name = "TerminalProfileRecoveryError"
  }
}

export async function rehydrateTerminalProfile(
  profileId: string,
  opts: {
    store?: TerminalStoreLike
    list?: () => Promise<SessionInfo[]>
    reattach?: (info: SessionInfo, resumeAfter: number) => Promise<BaseTerminalSession>
  } = {}
): Promise<string | undefined> {
  const store = opts.store ?? useTerminalStore.getState()
  // Unlike boot's best-effort recovery, an unknown list must not authorize a
  // replacement process: the old native agent may still be running.
  const infos = await (opts.list ?? listFromActiveHost)()
  const matching = infos.filter((info) => info.profileId === profileId && info.alive !== false)
  if (matching.length > 1)
    throw new TerminalProfileRecoveryError(
      "ambiguous",
      "multiple live terminals use this agent profile"
    )
  const info = matching[0]
  if (!info) return undefined
  if (info.kind && info.kind !== "localPty")
    throw new TerminalProfileRecoveryError("not-native", "agent profile is not a native terminal")
  // Boot may have registered it while the host list was in flight. The passed
  // Zustand snapshot can predate that row; the live registry is authoritative.
  const live = getLiveSession(info.id)
  if (live && !live.isExited && live.info.alive !== false) return info.id
  const session = await (opts.reattach ?? reattachToActiveHost)(info, 0)
  if (session.info.id !== info.id) {
    await session.detach()
    throw new TerminalProfileRecoveryError(
      "identity-changed",
      "terminal host returned a different session identity"
    )
  }
  registerReattachedSession(info, session, store)
  return info.id
}

export async function rehydrateTerminals(
  opts: {
    store?: RehydrateStore
    list?: () => Promise<SessionInfo[]>
    reattach?: (info: SessionInfo, resumeAfter: number) => Promise<BaseTerminalSession>
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
      const session = await reattach(info, 0)
      registerReattachedSession(info, session, store)
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
