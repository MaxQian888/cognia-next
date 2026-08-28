import { test } from "node:test"
import assert from "node:assert/strict"
import {
  failureCodeFromResult,
  isProviderFailureResult,
  providerFailureMessage,
  sessionEndedFromResult,
} from "./result-terminal.mjs"

/**
 * Captured verbatim from a live Agent SDK run against a loopback server that
 * 404s every request — i.e. exactly what a mistyped `ANTHROPIC_BASE_URL`
 * produces. Note `subtype: "success"` alongside `is_error: true`.
 */
const API_404_RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 404,
  stop_reason: "stop_sequence",
  num_turns: 1,
  duration_ms: 452,
  total_cost_usd: 0,
  result:
    "There's an issue with the selected model (claude-sonnet-4-5-20250929). " +
    "It may not exist or you may not have access to it.",
}

/** Captured from the same harness against a server that answers correctly. */
const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
  api_error_status: null,
  stop_reason: "end_turn",
  num_turns: 1,
  duration_ms: 456,
  total_cost_usd: 0.000111,
  result: "hi from the fake server",
}

test("isProviderFailureResult: a 404 riding on subtype:success is a failure", () => {
  assert.equal(isProviderFailureResult(API_404_RESULT), true)
})

test("isProviderFailureResult: a completed turn is not a failure", () => {
  assert.equal(isProviderFailureResult(SUCCESS_RESULT), false)
})

test("isProviderFailureResult: caller-owned ceilings end the turn cleanly", () => {
  // Headless turn-loop drivers read these off `resultSubtype` and decide
  // whether to continue. Reporting them as failures would break the goal /loop
  // runners, so they must NOT be provider failures.
  for (const subtype of [
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ]) {
    assert.equal(
      isProviderFailureResult({ subtype, is_error: true, terminal_reason: "max_turns" }),
      false,
      subtype
    )
  }
})

test("isProviderFailureResult: caller-initiated stops are not provider failures", () => {
  for (const terminal_reason of ["aborted_streaming", "aborted_tools", "hook_stopped"]) {
    assert.equal(isProviderFailureResult({ subtype: "success", terminal_reason }), false)
  }
})

test("isProviderFailureResult: error_during_execution and a 4xx/5xx status", () => {
  assert.equal(isProviderFailureResult({ subtype: "error_during_execution" }), true)
  assert.equal(isProviderFailureResult({ subtype: "success", api_error_status: 502 }), true)
  // A status below 400 is not a failure signal.
  assert.equal(isProviderFailureResult({ subtype: "success", api_error_status: 200 }), false)
})

test("isProviderFailureResult: non-objects are never failures", () => {
  assert.equal(isProviderFailureResult(undefined), false)
  assert.equal(isProviderFailureResult(null), false)
  assert.equal(isProviderFailureResult("result"), false)
})

test("providerFailureMessage: the status leads, so a base-URL typo is legible", () => {
  const message = providerFailureMessage(API_404_RESULT)
  assert.match(message, /^HTTP 404: /)
  assert.match(message, /claude-sonnet-4-5-20250929/)
})

test("providerFailureMessage: SDKResultError.errors wins over the prose field", () => {
  assert.equal(
    providerFailureMessage({
      subtype: "error_during_execution",
      errors: ["upstream refused the connection", ""],
      result: "ignored",
    }),
    "error_during_execution: upstream refused the connection"
  )
})

test("providerFailureMessage: falls back to the terminal reason, then to prose", () => {
  assert.equal(
    providerFailureMessage({ subtype: "success", terminal_reason: "model_error" }),
    "model_error"
  )
  assert.equal(providerFailureMessage({}), "the provider ended the turn with an error")
})

test("sessionEndedFromResult: a success carries the result and no error", () => {
  assert.deepEqual(sessionEndedFromResult("s_1", SUCCESS_RESULT), {
    type: "session_ended",
    sessionId: "s_1",
    result: SUCCESS_RESULT,
  })
})

test("sessionEndedFromResult: a 404 carries the message and the real status", () => {
  const event = sessionEndedFromResult("s_1", API_404_RESULT)
  assert.equal(event.type, "session_ended")
  assert.equal(event.sessionId, "s_1")
  assert.equal(event.httpStatus, 404)
  assert.match(event.error, /^HTTP 404: /)
  // The frame still rides along: usage / subtype / structured_output are read
  // off it by `run-and-capture`.
  assert.equal(event.result, API_404_RESULT)
})

test("sessionEndedFromResult: omits httpStatus when the SDK reported none", () => {
  const event = sessionEndedFromResult("s_1", {
    subtype: "error_during_execution",
    errors: ["boom"],
  })
  assert.equal("httpStatus" in event, false)
  assert.equal(event.error, "error_during_execution: boom")
})

test("failureCodeFromResult: a 404 is api_error, never the literal 'success'", () => {
  assert.equal(failureCodeFromResult(API_404_RESULT), "api_error")
})

test("failureCodeFromResult: an explicit error subtype wins over the reason", () => {
  assert.equal(
    failureCodeFromResult({ subtype: "error_max_turns", terminal_reason: "max_turns" }),
    "error_max_turns"
  )
})

test("failureCodeFromResult: degrades to 'error' with nothing to go on", () => {
  assert.equal(failureCodeFromResult({ subtype: "success", terminal_reason: "completed" }), "error")
  assert.equal(failureCodeFromResult({}), "error")
})
