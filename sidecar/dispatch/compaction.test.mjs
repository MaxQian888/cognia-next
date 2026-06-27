import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AUTO_COMPACT_FRACTION,
  estimateTokens,
  getContextWindow,
  shouldCompact,
  planCompaction,
  applyCompaction,
  applyCompactionIncremental,
  applyCompactionRegenerated,
  isSummaryMessage,
  summaryVersion,
  makeSummaryMessage,
} from "./compaction.mjs"

test("AUTO_COMPACT_FRACTION mirrors the renderer constant", () => {
  assert.equal(AUTO_COMPACT_FRACTION, 0.835)
})

test("getContextWindow matches families, falls back to a safe default", () => {
  assert.equal(getContextWindow("claude-sonnet-4-6"), 1_000_000)
  assert.equal(getContextWindow("gpt-4o"), 128_000)
  assert.equal(getContextWindow("deepseek-chat"), 128_000)
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

test("shouldCompact prefers an authoritative contextWindow over the regex table", () => {
  // deepseek-v4 is really 1M, but the regex table floors `deepseek*` at 128k.
  // Without the override it would compact at ~107k; with the real 1M window the
  // same prompt is only ~11% full and must NOT trigger.
  assert.equal(
    shouldCompact({ lastInputTokens: 110_000, modelId: "deepseek-v4-pro" }),
    true,
    "regex-table fallback floors deepseek at 128k → fires early"
  )
  assert.equal(
    shouldCompact({
      lastInputTokens: 110_000,
      modelId: "deepseek-v4-pro",
      contextWindow: 1_000_000,
    }),
    false,
    "authoritative 1M window → 110k is far below threshold"
  )
  // It still fires once the prompt crosses the 1M threshold (≈835k).
  assert.equal(
    shouldCompact({
      lastInputTokens: 900_000,
      modelId: "deepseek-v4-pro",
      contextWindow: 1_000_000,
    }),
    true
  )
  // A non-positive / non-numeric override is ignored (falls back to the table).
  assert.equal(
    shouldCompact({ lastInputTokens: 110_000, modelId: "gpt-4o", contextWindow: 0 }),
    true
  )
})

test("shouldCompact honours a custom fraction (settings override)", () => {
  // 128k window, fraction 0.5 → threshold 64_000.
  assert.equal(shouldCompact({ lastInputTokens: 50_000, modelId: "gpt-4o", fraction: 0.5 }), false)
  assert.equal(shouldCompact({ lastInputTokens: 70_000, modelId: "gpt-4o", fraction: 0.5 }), true)
})

test("shouldCompact supports the message-count trigger", () => {
  assert.equal(
    shouldCompact({ trigger: "message-count", messageCount: 30, messageCountThreshold: 50 }),
    false
  )
  assert.equal(
    shouldCompact({ trigger: "message-count", messageCount: 50, messageCountThreshold: 50 }),
    true
  )
  // Token signal is ignored under the message-count trigger.
  assert.equal(
    shouldCompact({
      trigger: "message-count",
      lastInputTokens: 9_000_000,
      messageCount: 1,
      messageCountThreshold: 50,
    }),
    false
  )
})

test("shouldCompact never auto-fires under the manual trigger", () => {
  assert.equal(
    shouldCompact({ trigger: "manual", lastInputTokens: 9_000_000, modelId: "gpt-4o" }),
    false
  )
})

test("frozen-summary markers round-trip", () => {
  const msg = makeSummaryMessage("KEY FACTS", 3)
  assert.equal(msg.role, "user")
  assert.ok(isSummaryMessage(msg))
  assert.equal(summaryVersion(msg), 3)
  assert.match(msg.content, /KEY FACTS/)
  // Non-summary messages
  assert.equal(isSummaryMessage({ role: "user", content: "hello" }), false)
  assert.equal(
    isSummaryMessage({ role: "assistant", content: '<conversation-summary v="1">x' }),
    false
  )
  assert.equal(summaryVersion({ role: "user", content: "plain" }), 0)
  // version defaults to 1 when not positive
  assert.equal(summaryVersion(makeSummaryMessage("x", 0)), 1)
})

test("planCompaction protects leading system + frozen summaries from re-summarization", () => {
  const conversation = [
    { role: "system", content: "sys" },
    makeSummaryMessage("PRIOR SUMMARY", 1),
    { role: "user", content: "u-new-1" },
    { role: "assistant", content: "a-new-1" },
    { role: "user", content: "u-recent" },
    { role: "assistant", content: "a-recent" },
  ]
  const plan = planCompaction({ conversation, keepRecentMessages: 2 })
  assert.ok(plan)
  assert.deepEqual(
    plan.systemHead.map((m) => m.content),
    ["sys"]
  )
  assert.equal(plan.frozen.length, 1)
  assert.ok(isSummaryMessage(plan.frozen[0]))
  // The prior summary is NOT in middle (this is the anti-recursion guarantee).
  assert.deepEqual(
    plan.middle.map((m) => m.content),
    ["u-new-1", "a-new-1"]
  )
  assert.deepEqual(
    plan.tail.map((m) => m.content),
    ["u-recent", "a-recent"]
  )
})

test("applyCompactionIncremental keeps prior frozen byte-identical and appends a new version", () => {
  const prior = makeSummaryMessage("PRIOR", 1)
  const conversation = [
    { role: "system", content: "sys" },
    prior,
    { role: "user", content: "u-new" },
    { role: "assistant", content: "a-new" },
    { role: "user", content: "u-recent" },
    { role: "assistant", content: "a-recent" },
  ]
  const next = applyCompactionIncremental({
    conversation,
    keepRecentMessages: 2,
    summary: "NEW SUMMARY",
    nextVersion: 2,
  })
  assert.equal(next[0].content, "sys")
  // Prior frozen summary survives unchanged (prefix-cache stability).
  assert.equal(next[1], prior)
  assert.equal(summaryVersion(next[1]), 1)
  assert.equal(summaryVersion(next[2]), 2)
  assert.match(next[2].content, /NEW SUMMARY/)
  assert.deepEqual(
    next.slice(3).map((m) => m.content),
    ["u-recent", "a-recent"]
  )
})

test("applyCompactionRegenerated collapses all summaries into one", () => {
  const conversation = [
    { role: "system", content: "sys" },
    makeSummaryMessage("S1", 1),
    makeSummaryMessage("S2", 2),
    { role: "user", content: "u-new" },
    { role: "assistant", content: "a-new" },
    { role: "user", content: "u-recent" },
    { role: "assistant", content: "a-recent" },
  ]
  const next = applyCompactionRegenerated({
    conversation,
    keepRecentMessages: 2,
    summary: "MERGED",
    version: 3,
  })
  assert.equal(next[0].content, "sys")
  // Only ONE summary remains.
  assert.ok(isSummaryMessage(next[1]))
  assert.equal(summaryVersion(next[1]), 3)
  assert.equal(isSummaryMessage(next[2]), false)
  assert.deepEqual(next.slice(1).filter(isSummaryMessage).length, 1)
  assert.deepEqual(
    next.slice(2).map((m) => m.content),
    ["u-recent", "a-recent"]
  )
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
