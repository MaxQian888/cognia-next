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

export async function readSshForwardStatus(sessionId: string): Promise<SshForwardStatus[]> {
  return parseForwardStatuses(
    await transport.call<unknown>("ssh_terminal_forward_status", { id: sessionId })
  )
}

export async function setSshForwardEnabled(
  sessionId: string,
  forwardId: string,
  enabled: boolean
): Promise<SshForwardStatus[]> {
  return parseForwardStatuses(
    await transport.call<unknown>("ssh_terminal_set_forward_enabled", {
      id: sessionId,
      forwardId,
      enabled,
    })
  )
}
