import assert from "node:assert/strict"
import { test } from "node:test"
import { captureClaudeRuntime } from "../../../test-support/claude-runtime.ts"

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test("a steered query waits for both results and emits one terminal frame", async () => {
  const { session, events } = captureClaudeRuntime({}, ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const message of prompt)
        yield { type: "result", subtype: "success", session_id: message.session_id }
    },
    interrupt() {},
    close() {},
  }))
  session.pushUserMessage("steer", "now")
  await flush()
  assert.equal(events.filter((event) => event.type === "sdk_session_id").length, 1)
  assert.equal(events.filter((event) => event.type === "event").length, 2)
  assert.equal(events.filter((event) => event.type === "session_ended").length, 1)
  assert.equal(session._ended, true)
  assert.equal(session.pushUserMessage("closed"), false)
})

test("provider failure results retain HTTP status through the terminal boundary", async () => {
  const { events, session } = captureClaudeRuntime({}, () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result",
        subtype: "success",
        terminal_reason: "api_error",
        api_error_status: 404,
        result: "missing model",
      }
    },
    interrupt() {},
    close() {},
  }))
  await flush()
  const terminal = events.find((event) => event.type === "session_ended")!
  assert.equal(terminal.httpStatus, 404)
  assert.match(String(terminal.error), /HTTP 404.*missing model/)
  assert.equal(session._ended, true)
})

test("iterator errors settle the session once and retain the error message", async () => {
  const { events, session } = captureClaudeRuntime({}, () => ({
    async *[Symbol.asyncIterator]() {
      throw new Error("transport broke")
    },
    interrupt() {},
    close() {},
  }))
  await flush()
  assert.deepEqual(
    events.filter((event) => event.type === "session_ended"),
    [{ type: "session_ended", sessionId: "test-session", error: "transport broke" }]
  )
  assert.equal(session._ended, true)
  session.closeInput()
})
