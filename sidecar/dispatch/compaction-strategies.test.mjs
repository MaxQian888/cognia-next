import { test } from "node:test"
import assert from "node:assert/strict"

import { planStrategy, MIN_TAIL } from "./compaction-strategies.mjs"

function convo(n, { withSystem = true } = {}) {
  const out = withSystem ? [{ role: "system", content: "sys" }] : []
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })
  }
  return out
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
  assert.equal(plan.chunks[0].length, 5)
  assert.equal(plan.chunks[2].length, 1)
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
