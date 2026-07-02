/**
 * Bridge WS protocol v1 — TS side (ADR-0059 W3 / T-B1).
 *
 * Frame shapes are frozen in `./fixtures/bridge-frames.json`, asserted
 * byte-for-byte by BOTH this package's tests and the Rust server
 * (`src-tauri/src/companion_api/ws_bridge.rs` via `include_str!`). Do not
 * change a field without bumping the protocol on both sides.
 */

export const BRIDGE_PROTOCOL_VERSION = 1

export interface HelloFrame {
  v: number
  type: "hello"
  role: "brain"
  brainVersion: string
  protocol: number
  accountId: string
  capabilities: string[]
}

export interface HelloAckFrame {
  v: number
  type: "hello_ack"
  serverVersion: string
  protocol: number
  accountId: string
}

export interface EventFrame {
  v: number
  type: "event"
  /** The Tauri channel name; payload is byte-identical to the desktop event. */
  event: string
  payload: unknown
}

export interface RespondFrame {
  v: number
  type: "respond"
  /** The Tauri response-command name; payload is its args verbatim. */
  command: string
  payload: Record<string, unknown>
}

export interface PingFrame {
  v: number
  type: "ping"
  ts: number
}

export interface PongFrame {
  v: number
  type: "pong"
  ts: number
  rssBytes: number
  lastFlushAt: number
}

export interface TokenRefreshFrame {
  v: number
  type: "token_refresh"
  token: string
}

export type BridgeFrame =
  | HelloFrame
  | HelloAckFrame
  | EventFrame
  | RespondFrame
  | PingFrame
  | PongFrame
  | TokenRefreshFrame

const FRAME_TYPES = new Set([
  "hello",
  "hello_ack",
  "event",
  "respond",
  "ping",
  "pong",
  "token_refresh",
])

/**
 * Parse one wire frame. Unknown/malformed frames return `null` — the
 * contract says log + ignore, never throw on foreign input.
 */
export function parseBridgeFrame(text: string): BridgeFrame | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const frame = value as Record<string, unknown>
  if (typeof frame.type !== "string" || !FRAME_TYPES.has(frame.type)) return null
  if (typeof frame.v !== "number") return null
  return frame as unknown as BridgeFrame
}

export function serializeBridgeFrame(frame: BridgeFrame): string {
  return JSON.stringify(frame)
}

export function buildHello(opts: {
  brainVersion: string
  accountId: string
  capabilities?: string[]
}): HelloFrame {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: "hello",
    role: "brain",
    brainVersion: opts.brainVersion,
    protocol: BRIDGE_PROTOCOL_VERSION,
    accountId: opts.accountId,
    capabilities: opts.capabilities ?? ["sync", "messages", "writes"],
  }
}

export function buildRespond(command: string, payload: Record<string, unknown>): RespondFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, type: "respond", command, payload }
}

export function buildPong(ts: number, rssBytes: number, lastFlushAt: number): PongFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, type: "pong", ts, rssBytes, lastFlushAt }
}
