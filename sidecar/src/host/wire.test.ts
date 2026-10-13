import test from "node:test"
import assert from "node:assert/strict"
import { parseHostMessage } from "./wire.ts"

test("wire rejects malformed frames before routing", () => {
  for (const value of [
    null,
    [],
    "send",
    {},
    { type: 1 },
    { type: "send", sessionId: 7 },
    { type: "control", params: [] },
    { type: "send", options: "fixture" },
    { type: "permission_response", interrupt: "yes" },
  ]) {
    assert.equal(parseHostMessage(value), null)
  }
})

test("wire preserves valid extensible payloads and sessionless service replies", () => {
  for (const frame of [
    {
      type: "send",
      sessionId: "s",
      prompt: [{ type: "text", text: "hello" }],
      options: { model: "fixture" },
    },
    { type: "host_rpc_result", requestId: "r", result: { values: [1, 2] } },
    { type: "feature_call", requestId: "f", messages: [], options: {} },
  ])
    assert.equal(parseHostMessage(frame), frame)
})

test("wire reads the Rust host's null optionals as absent", () => {
  // Byte-for-byte what `crates/cognia-sidecar/src/commands.rs` writes for a
  // control without params and a permission answer without a message.
  const control = parseHostMessage({
    type: "control",
    sessionId: "s",
    requestId: "r",
    method: "runtimeStatus",
    params: null,
  })
  assert.deepEqual(control, {
    type: "control",
    sessionId: "s",
    requestId: "r",
    method: "runtimeStatus",
  })
  const permission = parseHostMessage({
    type: "permission_response",
    sessionId: "s",
    requestId: "r",
    decision: "allow",
    message: null,
    updatedInput: null,
    interrupt: null,
  })
  assert.deepEqual(permission, {
    type: "permission_response",
    sessionId: "s",
    requestId: "r",
    decision: "allow",
  })
  assert.deepEqual(
    parseHostMessage({
      type: "session_api",
      requestId: "r",
      method: "listSessions",
      params: null,
      sendOptions: null,
    }),
    { type: "session_api", requestId: "r", method: "listSessions" }
  )
  // A present field still has to be the right kind.
  assert.equal(parseHostMessage({ type: "control", params: "x" }), null)
})
