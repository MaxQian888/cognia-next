import { test } from "node:test"
import assert from "node:assert/strict"

import type { ConversationMessage } from "./compaction.ts"
import { planStrategy, MIN_TAIL } from "./strategies.ts"
import type { StrategyPlan } from "./strategies.ts"

function convo(n: number, { withSystem = true } = {}): ConversationMessage[] {
  const out: ConversationMessage[] = withSystem ? [{ role: "system", content: "sys" }] : []
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })
  }
  return out
}

/** The verbatim tail of a plan that has one. */
function tailOf(plan: StrategyPlan): ConversationMessage[] {
  assert.ok("tail" in plan, `a ${plan.kind} plan has no tail`)
  return plan.tail
}

test("returns none when nothing is old enough", () => {
  const plan = planStrategy({ strategy: "summary", conversation: convo(2), keepRecent: 6 })
  assert.equal(plan.kind, "none")
})

test("summary / hybrid produce a single-summary plan over the middle", () => {
  const conversation = convo(10)
  const plan = planStrategy({ strategy: "summary", conversation, keepRecent: 2 })
  assert.equal(plan.kind, "single")
  assert.deepEqual(
    plan.systemHead.map((m) => m.content),
    ["sys"]
  )
  assert.equal(plan.tail.length, 2)
  // middle = everything between system head and the last 2.
  assert.equal(plan.middle.length, 8)

  const hybrid = planStrategy({ strategy: "hybrid", conversation, keepRecent: 2 })
  assert.equal(hybrid.kind, "single")
})

test("sliding-window rebuilds without an LLM call", () => {
  const conversation = convo(10)
  const plan = planStrategy({ strategy: "sliding-window", conversation, keepRecent: 3 })
  assert.equal(plan.kind, "rebuild")
  // system + last 3 only (no summary).
  assert.deepEqual(
    plan.rebuilt.map((m) => m.content),
    ["sys", "m7", "m8", "m9"]
  )
})

test("selective keeps important messages and summarizes the rest", () => {
  const conversation = [
    { role: "system", content: "sys" },
    { role: "user", content: "we decided to use Postgres" }, // decision → important
    { role: "assistant", content: "ok" }, // chatter → summarized
    { role: "user", content: "fix lib/x.ts" }, // artifact → important
    { role: "assistant", content: "hmm" }, // chatter → summarized
    { role: "user", content: "recent-1" },
    { role: "assistant", content: "recent-2" },
  ]
  const plan = planStrategy({
    strategy: "selective",
    conversation,
    keepRecent: 2,
    importanceThreshold: 0.4,
  })
  assert.equal(plan.kind, "selective")
  const keptText = plan.keep.map((m) => m.content)
  assert.ok(keptText.includes("we decided to use Postgres"))
  assert.ok(keptText.includes("fix lib/x.ts"))
  assert.ok(plan.summarizeSet.length >= 1)
  assert.deepEqual(
    plan.tail.map((m) => m.content),
    ["recent-1", "recent-2"]
  )
})

test("recursive chunks the middle by recursiveChunkSize", () => {
  const conversation = convo(13) // middle of 11 with keepRecent 2
  const plan = planStrategy({
    strategy: "recursive",
    conversation,
    keepRecent: 2,
    recursiveChunkSize: 5,
  })
  assert.equal(plan.kind, "chunked")
  assert.equal(plan.chunks.length, 3) // 11 → 5 + 5 + 1
  assert.equal(plan.chunks[0]?.length, 5)
  assert.equal(plan.chunks[2]?.length, 1)
})

test("drain-line evicts oldest tail into the summarize set when retained is over budget", () => {
  // Build a conversation whose tail alone blows the retained budget so the
  // drain-line must evict down toward MIN_TAIL.
  const huge = "x".repeat(4000) // ~1000 tokens each
  const conversation = [
    { role: "system", content: "sys" },
    { role: "user", content: "m-old-1" },
    { role: "assistant", content: "m-old-2" },
    { role: "user", content: huge },
    { role: "assistant", content: huge },
    { role: "user", content: huge },
    { role: "assistant", content: huge },
  ]
  // keepRecent 4 would keep all four huge messages; a tiny retained budget on a
  // 128k window forces eviction down to MIN_TAIL.
  const plan = planStrategy({
    strategy: "summary",
    conversation,
    keepRecent: 4,
    retainedFraction: 0.01, // 1% of 128k = 1280 tokens
    modelId: "gpt-4o",
  })
  assert.equal(plan.kind, "single")
  assert.equal(plan.tail.length, MIN_TAIL)
  // Evicted huge messages moved into the summarize set.
  assert.ok(plan.middle.length > 2)
})

test("preserveSystemMessages keeps interleaved system messages out of the summary", () => {
  const conversation = [
    { role: "system", content: "sys" },
    { role: "user", content: "m0" },
    { role: "system", content: "mid-system" },
    { role: "assistant", content: "m1" },
    { role: "user", content: "m2" },
    { role: "assistant", content: "recent-1" },
    { role: "user", content: "recent-2" },
  ]
  const plan = planStrategy({
    strategy: "summary",
    conversation,
    keepRecent: 2,
    preserveSystemMessages: true,
  })
  assert.equal(plan.kind, "single")
  assert.ok(plan.keep.some((m) => m.content === "mid-system"))
  assert.ok(!plan.middle.some((m) => m.content === "mid-system"))
})

