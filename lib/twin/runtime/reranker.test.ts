import { identityScorer, rerank, type RerankCandidate, type RerankerOptions } from "./reranker"

const c = (id: string, score: number, content = id): RerankCandidate => ({
  id,
  content,
  score,
})

describe("rerank — identity / empty cases", () => {
  it("returns [] for empty input", async () => {
    const result = await rerank("q", [], { model: "identity", topK: 3 })
    expect(result.candidates).toEqual([])
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toBe("empty-input")
  })

  it("returns [] for topK=0", async () => {
    const result = await rerank("q", [c("a", 0.5)], { model: "identity", topK: 0 })
    expect(result.candidates).toEqual([])
    expect(result.fallbackReason).toBe("empty-input")
  })

  it("identity model returns the original order, truncated to topK", async () => {
    const candidates = [c("a", 0.9), c("b", 0.5), c("c", 0.7)]
    const result = await rerank("q", candidates, { model: "identity", topK: 2 })
    expect(result.reranked).toBe(false)
    expect(result.candidates.map((x) => x.id)).toEqual(["a", "b"])
  })

  it("falls back to identity when no scorer is provided", async () => {
    const candidates = [c("a", 0.5), c("b", 0.9)]
    const result = await rerank("q", candidates, {
      model: "bge-reranker-v2",
      topK: 2,
    })
    expect(result.reranked).toBe(false)
    expect(result.candidates.map((x) => x.id)).toEqual(["a", "b"])
  })
})

describe("rerank — custom scorer", () => {
  it("reorders candidates by the scorer's output desc", async () => {
    const scorer = (_q: string, cand: RerankCandidate) =>
      cand.id === "z" ? 100 : cand.id === "y" ? 50 : 0
    const candidates = [c("x", 0.9), c("y", 0.5), c("z", 0.1)]
    const opts: RerankerOptions = {
      model: "cohere-rerank-3",
      topK: 3,
      scorer,
    }
    const result = await rerank("q", candidates, opts)
    expect(result.reranked).toBe(true)
    expect(result.candidates.map((x) => x.id)).toEqual(["z", "y", "x"])
    expect(result.candidates[0].score).toBe(100)
  })

  it("truncates to topK after reranking", async () => {
    const scorer = (_q: string, cand: RerankCandidate) => Number(cand.content)
    const candidates = [c("a", 0.1, "1"), c("b", 0.1, "10"), c("c", 0.1, "5")]
    const result = await rerank("q", candidates, {
      model: "bge-reranker-v2",
      topK: 2,
      scorer,
    })
    expect(result.candidates.map((x) => x.id)).toEqual(["b", "c"])
  })

  it("falls back to identity when the scorer throws", async () => {
    const scorer = () => {
      throw new Error("upstream offline")
    }
    const candidates = [c("a", 0.9), c("b", 0.5)]
    const result = await rerank("q", candidates, {
      model: "bge-reranker-v2",
      topK: 2,
      scorer,
    })
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toContain("upstream offline")
    expect(result.candidates.map((x) => x.id)).toEqual(["a", "b"])
  })

  it("falls back when the scorer returns a non-finite number", async () => {
    const result = await rerank("q", [c("a", 0.9)], {
      model: "bge-reranker-v2",
      topK: 1,
      scorer: () => Number.NaN,
    })
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toContain("non-finite")
  })

  it("treats identityScorer as a no-op transformation but flags as reranked", async () => {
    const candidates = [c("a", 0.4), c("b", 0.9)]
    const result = await rerank("q", candidates, {
      model: "bge-reranker-v2",
      topK: 2,
      scorer: identityScorer,
    })
    expect(result.reranked).toBe(true)
    expect(result.candidates.map((x) => x.id)).toEqual(["b", "a"])
  })
})

describe("rerank — timeout guard", () => {
  it("falls back when the scorer exceeds the timeout budget", async () => {
    const scorer = () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 200))
    const result = await rerank("q", [c("a", 0.5)], {
      model: "bge-reranker-v2",
      topK: 1,
      scorer,
      timeoutMs: 10,
    })
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toContain("timeout")
  })
})
