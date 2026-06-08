import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AUTO_COMPACT_FRACTION,
  estimateTokens,
  getContextWindow,
  shouldCompact,
  planCompaction,
  applyCompaction,
} from "./compaction.mjs"

test("AUTO_COMPACT_FRACTION mirrors the renderer constant", () => {
  assert.equal(AUTO_COMPACT_FRACTION, 0.835)
})

test("getContextWindow matches families, falls back to a safe default", () => {
  assert.equal(getContextWindow("claude-sonnet-4-6"), 1_000_000)
  assert.equal(getContextWindow("gpt-4o"), 128_000)
  assert.equal(getContextWindow("deepseek-chat"), 64_000)
  assert.equal(getContextWindow(undefined), 128_000)
  assert.equal(getContextWindow("some-unknown-local-model"), 128_000)
})

test("estimateTokens counts string and block content via the char heuristic", () => {
  const msgs = [
    { role: "system", content: "a".repeat(40) }, // 10 tokens
    { role: "user", content: [{ type: "text", text: "b".repeat(40) }] }, // 10 tokens
  ]
  assert.equal(estimateTokens(msgs), 20)
})

test("shouldCompact fires only at/above the threshold", () => {
  // 128k window → threshold ≈ 106_880 tokens.
  assert.equal(shouldCompact({ lastInputTokens: 50_000, modelId: "gpt-4o" }), false)
  assert.equal(shouldCompact({ lastInputTokens: 110_000, modelId: "gpt-4o" }), true)
  // No signal yet (0 / null) never compacts.
  assert.equal(shouldCompact({ lastInputTokens: 0, modelId: "gpt-4o" }), false)
  assert.equal(shouldCompact({ lastInputTokens: null, modelId: "gpt-4o" }), false)
})

const convo = () => [
  { role: "system", content: "sys" },
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "u2" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "u3" },
  { role: "assistant", content: "a3" },
]

test("planCompaction splits head / middle / tail keeping system + recent turns", () => {
  const plan = planCompaction({ conversation: convo(), keepRecentMessages: 2 })
  assert.ok(plan)
  assert.deepEqual(
    plan.head.map((m) => m.content),
    ["sys"]
  )
  // middle = everything between system and the last 2 messages
  assert.deepEqual(
    plan.middle.map((m) => m.content),
    ["u1", "a1", "u2", "a2"]
  )
  assert.deepEqual(
    plan.tail.map((m) => m.content),
    ["u3", "a3"]
  )
})

test("planCompaction returns null when there is nothing old enough to summarize", () => {
  const short = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ]
  assert.equal(planCompaction({ conversation: short, keepRecentMessages: 2 }), null)
})

test("applyCompaction rebuilds head + summary + tail", () => {
  const next = applyCompaction({ conversation: convo(), keepRecentMessages: 2, summary: "SUMMARY" })
  assert.equal(next[0].content, "sys")
  assert.equal(next[1].role, "user")
  assert.match(next[1].content, /SUMMARY/)
  assert.deepEqual(
    next.slice(2).map((m) => m.content),
    ["u3", "a3"]
  )
})

test("applyCompaction is a no-op shape when plan is empty", () => {
  const short = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ]
  const next = applyCompaction({ conversation: short, keepRecentMessages: 2, summary: "S" })
  assert.deepEqual(next, short)
})