test("drain-line prefers the caller's authoritative contextWindow", () => {
  const mk = (i: number) => ({ role: i % 2 ? "assistant" : "user", content: "m".repeat(4000) })
  const conversation = Array.from({ length: 20 }, (_, i) => mk(i))
  // With a huge window the budget is never exceeded → tail stays full-length.
  const wide = planStrategy({
    strategy: "summary",
    conversation,
    keepRecent: 8,
    retainedFraction: 0.5,
    contextWindow: 10_000_000,
    modelId: "totally-unknown-model",
  })
  // Without it, the unknown model falls back to the 128k regex default and the
  // same fraction still fits here — so instead prove the small-window case
  // drains: an explicit tiny window must evict tail messages into the middle.
  const tight = planStrategy({
    strategy: "summary",
    conversation,
    keepRecent: 8,
    retainedFraction: 0.5,
    contextWindow: 4_000,
    modelId: "totally-unknown-model",
  })
  assert.equal(tailOf(wide).length, 8)
  assert.ok(tailOf(tight).length < 8)
  assert.ok(tailOf(tight).length >= MIN_TAIL)
})

test("hybrid engages the drain-line by default (distinct from summary)", () => {
  const mk = (i: number) => ({ role: i % 2 ? "assistant" : "user", content: "m".repeat(400_000) })
  const conversation = Array.from({ length: 20 }, (_, i) => mk(i))
  const summary = planStrategy({
    strategy: "summary",
    conversation,
    keepRecent: 8,
    contextWindow: 128_000,
  })
  const hybrid = planStrategy({
    strategy: "hybrid",
    conversation,
    keepRecent: 8,
    contextWindow: 128_000,
  })
  // summary (no retainedFraction) keeps the full tail; hybrid drains to MIN_TAIL.
  assert.equal(tailOf(summary).length, 8)
  assert.equal(tailOf(hybrid).length, MIN_TAIL)
})

test("optical produces an optical plan carrying the middle (fallback-compatible)", () => {
  const conversation = convo(10)
  const plan = planStrategy({ strategy: "optical", conversation, keepRecent: 2 })
  assert.equal(plan.kind, "optical")
  // Same shape as "single" so the orchestrator can summarize this middle as text
  // if the optical render or round-trip check fails.
  assert.equal(plan.middle.length, 8)
  assert.equal(plan.tail.length, 2)
  assert.deepEqual(
    plan.systemHead.map((m) => m.content),
    ["sys"]
  )
})

// ── tool call ↔ result pairs ───────────────────────────────────────────────

const toolCall = (id: string, input: unknown = {}) => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input }],
})
const toolResult = (id: string, value = "ok") => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value } },
  ],
})

/** The resume check's rule: each result follows its call; no call is left open. */
function assertPaired(messages: readonly ConversationMessage[]) {
  const open = new Set<string>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const part of m.content as { type?: string; toolCallId?: string }[]) {
      if (part.type === "tool-call") open.add(part.toolCallId!)
      if (part.type === "tool-result")
        assert.ok(open.delete(part.toolCallId!), `orphan result ${part.toolCallId}`)
    }
  }
  assert.deepEqual([...open], [], "unanswered calls")
}

test("drain-line carries a call's results along when it evicts the call", () => {
  const huge = "x".repeat(4000)
  const conversation = [
    { role: "system", content: "sys" },
    { role: "user", content: "old" },
    { role: "assistant", content: "old reply" },
    toolCall("big", { command: huge }),
    toolResult("big", huge),
    { role: "user", content: huge },
    { role: "assistant", content: "done" },
  ]
  const plan = planStrategy({
    strategy: "summary",
    conversation,
    keepRecent: 4,
    retainedFraction: 0.01,
    modelId: "gpt-4o",
  })
  assert.equal(plan.kind, "single")
  assertPaired(plan.tail)
  assertPaired(plan.middle)
  assert.notEqual(plan.tail[0]?.role, "tool")
})

test("selective keeps or summarizes a tool call together with its result", () => {
  const conversation = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    toolCall("a", { command: "ls" }),
    toolResult("a", "edited lib/x.ts"),
    { role: "assistant", content: "hmm" },
    toolCall("b"),
    toolResult("b"),
    { role: "user", content: "recent-1" },
    { role: "assistant", content: "recent-2" },
  ]
  // Score exactly one half of each pair as important — the default scorer rates
  // every tool message alike, so only a custom scorer or threshold splits them.
  const important = new Set<unknown>([conversation[3], conversation[5]])
  const plan = planStrategy({
    strategy: "selective",
    conversation,
    keepRecent: 2,
    importanceThreshold: 0.5,
    scoreMessage: (m) => ({ score: important.has(m) ? 1 : 0, signals: [] }),
  })
  assert.equal(plan.kind, "selective")
  assertPaired(plan.keep)
  assertPaired(plan.summarizeSet)
  assert.deepEqual(plan.keep, [conversation[2], conversation[3], conversation[5], conversation[6]])
  assert.deepEqual(plan.summarizeSet, [conversation[1], conversation[4]])
})

test("every strategy's retained messages stay pair-safe on a tool-heavy history", () => {
  const conversation: ConversationMessage[] = [{ role: "system", content: "sys" }]
  for (let i = 0; i < 12; i++) {
    conversation.push(
      { role: "user", content: `step ${i}` },
      toolCall(`c${i}`),
      toolResult(`c${i}`)
    )
  }
  for (const strategy of [
    "summary",
    "hybrid",
    "sliding-window",
    "selective",
    "recursive",
    "optical",
  ]) {
    for (let keepRecent = 1; keepRecent <= 8; keepRecent++) {
      const plan = planStrategy({ strategy, conversation, keepRecent, retainedFraction: 0.5 })
      const retained =
        plan.kind === "none"
          ? conversation
          : plan.kind === "rebuild"
            ? plan.rebuilt
            : [...plan.systemHead, ...plan.frozen, ...plan.keep, ...plan.tail]
      assertPaired(retained)
    }
  }
})
