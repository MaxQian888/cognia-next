// Terminal decision for one Claude Agent SDK `result` frame.
//
// The Agent SDK does not THROW on an upstream API failure — it reports it
// inside the `result` message and keeps the query alive. A 404 from a wrong
// `ANTHROPIC_BASE_URL` arrives as:
//
//   { type: "result", subtype: "success", is_error: true,
//     terminal_reason: "api_error", api_error_status: 404,
//     result: "There's an issue with the selected model (…)" }
//
// Note `subtype: "success"`. `SDKResultSuccess` carries its own `is_error` and
// `api_error_status`, so reading the subtype alone calls that turn a success —
// which is exactly how a mistyped base URL used to reach the user as "session
// <id> ended with no assistant text" with the real 404 nowhere on screen.
//
// Policy ceilings are deliberately NOT failures here. `error_max_turns`,
// `error_max_budget_usd` and `error_max_structured_output_retries` are the
// CALLER's own limits, and headless turn-loop drivers (the goal runner, /loop)
// read them off `RunAndCaptureResult.resultSubtype` to decide whether to keep
// going. Turning them into a failed turn would break those drivers, so they
// end the turn cleanly and travel as data on the result payload.

/**
 * `TerminalReason` values that mean the provider leg itself failed, as opposed
 * to a ceiling the caller asked for or a stop the caller initiated. Kept as an
 * explicit allowlist: an unknown future reason must not silently become a
 * failure and start throwing on turns that work today.
 */
export const PROVIDER_FAILURE_TERMINAL_REASONS = new Set([
  "api_error",
  "model_error",
  "prompt_too_long",
  "image_error",
  "turn_setup_failed",
])

/** Whether this `result` frame reports a genuine provider/transport failure. */
export function isProviderFailureResult(result) {
  if (!result || typeof result !== "object") return false
  if (
    typeof result.terminal_reason === "string" &&
    PROVIDER_FAILURE_TERMINAL_REASONS.has(result.terminal_reason)
  ) {
    return true
  }
  if (result.subtype === "error_during_execution") return true
  // Last resort: an HTTP status is only ever attached when a request failed.
  return typeof result.api_error_status === "number" && result.api_error_status >= 400
}

/**
 * Human-readable failure message for a `result` frame.
 *
 * The status code leads when we have one. The SDK's own prose for a 404 is
 * "There's an issue with the selected model (<model>). It may not exist or you
 * may not have access to it." — which never mentions the status, so a base-URL
 * typo reads as a model problem. Prefixing `HTTP 404` is the difference between
 * "my model name is wrong" and "my endpoint is wrong".
 */
export function providerFailureMessage(result) {
  const status = typeof result?.api_error_status === "number" ? result.api_error_status : undefined
  const reason = typeof result?.terminal_reason === "string" ? result.terminal_reason : ""
  const subtype = typeof result?.subtype === "string" ? result.subtype : ""
  // Most specific classification available. `subtype` only leads when there is
  // neither a status nor a reason, and never when it is the misleading
  // "success" that a 404 arrives with.
  const lead =
    status !== undefined
      ? `HTTP ${status}`
      : reason || (subtype && subtype !== "success" ? subtype : "")

  const listed = Array.isArray(result?.errors)
    ? result.errors.filter((e) => typeof e === "string" && e.trim() !== "").join("; ")
    : ""
  const detail = listed || (typeof result?.result === "string" ? result.result.trim() : "")

  const parts = [lead, detail].filter((part) => part !== "")
  return parts.length > 0 ? parts.join(": ") : "the provider ended the turn with an error"
}

/**
 * Build the `session_ended` event that closes the turn this `result` frame
 * terminates.
 *
 * The frame always rides along as `result` — `run-and-capture` reads usage,
 * `subtype` and `structured_output` off it, and until now the Anthropic rail
 * emitted `session_ended` with no payload at all, so every one of those had to
 * be recovered from the raw stream.
 */
export function sessionEndedFromResult(sessionId, result) {
  if (!isProviderFailureResult(result)) {
    return { type: "session_ended", sessionId, result }
  }
  const status = typeof result?.api_error_status === "number" ? result.api_error_status : undefined
  return {
    type: "session_ended",
    sessionId,
    result,
    error: providerFailureMessage(result),
    ...(status !== undefined ? { httpStatus: status } : {}),
  }
}

/**
 * Canonical `failure.code` for a non-successful `result` frame.
 *
 * Never the subtype alone: a 404 arrives with `subtype: "success"`, so
 * `String(evt.subtype)` produced the nonsense code `"success"` on a failure
 * envelope. An explicit error subtype still wins — `error_max_turns` is a more
 * useful code than its `max_turns` terminal reason.
 */
export function failureCodeFromResult(result) {
  const subtype = typeof result?.subtype === "string" ? result.subtype : ""
  if (subtype && subtype !== "success") return subtype
  const reason = typeof result?.terminal_reason === "string" ? result.terminal_reason : ""
  if (reason && reason !== "completed") return reason
  return "error"
}
