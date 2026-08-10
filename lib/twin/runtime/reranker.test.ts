import {
  createLlmRerankScorer,
  identityScorer,
  lexicalRerankScorer,
  rerank,
  type RerankCandidate,
  type RerankerOptions,
} from "./reranker"

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

describe("lexicalRerankScorer (T2.6)", () => {
  it("lifts a keyword-matching candidate above a slightly-higher-cosine one that misses the terms", async () => {
    // "high" has a marginally better cosine score but none of the query words;
    // "match" covers every query term verbatim. Scores:
    //   high  = 0.7*0.80 + 0.3*0.00 = 0.560
    //   match = 0.7*0.74 + 0.3*1.00 = 0.818  → wins
    const candidates = [
      c("high", 0.8, "an unrelated paragraph about gardening and the weather"),
      c("match", 0.74, "reset vpn password"),
    ]
    const result = await rerank("reset vpn password", candidates, {
      model: "lexical",
      topK: 2,
      scorer: lexicalRerankScorer,
    })
    expect(result.reranked).toBe(true)
    expect(result.candidates[0].id).toBe("match")
  })

  it("returns the raw cosine score when the query has no usable terms", () => {
    expect(lexicalRerankScorer("   ", c("a", 0.42, "anything"))).toBe(0.42)
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

  it("aborts the in-flight batchScorer when the timeout fires", async () => {
    let seenSignal: AbortSignal | undefined
    const batchScorer = (_q: string, _c: readonly unknown[], opts?: { signal?: AbortSignal }) => {
      seenSignal = opts?.signal
      return new Promise<number[]>((resolve) => setTimeout(() => resolve([1]), 200))
    }
    const result = await rerank("q", [c("a", 0.5)], {
      model: "llm",
      topK: 1,
      batchScorer: batchScorer as never,
      timeoutMs: 10,
    })
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toContain("timeout")
    // The scorer received a signal that is now aborted → it can cancel its request.
    expect(seenSignal?.aborted).toBe(true)
  })
})

describe("rerank — batchScorer (model-backed) path", () => {
  it("reorders by the whole-pool batch scores and takes precedence over scorer", async () => {
    const candidates = [c("a", 0.9), c("b", 0.5), c("c", 0.7)]
    const perCandidate = jest.fn(() => 0)
    const result = await rerank("q", candidates, {
      model: "llm",
      topK: 2,
      scorer: perCandidate,
      // b most relevant, then c, then a.
      batchScorer: (_q, cands) => cands.map((x) => ({ a: 0.1, b: 0.99, c: 0.6 })[x.id] ?? 0),
    })
    expect(result.reranked).toBe(true)
    expect(result.candidates.map((x) => x.id)).toEqual(["b", "c"])
    // batchScorer wins — the per-candidate scorer is never consulted.
    expect(perCandidate).not.toHaveBeenCalled()
  })

  it("falls back to identity when the batch returns the wrong length", async () => {
    const candidates = [c("a", 0.9), c("b", 0.5)]
    const result = await rerank("q", candidates, {
      model: "llm",
      topK: 2,
      batchScorer: () => [0.5], // one score for two candidates
    })
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toContain("wrong-length")
    expect(result.candidates.map((x) => x.id)).toEqual(["a", "b"])
  })

  it("falls back to identity when a batch score is non-finite", async () => {
    const result = await rerank("q", [c("a", 0.9), c("b", 0.5)], {
      model: "llm",
      topK: 2,
      batchScorer: () => [0.5, Number.NaN],
    })
    expect(result.reranked).toBe(false)
    expect(result.fallbackReason).toContain("non-finite")
  })
})

describe("createLlmRerankScorer", () => {
  const cands = [c("a", 0.9, "alpha doc"), c("b", 0.5, "beta doc")]

  it("parses a JSON score array and clamps out-of-range values", async () => {
    const client = { complete: jest.fn(async () => "Here you go: [1.5, -0.2]") }
    const scorer = createLlmRerankScorer(client)
    await expect(scorer("q", cands)).resolves.toEqual([1, 0])
    // The whole candidate pool is scored in ONE call.
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("forwards the abort signal to client.complete", async () => {
    const client = { complete: jest.fn(async () => "[0.5, 0.5]") }
    const scorer = createLlmRerankScorer(client)
    const controller = new AbortController()
    await scorer("q", cands, { signal: controller.signal })
    expect(client.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ abortSignal: controller.signal })
    )
  })

  it("refuses to send a PII-bearing query or candidate to the model", async () => {
    const client = { complete: jest.fn(async () => "[0.5, 0.5]") }
    const scorer = createLlmRerankScorer(client)

    await expect(scorer("email alice@example.com", cands)).rejects.toThrow("PII gate")
    await expect(
      scorer("safe query", [c("a", 0.9, "contact alice@example.com"), cands[1]])
    ).rejects.toThrow("PII gate")
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("drives rerank end-to-end (LLM output reorders the pool)", async () => {
    const client = { complete: jest.fn(async () => "[0.1, 0.95]") }
    const result = await rerank("q", cands, {
      model: "llm",
      topK: 2,
      batchScorer: createLlmRerankScorer(client),
    })
    expect(result.reranked).toBe(true)
    expect(result.candidates.map((x) => x.id)).toEqual(["b", "a"])
  })

  it("throws (→ rerank identity fallback) when the reply has no JSON array", async () => {
    const client = { complete: jest.fn(async () => "sorry, I can't do that") }
    const result = await rerank("q", cands, {
      model: "llm",
      topK: 2,
      batchScorer: createLlmRerankScorer(client),
    })
    expect(result.reranked).toBe(false)
    expect(result.candidates.map((x) => x.id)).toEqual(["a", "b"])
  })

  it("throws on a length mismatch from the model", async () => {
    const client = { complete: jest.fn(async () => "[0.5]") }
    const scorer = createLlmRerankScorer(client)
    await expect(scorer("q", cands)).rejects.toThrow("length mismatch")
  })
})
