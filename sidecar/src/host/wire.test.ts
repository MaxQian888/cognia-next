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
    { type: "send", options: null },
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
