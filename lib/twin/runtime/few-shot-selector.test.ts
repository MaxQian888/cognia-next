import { selectFewShotSamples } from "./few-shot-selector"
import type { StyleSample } from "@/types/twin"

function makeSample(id: string, summary: string): StyleSample {
  return {
    id,
    contextLabel: id,
    original: summary,
    summary,
    sourceChunkId: "c1",
    tone: [],
    addedAt: 1,
    addedBy: "distill",
  }
}

describe("selectFewShotSamples", () => {
  it("returns empty when no samples provided", () => {
    const result = selectFewShotSamples({
      queryEmbedding: [1, 0],
      samples: [],
    })
    expect(result).toEqual([])
  })

  it("uses cosine similarity when sampleEmbeddings is provided", () => {
    const samples = [makeSample("a", "alpha"), makeSample("b", "beta"), makeSample("c", "gamma")]
    const result = selectFewShotSamples({
      queryEmbedding: [1, 0, 0],
      samples,
      sampleEmbeddings: [
        [0, 1, 0], // orthogonal — score 0
        [1, 0, 0], // identical — score 1
        [0.5, 0.5, 0], // partial — score ~0.71
      ],
      topK: 2,
    })
    expect(result).toHaveLength(2)
    expect(result[0].sample.id).toBe("b")
    expect(result[1].sample.id).toBe("c")
    expect(result[0].score).toBeCloseTo(1)
  })

  it("ranks by query token-overlap when embeddings are absent but queryText is given", () => {
    const samples = [
      makeSample("offtopic", "quarterly revenue projections and budget"),
      makeSample("ontopic", "how to reset your password and login"),
    ]
    const result = selectFewShotSamples({
      queryEmbedding: [],
      samples,
      queryText: "I forgot my password, how do I login again?",
      topK: 1,
    })
    // The query overlaps the "ontopic" summary far more than "offtopic".
    expect(result[0].sample.id).toBe("ontopic")
    expect(result[0].score).toBeGreaterThan(0)
  })

  it("falls back to length heuristic when embeddings are absent", () => {
    const samples = [
      makeSample("short", "x"),
      makeSample("ideal", "x".repeat(50)), // should win — closest to 50
      makeSample("long", "x".repeat(200)),
    ]
    const result = selectFewShotSamples({
      queryEmbedding: [],
      samples,
      topK: 1,
    })
    expect(result[0].sample.id).toBe("ideal")
  })

  it("respects topK cap", () => {
    // Use 2D embeddings so cosine produces a non-trivial ordering. The
    // query is aligned with the first axis, so samples lean further
    // towards [1, 0] score higher.
    const samples = Array.from({ length: 10 }, (_, i) => makeSample(`s${i}`, `body ${i}`))
    const result = selectFewShotSamples({
      queryEmbedding: [1, 0],
      samples,
      sampleEmbeddings: samples.map((_, i) => [10 - i, i + 1]),
      topK: 4,
    })
    expect(result).toHaveLength(4)
    // s0 = [10, 1] is the most aligned with [1, 0].
    expect(result[0].sample.id).toBe("s0")
  })

  it("treats mismatched dimension as zero similarity", () => {
    const result = selectFewShotSamples({
      queryEmbedding: [1, 0, 0],
      samples: [makeSample("a", "alpha")],
      sampleEmbeddings: [[1, 0]], // wrong dim — falls through to score 0
      topK: 1,
    })
    expect(result[0].score).toBe(0)
  })

  it("treats zero-norm embeddings as zero similarity", () => {
    const result = selectFewShotSamples({
      queryEmbedding: [0, 0, 0],
      samples: [makeSample("a", "alpha")],
      sampleEmbeddings: [[1, 0, 0]],
      topK: 1,
    })
    expect(result[0].score).toBe(0)
  })

  it("ignores sampleEmbeddings when its length doesn't match samples", () => {
    const samples = [makeSample("a", "alpha"), makeSample("b", "beta")]
    const result = selectFewShotSamples({
      queryEmbedding: [1, 0, 0],
      samples,
      sampleEmbeddings: [[1, 0, 0]], // length mismatch — falls back to heuristic
      topK: 1,
    })
    // heuristic ranks by length; both are 5 chars — order is stable.
    expect(result).toHaveLength(1)
  })
})
