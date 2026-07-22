// Pure helpers for the renderer→sidecar live session-control round-trip.
//
// The renderer drives the Claude Agent SDK `Query`'s streaming-input-only
// control methods (getContextUsage / mcpServerStatus / setModel / …) by sending
// a `{ type: "control", sessionId, requestId, method, params }` line; the host
// looks up the session, invokes `q[method](...args)`, and replies with a
// `control_response` event. Keeping the allowlist + arg-mapping + response
// shaping here (no I/O) makes them unit-testable via `pnpm sidecar:test`.

/**
 * Allowlisted SDK `Query` control methods. Defense-in-depth: the host refuses
 * any method outside this set so a malformed/hostile `control` line can never
 * reflectively invoke an arbitrary property on the live query object.
 */
export const CONTROL_METHODS = new Set([
  "getContextUsage",
  "mcpServerStatus",
  "reconnectMcpServer",
  "toggleMcpServer",
  "supportedModels",
  "supportedCommands",
  "setModel",
  "steer",
])

/** True when `method` is an allowlisted control method. */
export function isControlMethod(method) {
  return typeof method === "string" && CONTROL_METHODS.has(method)
}

/**
 * Map a control method + params object to the positional argument array for
 * `q[method](...args)`. No-arg methods return `[]`. Unknown methods are caught
 * earlier by {@link isControlMethod}.
 */
export function controlArgs(method, params) {
  const p = params ?? {}
  switch (method) {
    case "setModel":
      return [p.model]
    case "reconnectMcpServer":
      return [p.name]
    case "toggleMcpServer":
      return [p.name, p.enabled]
    case "steer":
      return [p.prompt, p.priority]
    default:
      return []
  }
}

/**
 * Shape the `control_response` event. On success `result` carries the SDK
 * return value (omitted when `undefined`); on failure `error` is a stable code
 * (`no_active_session` | `unsupported_provider` | `unknown_method`) or a thrown
 * message.
 */
export function buildControlResponse({ sessionId, requestId, method, ok, result, error }) {
  const msg = { type: "control_response", sessionId, requestId, method, ok }
  if (ok) {
    if (result !== undefined) msg.result = result
  } else {
    msg.error = error ?? "error"
  }
  return msg
}
