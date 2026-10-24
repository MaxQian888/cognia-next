import { test } from "node:test"
import assert from "node:assert/strict"
import { errorToMessage, terminalErrorMessage } from "./messages.ts"

test("structured provider failures reveal only their code in the error message", () => {
  assert.equal(
    terminalErrorMessage({
      message: "private upstream response",
      responseBody: JSON.stringify({
        error: { code: "upstream_refused", resetAt: 123, secret: "private" },
      }),
    }),
    "upstream_refused"
  )
  assert.equal(errorToMessage(new Error("ordinary failure")), "ordinary failure")
  assert.equal(
    errorToMessage({
      message: "context window exceeded",
      responseBody: JSON.stringify({ error: { code: "invalid_request_error" } }),
    }),
    "context window exceeded"
  )
})
