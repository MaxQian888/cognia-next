/**
 * JSON-RPC 2.0 protocol types for the `@cognia/agent/rpc` surface.
 *
 * These are the wire shapes for the newline-delimited JSON protocol served by
 * `cognia-agent rpc` and consumed by `createRpcClient`. Every method dispatches
 * to the public `CogniaRuntime` / `CogniaSession` SDK — never to provider or
 * session internals directly.
 */

// ─── JSON-RPC 2.0 wire shapes ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0"
  id: string | number
  result: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0"
  id: string | number
  error: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

// ─── Standard error codes ────────────────────────────────────────────────────

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  // Application-defined codes (>= -32000)
  sessionBusy: -32001,
  sessionNotFound: -32002,
  sessionLocked: -32003,
  configError: -32004,
  permissionDenied: -32005,
  capabilityError: -32006,
  cancelled: -32007,
  timeout: -32008,
} as const

// ─── Method catalog ──────────────────────────────────────────────────────────

/**
 * All RPC methods the server exposes. Each dispatches to the corresponding
 * SDK operation — the RPC layer adds no logic beyond JSON-RPC framing,
 * validation, and error mapping.
 */
export type RpcMethod =
  // Runtime
  | "runtime.discover"
  | "runtime.shutdown"
  | "runtime.models"
  // Session lifecycle
  | "session.create"
  | "session.open"
  | "session.list"
  | "session.state"
  | "session.messages"
  | "session.entries"
  | "session.stats"
  | "session.export"
  | "session.name"
  | "session.model"
  | "session.thinking"
  | "session.compact"
  | "session.undoCompact"
  | "session.fork"
  | "session.clone"
  | "session.tree"
  | "session.annotation"
  | "session.close"
  // Turn
  | "turn.run"
  | "turn.steer"
  | "turn.followUp"
  | "turn.abort"
  // Permission / elicitation settlement
  | "permission.respond"
  | "elicitation.respond"

export const RPC_METHODS: readonly RpcMethod[] = [
  "runtime.discover",
  "runtime.shutdown",
  "runtime.models",
  "session.create",
  "session.open",
  "session.list",
  "session.state",
  "session.messages",
  "session.entries",
  "session.stats",
  "session.export",
  "session.name",
  "session.model",
  "session.thinking",
  "session.compact",
  "session.undoCompact",
  "session.fork",
  "session.clone",
  "session.tree",
  "session.annotation",
  "session.close",
  "turn.run",
  "turn.steer",
  "turn.followUp",
  "turn.abort",
  "permission.respond",
  "elicitation.respond",
]

/** Protocol version. Bumped on breaking wire-format changes. */
export const RPC_PROTOCOL_VERSION = 1

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    obj.jsonrpc === "2.0" &&
    (typeof obj.id === "string" || typeof obj.id === "number") &&
    typeof obj.method === "string"
  )
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return obj.jsonrpc === "2.0" && typeof obj.method === "string" && obj.id === undefined
}

export function makeSuccessResponse(id: string | number, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result }
}

export function makeErrorResponse(
  id: string | number,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

export function makeNotification(
  method: string,
  params?: Record<string, unknown>
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }
}
