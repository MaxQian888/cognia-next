import type { EvalCase, EvalSample } from "@/types/eval/eval"
import { assertionScorer } from "./assertion"

function sample(output: string): EvalSample {
  return {
    output,
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    stepCount: 0,
    degraded: false,
  }
}

function makeCase(expectedContains?: string[]): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input: "x",
    capability: "chat.response",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...(expectedContains ? { reference: { expectedContains } } : {}),
  }
}

describe("assertionScorer", () => {
  it("errors when no expectedContains reference exists", async () => {
    const score = await assertionScorer.score(sample("hello world"), makeCase())
    expect(score.error).toBeDefined()
    expect(score.passed).toBe(false)
  })

  it("passes when every expected substring is present (case-insensitive)", async () => {
    const score = await assertionScorer.score(
      sample("The Answer is 42 degrees"),
      makeCase(["answer", "42"])
    )
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("scores the fraction present when some substrings are missing", async () => {
    const score = await assertionScorer.score(
      sample("only this one"),
      makeCase(["this", "missing", "alsogone", "one"])
    )
    expect(score.value).toBe(0.5)
    expect(score.passed).toBe(false)
    expect(score.metadata?.missing).toEqual(["missing", "alsogone"])
  })
})
