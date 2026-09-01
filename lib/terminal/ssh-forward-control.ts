"use client"

/**
 * Reading and steering a live session's SSH tunnels.
 *
 * Pull-only, deliberately. The host never pushes forwarding state: an older
 * client that has never heard of these frames must not be sent one (ADR-0033),
 * so the panel asks while it is open and stops asking when it closes.
 *
 * Toggling answers with the same snapshot a plain read would, because enabling
 * a rule is a request rather than a result — binding a socket, or persuading
 * the server to bind one, happens on its own schedule and can fail. The reply
 * therefore carries the post-change truth, including the reason when there is
 * one, so the UI never has to guess what its own click did.
 *
 * Local-identity only on the far side: a phone or LAN client naming a session
 * cannot open a listening port on the desktop (ADR-0082 §8.3).
 */

import { transport } from "@/lib/tauri"

import { hostSupportsProtocolFeature } from "./host-capabilities"
import { selectTerminalTransportChain } from "./pick-transport"
import { getLiveSession } from "./session-registry"

export type SshForwardDirection = "local" | "remote"

export type SshForwardRunState = "stopped" | "starting" | "listening" | "waiting" | "failed"

export interface SshForwardStatus {
  id: string
  direction: SshForwardDirection
  /** Endpoints, already loopback-qualified by the native side. */
  summary: string
  enabled: boolean
  state: SshForwardRunState
  activeConnections: number
  /** Callers accepted locally that are waiting for the link to come back. */
  queuedConnections: number
  error: string | null
}

const RUN_STATES: readonly SshForwardRunState[] = [
  "stopped",
  "starting",
  "listening",
  "waiting",
  "failed",
]

function isForwardStatus(value: unknown): value is SshForwardStatus {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    (row.direction === "local" || row.direction === "remote") &&
    typeof row.summary === "string" &&
    typeof row.enabled === "boolean" &&
    RUN_STATES.includes(row.state as SshForwardRunState) &&
    typeof row.activeConnections === "number" &&
    typeof row.queuedConnections === "number"
  )
}

/**
 * Keep only the rows we can render.
 *
 * A session that predates forwarding answers with nothing, and a future host
 * could add a state this build has no label for. Dropping the unreadable rows
 * beats throwing: the panel showing three of four tunnels is worth more than
 * the panel showing an error.
 */
function parseForwardStatuses(value: unknown): SshForwardStatus[] {
  if (!Array.isArray(value)) return []
  return value.filter(isForwardStatus).map((row) => ({
    id: row.id,
    direction: row.direction,
    summary: row.summary,
    enabled: row.enabled,
    state: row.state,
    activeConnections: row.activeConnections,
    queuedConnections: row.queuedConnections,
    error: typeof row.error === "string" && row.error.length > 0 ? row.error : null,
  }))
}

/**
 * Markers for the two refusals this module produces on its own.
 *
 * Markers rather than sentences because this module has no translator, and the
 * panel that renders them does. Before these existed the remote path threw the
 * transport's own `command_transport_forbidden` and the panel printed that
 * string at the user, once every two seconds.
 */
export const SSH_FORWARD_TOGGLE_LOCAL_ONLY = "ssh_forward_toggle_local_only"
export const SSH_FORWARD_SESSION_UNREACHABLE = "ssh_forward_session_unreachable"
/** The host is too old to answer frames 24/25. */
export const SSH_FORWARD_HOST_TOO_OLD = "ssh_forward_host_too_old"

/** Whether this shell owns the SSH client, and may therefore change a tunnel. */
export function canControlSshForwards(
  chain: typeof selectTerminalTransportChain = selectTerminalTransportChain
): boolean {
  return chain()[0] === "tauri-channel"
}

interface RemoteForwardCapableSession {
  sshForwardControl(
    payload: { kind: "status" } | { kind: "setEnabled"; forwardId: string; enabled: boolean }
  ): Promise<unknown>
}

/**
 * The live handle for `sessionId`, when it can carry frames 24/25.
 *
 * Duck-typed rather than `instanceof RemoteTerminalSession` so this module does
 * not drag the WebSocket transport into every bundle that reads a forward
 * status — the local PTY path must not pay for it.
 */
function remoteForwardSession(sessionId: string): RemoteForwardCapableSession | null {
  const session = getLiveSession(sessionId) as Partial<RemoteForwardCapableSession> | undefined
  return typeof session?.sshForwardControl === "function"
    ? (session as RemoteForwardCapableSession)
    : null
}

export async function readSshForwardStatus(sessionId: string): Promise<SshForwardStatus[]> {
  if (canControlSshForwards()) {
    return parseForwardStatuses(
      await transport.call<unknown>("ssh_terminal_forward_status", { id: sessionId })
    )
  }
  // `forward_status` admits any attached connection, so the read is legal from
  // a phone; only the write is not. A host that never named `sshForwarding` in
  // its hello ack predates the frames, and asking would earn an
  // `invalid_request` that reads like a bug rather than an age difference.
  if (!hostSupportsProtocolFeature("sshForwarding")) {
    throw new Error(SSH_FORWARD_HOST_TOO_OLD)
  }
  const session = remoteForwardSession(sessionId)
  if (!session) throw new Error(SSH_FORWARD_SESSION_UNREACHABLE)
  return parseForwardStatuses(await session.sshForwardControl({ kind: "status" }))
}

export async function setSshForwardEnabled(
  sessionId: string,
  forwardId: string,
  enabled: boolean
): Promise<SshForwardStatus[]> {
  // Refused here rather than on the wire. `TerminalHost::set_forward_enabled`
  // is local-identity only by design (ADR-0082, forwarding amendment): a paired
  // device must not be able to make this machine — or a server this machine can
  // reach — start listening on a port. Sending it anyway would spend a round
  // trip to be told the same thing in a vocabulary the panel cannot translate.
  if (!canControlSshForwards()) throw new Error(SSH_FORWARD_TOGGLE_LOCAL_ONLY)
  return parseForwardStatuses(
    await transport.call<unknown>("ssh_terminal_set_forward_enabled", {
      id: sessionId,
      forwardId,
      enabled,
    })
  )
}
