import type { SmokeState } from "./smoke.ts"
import test from "node:test"
import assert from "node:assert/strict"
import { smokeCredentialGap, smokeObserveFrame, smokeOutcome } from "./smoke.ts"

// ---- smoke ------------------------------------------------------------------

test("smokeCredentialGap names every accepted variable when none is set", () => {
  assert.deepEqual(smokeCredentialGap({}), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ])
  assert.equal(
    smokeCredentialGap({ ANTHROPIC_API_KEY: "" }),
    null === null ? smokeCredentialGap({ ANTHROPIC_API_KEY: "" }) : null
  )
  assert.notEqual(
    smokeCredentialGap({ ANTHROPIC_API_KEY: "" }),
    null,
    "an empty value is not a credential"
  )
  assert.equal(smokeCredentialGap({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), null)
})

test("smokeObserveFrame tracks assistant text and every error shape", () => {
  const state: SmokeState = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(state, {
    type: "event",
    event: { type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } },
  })
  assert.equal(state.sawAssistantText, true)
  assert.equal(state.sawError, false)

  const errored: SmokeState = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(errored, {
    type: "session_ended",
    sessionId: "smoke-1",
    error: "401 invalid x-api-key",
  })
  assert.equal(errored.sawError, true)
  assert.match(errored.errorReason!, /401/)

  const result: SmokeState = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(result, {
    type: "event",
    event: { type: "result", is_error: true, subtype: "error_during_execution" },
  })
  assert.equal(result.sawError, true)

  const noise: SmokeState = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(noise, { type: "log", level: "info", message: "x" })
  smokeObserveFrame(noise, null)
  assert.deepEqual(noise, { sawAssistantText: false, sawError: false, errorReason: null })
})

test("smokeOutcome exit codes: 0 only for text without error, 1 error, 3 timeout", () => {
  assert.equal(smokeOutcome({ sawAssistantText: true, sawError: false }).code, 0)
  assert.equal(
    smokeOutcome({ sawAssistantText: true, sawError: true, errorReason: "boom" }).code,
    1
  )
  assert.equal(
    smokeOutcome({ sawAssistantText: false, sawError: false, timedOut: true, timeoutMs: 5 }).code,
    3
  )
  assert.equal(smokeOutcome({ sawAssistantText: false, sawError: false }).code, 1)
})
