import { test } from "node:test"
import assert from "node:assert/strict"

import { capToolResults } from "./tool-result-cap.mjs"

const big = "x".repeat(4000) // 4000 chars ≈ 1000 tokens

test("no-op when maxToolResultTokens is unset or non-positive", () => {
  const convo = [{ role: "tool", content: big }]
  assert.equal(capToolResults(convo, {}), convo)
  assert.equal(capToolResults(convo, { maxToolResultTokens: 0 }), convo)
})

test("caps an oversized role:tool string body and adds the metadata header", () => {
  const convo = [{ role: "tool", name: "bash", content: big }]
  const out = capToolResults(convo, { maxToolResultTokens: 100, preserveToolCallMetadata: true })
  assert.notEqual(out[0], convo[0]) // new object
  assert.ok(out[0].content.length < big.length)
  assert.match(out[0].content, /tool result truncated/)
  assert.match(out[0].content, /\[tool: bash \| status: ok\]/)
})

test("omits the header when preserveToolCallMetadata is false", () => {
  const convo = [{ role: "tool", name: "bash", content: big }]
  const out = capToolResults(convo, { maxToolResultTokens: 100, preserveToolCallMetadata: false })
  assert.doesNotMatch(out[0].content, /\[tool:/)
  assert.match(out[0].content, /tool result truncated/)
})

test("leaves an under-limit tool result untouched (same ref)", () => {
  const convo = [{ role: "tool", name: "grep", content: "small" }]
  const out = capToolResults(convo, { maxToolResultTokens: 100 })
  assert.equal(out[0], convo[0])
})

test("caps a tool-result block part's string body", () => {
  const convo = [
    {
      role: "assistant",
      content: [{ type: "tool-result", toolName: "read", output: big, isError: true }],
    },
  ]
  const out = capToolResults(convo, { maxToolResultTokens: 100, preserveToolCallMetadata: true })
  assert.ok(out[0].content[0].output.length < big.length)
  assert.match(out[0].content[0].output, /\[tool: read \| status: error\]/)
})

test("never touches non-tool messages", () => {
  const convo = [
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "system", content: big },
  ]
  const out = capToolResults(convo, { maxToolResultTokens: 100 })
  assert.equal(out[0], convo[0])
  assert.equal(out[1], convo[1])
  assert.equal(out[2], convo[2])
})
