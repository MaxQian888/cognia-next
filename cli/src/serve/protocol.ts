/**
 * Bridge WS protocol v2 — TS side (ADR-0059 W3 / T-B1).
 *
 * Frame shapes are frozen in `./fixtures/bridge-frames.json`, asserted
 * byte-for-byte by BOTH this package's tests and the Rust server
 * (`src-tauri/src/companion_api/ws_bridge.rs` via `include_str!`). Do not
 * change a field without bumping the protocol on both sides.
 */

import { HEADLESS_CATALOG_HASH, HEADLESS_CONTRACT_VERSION } from "./headless-contract-identity"

export const BRIDGE_PROTOCOL_VERSION = 3

export interface HelloFrame {
  v: number
  type: "hello"
  role: "brain"
  brainVersion: string
  protocol: number
  accountId: string
  capabilities: string[]
  catalogHash: string
  contractVersion: number
}

export interface HelloAckFrame {
  v: number
  type: "hello_ack"
  serverVersion: string
  protocol: number
  accountId: string
  catalogHash: string
  contractVersion: number
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

export interface WorkerAttachFrame {
  v: number
  type: "worker_attach"
  connectionId: string
  /** Derived from the authenticated Companion device identity by the front door. */
  hostRef: string
  manifest: Record<string, unknown>
}

export interface WorkerFrame {
  v: number
  type: "worker_frame"
  connectionId: string
  /** An opaque, newline-free Agent RPC v2 JSON frame. */
  frame: string
}

export interface WorkerDetachFrame {
  v: number
  type: "worker_detach"
  connectionId: string
  hostRef: string
  reason: string
}

export type BridgeFrame =
  | HelloFrame
  | HelloAckFrame
  | EventFrame
  | RespondFrame
  | PingFrame
  | PongFrame
  | TokenRefreshFrame
  | WorkerAttachFrame
  | WorkerFrame
  | WorkerDetachFrame

const FRAME_TYPES = new Set([
  "hello",
  "hello_ack",
  "event",
  "respond",
  "ping",
  "pong",
  "token_refresh",
  "worker_attach",
  "worker_frame",
  "worker_detach",
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

/**
 * What this brain build can answer, announced in `hello`.
 *
 * `media` is load-bearing rather than decorative. The command catalog does not
 * change when a `respond` command is added, so the catalog hash stays equal and
 * an older brain connects to a newer server perfectly happily, then never
 * answers a session-media request: the device waits out the full timeout and
 * reports a retryable 503 that describes nothing. Declaring the capability lets
 * the server refuse the read immediately, with a reason.
 */
/**
 * `respond` command that carries a session-media answer.
 *
 * Named here rather than at the call site so the TS producer and the Rust
 * `route_respond` arm are one grep apart. A producer whose command has no arm
 * is dropped with a warning and resolves nothing, which is the exact shape of
 * the bug this frame was added to fix.
 */
export const MEDIA_RESPONSE_COMMAND = "companion_media_response"

export const DEFAULT_BRAIN_CAPABILITIES = ["sync", "messages", "writes", "media"] as const

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
    capabilities: opts.capabilities ?? [...DEFAULT_BRAIN_CAPABILITIES],
    catalogHash: HEADLESS_CATALOG_HASH,
    contractVersion: HEADLESS_CONTRACT_VERSION,
  }
}

export function buildRespond(command: string, payload: Record<string, unknown>): RespondFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, type: "respond", command, payload }
}

export function buildPong(ts: number, rssBytes: number, lastFlushAt: number): PongFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, type: "pong", ts, rssBytes, lastFlushAt }
}

export function buildWorkerFrame(connectionId: string, frame: string): WorkerFrame {
  if (frame.includes("\n") || frame.includes("\r")) {
    throw new Error("worker Agent RPC frames must not contain newlines")
  }
  return { v: BRIDGE_PROTOCOL_VERSION, type: "worker_frame", connectionId, frame }
}
