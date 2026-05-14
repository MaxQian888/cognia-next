/**
 * Coverage for the StyleAgent heuristic prefilter (M3). Validates the
 * MMR + source-balancing behaviour without hitting an LLM.
 */

import { selectStyleCandidates, __TESTING__ } from "./style-prefilter"
import type { TwinChunk } from "@/types/twin"

let counter = 0
function makeChunk(opts: { text: string; sourceId?: string; tokens?: number }): TwinChunk {
  counter += 1
  return {
    id: `c${counter}`,
    twinId: "twin_a",
    sourceId: opts.sourceId ?? "src_default",
    content: opts.text,
    contentRedacted: opts.text,
    charStart: 0,
    charEnd: opts.text.length,
    vectorBackend: "qdrant",
    vectorCollection: "c",
    vectorDocId: `vec${counter}`,
    strategy: "paragraph",
    tokenCount: opts.tokens ?? Math.max(30, Math.ceil(opts.text.length / 4)),
    metadata: {},
    createdAt: Date.now(),
  }
}

beforeEach(() => {
  counter = 0
})

describe("selectStyleCandidates", () => {
  it("returns all chunks when the pool is already at or below target", () => {
    const chunks = [
      makeChunk({ text: "lorem ipsum dolor sit amet consectetur" }),
      makeChunk({ text: "the quick brown fox jumps over the lazy dog" }),
    ]
    expect(selectStyleCandidates(chunks, { target: 5 })).toHaveLength(2)
  })

  it("drops chunks below the min-tokens floor", () => {
    const chunks = [
      makeChunk({ text: "tiny", tokens: 5 }),
      makeChunk({ text: "tiny two", tokens: 8 }),
      makeChunk({ text: "x".repeat(200), tokens: 60 }),
      makeChunk({ text: "y".repeat(200), tokens: 70 }),
      makeChunk({ text: "z".repeat(200), tokens: 80 }),
      makeChunk({ text: "w".repeat(200), tokens: 50 }),
    ]
    const selected = selectStyleCandidates(chunks, { target: 3, minTokens: 30 })
    expect(selected).toHaveLength(3)
    for (const c of selected) {
      expect(c.tokenCount).toBeGreaterThanOrEqual(30)
    }
  })

  it("prefers diverse chunks across distinct sources", () => {
    // Build a pool where 8 chunks share one source and 3 chunks each have
    // their own — MMR + source-balancing should pull representatives
    // from every distinct source before doubling up on src_a.
    const chunks: TwinChunk[] = []
    for (let i = 0; i < 8; i++) {
      chunks.push(
        makeChunk({
          text: `Onboarding ticket triage step ${i} action ${i} runbook procedure detail`,
          sourceId: "src_a",
          tokens: 100,
        })
      )
    }
    chunks.push(
      makeChunk({
        text: "Postmortem write-up incident architecture decisions blameless analysis",
        sourceId: "src_b",
        tokens: 100,
      })
    )
    chunks.push(
      makeChunk({
        text: "Customer email refund policy diplomatic decline goodwill follow-up",
        sourceId: "src_c",
        tokens: 100,
      })
    )
    chunks.push(
      makeChunk({
        text: "PR description rollout flag scope risks rollback plan",
        sourceId: "src_d",
        tokens: 100,
      })
    )
    const selected = selectStyleCandidates(chunks, { target: 4 })
    const sources = new Set(selected.map((c) => c.sourceId))
    expect(sources.size).toBeGreaterThanOrEqual(3)
  })

  it("MMR penalises duplicate content even within one source", () => {
    const chunks: TwinChunk[] = []
    for (let i = 0; i < 6; i++) {
      chunks.push(
        makeChunk({
          text: "incident triage runbook ack acknowledge escalate page oncall procedure",
          sourceId: "src_dup",
          tokens: 100,
        })
      )
    }
    chunks.push(
      makeChunk({
        text: "customer escalation diplomatic tone resolution credit",
        sourceId: "src_dup",
        tokens: 100,
      })
    )
    // With lambda=0.7 the diverse chunk should still come out on top.
    const selected = selectStyleCandidates(chunks, { target: 2 })
    const texts = selected.map((c) => c.contentRedacted)
    // The two picks should be distinct documents (not the same duplicated text).
    expect(new Set(texts).size).toBe(2)
  })

  it("tokenizer strips stopwords and short tokens", () => {
    expect(__TESTING__.tokenize("The quick brown fox.")).toEqual(["quick", "brown", "fox"])
    expect(__TESTING__.tokenize("我 在 学习 数字 孪生")).toEqual(["学习", "数字", "孪生"])
  })

  it("jaccard is symmetric and bounded", () => {
    const a = new Set(["x", "y", "z"])
    const b = new Set(["y", "z", "w"])
    expect(__TESTING__.jaccard(a, b)).toBeCloseTo(2 / 4)
    expect(__TESTING__.jaccard(b, a)).toBeCloseTo(2 / 4)
    expect(__TESTING__.jaccard(a, new Set())).toBe(0)
  })
})
