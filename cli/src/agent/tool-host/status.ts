/**
 * The live Cognia-parity facts, published by the session and read by `/status`
 * and `/doctor`.
 *
 * The session owns the broker; the diagnostics panels are built by controllers
 * that never see it. Without a published snapshot those panels could only repeat
 * static backend assumptions — which is exactly the "capability UI models
 * transport support, not parity" gap. A tiny registry keyed by chat session id
 * keeps the reporting honest without handing the controllers a broker handle
 * they could act on.
 */

export interface ToolHostSnapshot {
  /** The backend these facts describe. */
  backend: string
  /** Fingerprint of the resolved context the session is running under. */
  contextVersion: string
  /** The protocol can carry an MCP server at `session/new`. */
  attachable: boolean
  /** The broker is up and the bridge entries were attached. */
  running: boolean
  /** Effective `cognia-tools` count under the current policy. */
  builtinToolCount: number
  /** Effective `cognia-plugin-tools` count under the current policy. */
  hostToolCount: number
  /** True when `dispatch_agent` is among the projected host tools. */
  subagentDispatch: boolean
  /** Enabled user MCP servers forwarded alongside Cognia's own. */
  userMcpCount: number
  /** Bridges currently connected to the broker. */
  connections: number
}

const snapshots = new Map<string, ToolHostSnapshot>()

/** Record (or replace) the parity snapshot for a session. */
export function publishToolHostStatus(sessionId: string, snapshot: ToolHostSnapshot): void {
  snapshots.set(sessionId, snapshot)
}

/** Read a session's snapshot, or undefined when nothing has been published. */
export function readToolHostStatus(sessionId: string): ToolHostSnapshot | undefined {
  return snapshots.get(sessionId)
}

/** Drop a session's snapshot — the session ended or switched backends. */
export function clearToolHostStatus(sessionId: string): void {
  snapshots.delete(sessionId)
}

/** The most recently published snapshot, for surfaces that have no session id. */
export function latestToolHostStatus(): ToolHostSnapshot | undefined {
  let last: ToolHostSnapshot | undefined
  for (const snapshot of snapshots.values()) last = snapshot
  return last
}

/** Test-only — wipe the registry. */
export function __resetToolHostStatusForTesting(): void {
  snapshots.clear()
}
