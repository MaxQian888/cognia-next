/**
 * Wire contract for the WASM capability bridge.
 *
 * The Rust half lives in `crates/cognia-plugin-runtime/src/wasm/bridge.rs`.
 * Two v0.2 host capabilities cannot be served in-process — `ai.generate-text`
 * needs the provider chain and the PII redaction gate, `workflow.emit-event`
 * needs the trigger registry — and all of that lives here in TypeScript.
 *
 * The three string constants below are the entire integration surface with
 * Rust. A typo in any of them produces a silent hang that no unit test can
 * catch, because every renderer test injects a fake bridge. They must match
 * `bridge.rs`'s `REQUEST_EVENT` / `CANCEL_EVENT` / `RESPONSE_COMMAND` exactly.
 */

/** Host -> renderer: one capability request. Matches `bridge.rs::REQUEST_EVENT`. */
export const WASM_RENDERER_REQUEST_EVENT = "plugin-wasm://renderer-request"
/** Host -> renderer: abort an in-flight request. Matches `bridge.rs::CANCEL_EVENT`. */
export const WASM_RENDERER_CANCEL_EVENT = "plugin-wasm://renderer-cancel"
/** Renderer -> host: answer a request. Matches `bridge.rs::RESPONSE_COMMAND`. */
export const WASM_RENDERER_RESPONSE_COMMAND = "plugin_wasm_renderer_response"

/**
 * Serialized-payload ceiling on this side.
 *
 * Deliberately far below Rust's 4 MiB envelope limit: by the time a request
 * reaches the renderer it has already passed the host's own per-surface caps
 * (1 MiB AI prompt, 4 MiB workflow payload), so anything arriving here that is
 * still large is a bug or an attack, not a legitimate call.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024

export const WASM_BRIDGE_ERROR_CODES = [
  "CAPABILITY_DENIED",
  "INVALID_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "TIMEOUT",
  "CANCELLED",
  "HOST_UNAVAILABLE",
  "PROVIDER_ERROR",
  "WORKFLOW_REJECTED",
] as const

export type WasmBridgeErrorCode = (typeof WASM_BRIDGE_ERROR_CODES)[number]

export const WASM_BRIDGE_OPERATIONS = ["ai.generate-text", "workflow.emit-event"] as const

export type WasmBridgeOperation = (typeof WASM_BRIDGE_OPERATIONS)[number]

export interface WasmRendererRequest {
  requestId: string
  pluginId: string
  operation: WasmBridgeOperation
  timeoutMs: number
  payload: Record<string, unknown>
}

export interface WasmRendererResponse {
  requestId: string
  pluginId: string
  result?: unknown
  error?: { code: WasmBridgeErrorCode; message: string }
}

export type WasmCancelReason = "timeout" | "caller" | "deactivate" | "unload"

export interface WasmRendererCancel {
  requestId: string
  pluginId: string
  reason: WasmCancelReason
}

export type ParsedRequest =
  | { ok: true; request: WasmRendererRequest }
  | { ok: false; reason: string; requestId?: string; pluginId?: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * Validate an inbound request envelope.
 *
 * `requestId` and `pluginId` are echoed back on failure when they are present
 * and usable, so a malformed request can still be answered rather than hanging
 * until the host's timeout. When they are missing there is nothing to answer
 * *to* — the caller drops the frame.
 */
export function parseRendererRequest(raw: unknown): ParsedRequest {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "request envelope is not an object" }
  }
  const candidate = raw as Record<string, unknown>
  const requestId = isNonEmptyString(candidate.requestId) ? candidate.requestId : undefined
  const pluginId = isNonEmptyString(candidate.pluginId) ? candidate.pluginId : undefined

  if (!requestId) return { ok: false, reason: "requestId is missing or empty" }
  if (!pluginId) return { ok: false, reason: "pluginId is missing or empty", requestId }

  const operation = candidate.operation
  if (
    typeof operation !== "string" ||
    !(WASM_BRIDGE_OPERATIONS as readonly string[]).includes(operation)
  ) {
    return { ok: false, reason: `unknown operation: ${String(operation)}`, requestId, pluginId }
  }

  const timeoutMs = candidate.timeoutMs
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      ok: false,
      reason: `timeoutMs must be a positive finite number, got ${String(timeoutMs)}`,
      requestId,
      pluginId,
    }
  }

  const payload = candidate.payload
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object", requestId, pluginId }
  }

  return {
    ok: true,
    request: {
      requestId,
      pluginId,
      operation: operation as WasmBridgeOperation,
      timeoutMs,
      payload: payload as Record<string, unknown>,
    },
  }
}

/** Byte length of a value once serialized, or `null` when it cannot be. */
export function serializedByteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return null
    // Byte length, not string length — a CJK or emoji payload is far larger
    // than its `.length` suggests, and the cap is about bytes on the wire.
    return new TextEncoder().encode(json).length
  } catch {
    return null
  }
}
