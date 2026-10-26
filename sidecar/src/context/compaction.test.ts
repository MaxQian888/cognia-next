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
  isOpticalMessage,
  summaryVersion,
  makeSummaryMessage,
  makeOpticalMessage,
  type ConversationMessage,
} from "./compaction.ts"

test("token-tail selection retains short recent exchanges and keeps tool pairs whole", () => {
  const conversation: ConversationMessage[] = [
    { role: "user", content: "original task" },
    { role: "assistant", content: "old material ".repeat(1000) },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: "assistant" as const,
      content: `recent ${i}`,
    })),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "r", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "r", output: { type: "text", value: "last finding" } },
      ],
    },
  ]
  const plan = planCompaction({ conversation, keepRecentTokens: 100 })!
  assert.ok(plan.middle.length > 0)
  assert.ok(plan.tail.length > 6)
  assert.match(JSON.stringify(plan.tail), /recent 0/)
  assert.match(JSON.stringify(plan.tail), /tool-call/)
  assert.match(JSON.stringify(plan.tail), /last finding/)
})

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
  assert.match(String(msg.content), /KEY FACTS/)
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

test("optical archives are recognized and protected as frozen artifacts", () => {
  const imageParts = [
    { type: "image" as const, image: "data:image/png;base64,AAAA", mediaType: "image/png" },
  ]
  const archive = makeOpticalMessage(imageParts, { messageCount: 4, frameCount: 1 }, 2)
  assert.ok(isSummaryMessage(archive), "array-content optical archive is a frozen artifact")
  assert.ok(isOpticalMessage(archive), "and detectable as optical (image-bearing)")
  assert.equal(summaryVersion(archive), 2)
  assert.equal(isOpticalMessage(makeSummaryMessage("text only", 1)), false)

  // A prior optical archive right after the system head is carried forward in
  // `frozen`, never fed back into `middle` (where its image would yield no text).
  const conversation = [
    { role: "system", content: "sys" },
    archive,
    { role: "user", content: "u-new" },
    { role: "assistant", content: "a-new" },
    { role: "user", content: "u-recent" },
    { role: "assistant", content: "a-recent" },
  ]
  const plan = planCompaction({ conversation, keepRecentMessages: 2 })
  assert.ok(plan)
  assert.equal(plan.frozen.length, 1)
  assert.ok(isOpticalMessage(plan.frozen[0]))
  assert.deepEqual(
    plan.middle.map((m) => m.content),
    ["u-new", "a-new"]
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
  assert.equal(next[0]?.content, "sys")
  // Prior frozen summary survives unchanged (prefix-cache stability).
  assert.equal(next[1], prior)
  assert.equal(summaryVersion(next[1]), 1)
  assert.equal(summaryVersion(next[2]), 2)
  assert.match(String(next[2]?.content), /NEW SUMMARY/)
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
  assert.equal(next[0]?.content, "sys")
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
  assert.equal(next[0]?.content, "sys")
  assert.equal(next[1]?.role, "user")
  assert.match(String(next[1]?.content), /SUMMARY/)
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

test("planCompaction never starts the verbatim tail inside a tool call/result pair", () => {
  // The LR-P03 shape: the count-based cut (keep 6) lands on a tool result whose
  // call would be summarized, leaving an orphan the resume check rejects.
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "working_set", input: {} }],
  })
  const result = (id: string) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "working_set",
        output: { type: "json", value: {} },
      },
    ],
  })
  const conversation = [
    { role: "user", content: "start" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "get the working set" },
    call("ws-1"),
    result("ws-1"),
    { role: "assistant", content: "it has 3 entries" },
    { role: "user", content: "codename?" },
    { role: "assistant", content: "COPPER-HERON-8046" },
    { role: "user", content: "thanks" },
  ]
  const plan = planCompaction({ conversation, keepRecentMessages: 5 })
  assert.ok(plan)
  assert.equal(plan.tail[0], conversation[3], "the tail starts at the call, keeping its result")
  assert.equal(plan.tail.length, 6)
  assert.equal(plan.middle.length, 3)
})

test("planCompaction reports nothing to compact when the pair reaches the start", () => {
  const conversation = [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "x", toolName: "bash", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "x",
          toolName: "bash",
          output: { type: "text", value: "" },
        },
      ],
    },
    { role: "user", content: "next" },
  ]
  assert.equal(planCompaction({ conversation, keepRecentMessages: 2 }), null)
})
