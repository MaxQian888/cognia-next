import type { AnyMessage, ProtocolVersion } from "@agentclientprotocol/sdk"

type AcpMethodStability = "stable" | "feature_gated" | "legacy" | "future"

const STABLE_METHODS = new Set<string>([
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/list",
  "session/delete",
  "session/resume",
  "session/close",
  "session/set_mode",
  "session/set_config_option",
  "session/prompt",
  "session/cancel",
  "logout",
  "session/request_permission",
  "session/update",
  "fs/write_text_file",
  "fs/read_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
  "terminal/kill",
  "$/cancel_request",
])

const FEATURE_GATED_METHODS = new Set<string>([
  "elicitation/create",
  "elicitation/complete",
  "providers/list",
  "providers/set",
  "providers/disable",
  "mcp/connect",
  "mcp/message",
  "mcp/disconnect",
  "session/fork",
  "nes/start",
  "nes/suggest",
  "nes/accept",
  "nes/reject",
  "nes/close",
  "document/didOpen",
  "document/didChange",
  "document/didClose",
  "document/didSave",
  "document/didFocus",
])

const LEGACY_METHODS = new Set(["session/set_model", "session/fork", "terminal/write"])

export const ACP_PROTOCOL_REGISTRY = Object.freeze({
  v1: Object.freeze({ protocolVersion: 1 satisfies ProtocolVersion, advertised: true }),
  v2: Object.freeze({ protocolVersion: 2, advertised: false }),
})

export class AcpWireValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AcpWireValidationError"
  }
}

export function classifyAcpV1Method(method: string): AcpMethodStability {
  if (STABLE_METHODS.has(method)) return "stable"
  if (FEATURE_GATED_METHODS.has(method)) return "feature_gated"
  if (LEGACY_METHODS.has(method)) return "legacy"
  return "future"
}

/**
 * Validate the stable JSON-RPC envelope without stripping extension fields.
 * Method payloads stay typed at their SDK call sites; preserving the original
 * object is intentional so unknown `_meta`, enum variants, and future fields
 * survive the codec boundary unchanged.
 */
export function validateAcpV1Envelope(value: unknown): AnyMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcpWireValidationError("ACP message must be an object")
  }

  const message = value as Record<string, unknown>
  if (message.jsonrpc !== "2.0") {
    throw new AcpWireValidationError('ACP message must use JSON-RPC "2.0"')
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id")
  if (hasId && typeof message.id !== "string" && typeof message.id !== "number") {
    throw new AcpWireValidationError("ACP request/response id must be a string or number")
  }

  const hasMethod = Object.prototype.hasOwnProperty.call(message, "method")
  if (hasMethod && typeof message.method !== "string") {
    throw new AcpWireValidationError("ACP method must be a string")
  }
  const method = typeof message.method === "string" ? message.method : undefined
  if (hasMethod && method?.length === 0) {
    throw new AcpWireValidationError("ACP method must not be empty")
  }

  const isCall = hasMethod
  const isResponse = hasId && ("result" in message || "error" in message)
  if (!isCall && !isResponse) {
    throw new AcpWireValidationError("ACP message must be a request, notification, or response")
  }
  if (isCall && ("result" in message || "error" in message)) {
    throw new AcpWireValidationError("ACP call cannot contain result or error")
  }
  if (isResponse && "result" in message && "error" in message) {
    throw new AcpWireValidationError("ACP response cannot contain both result and error")
  }

  return value as AnyMessage
}
