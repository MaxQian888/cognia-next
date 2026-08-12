import { createRetrievalProfile } from "./retrieval-profile"
import { createRetrievalKernel } from "./retrieval-kernel"

const profile = createRetrievalProfile({
  id: "shared",
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 2 },
  vector: { backend: "native", collectionPolicy: "generation" },
  budgets: { topK: 3, tokenBudget: 20, timeoutMs: 500 },
})

describe("RetrievalKernel", () => {
  it("fuses eligible lexical and vector candidates and emits content-free trace", async () => {
    const kernel = createRetrievalKernel({
      profile,
      profileFingerprint: "fp-1",
      generationId: "generation-2",
      embedQuery: async () => ({ embedding: [0.1, 0.2], safeTextHash: "query-hash" }),
      lexicalSearch: async () => [
        { id: "allowed", sourceId: "source-a", domain: "memory", score: 5 },
        { id: "denied", sourceId: "source-b", domain: "kb", score: 4 },
      ],
      vectorSearch: async () => [
        { id: "allowed", sourceId: "source-a", domain: "memory", score: 0.9 },
      ],
      checkEligibility: async (candidate) =>
        candidate.id === "denied"
          ? { eligible: false, reason: "source_revoked" }
          : { eligible: true },
      resolveContent: async () => [
        {
          id: "allowed",
          sourceId: "source-a",
          domain: "memory",
          content: "A grounded fact",
          tokenCount: 4,
          trust: "trusted",
          citation: { sourceRevision: "r1", startOffset: 0, endOffset: 15 },
        },
      ],
    })

    const result = await kernel.retrieve({
      query: "private raw query",
      reader: { projectId: "project-1", agentId: "agent-1", branch: "main", path: "src/a.ts" },
      domains: ["memory", "kb"],
    })

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toEqual(expect.objectContaining({ id: "allowed" }))
    expect(result.partial).toBe(false)
    expect(result.trace).toEqual(
      expect.objectContaining({
        queryHash: "query-hash",
        profileFingerprint: "fp-1",
        generationId: "generation-2",
        candidateIds: ["allowed", "denied"],
        hitIds: ["allowed"],
      })
    )
    expect(JSON.stringify(result.trace)).not.toContain("private raw query")
    expect(result.trace.exclusions).toContainEqual({ id: "denied", reason: "source_revoked" })
  })

  it("returns an explicit BM25 partial result when vector retrieval fails", async () => {
    const kernel = createRetrievalKernel({
      profile,
      profileFingerprint: "fp-1",
      generationId: "generation-1",
      embedQuery: async () => ({ embedding: [0.1, 0.2], safeTextHash: "query-hash" }),
      lexicalSearch: async () => [
        { id: "lexical", sourceId: "source-a", domain: "project", score: 2 },
      ],
      vectorSearch: async () => {
        throw new Error("backend unavailable")
      },
      checkEligibility: async () => ({ eligible: true }),
      resolveContent: async () => [
        {
          id: "lexical",
          sourceId: "source-a",
          domain: "project",
          content: "Lexical fallback",
          tokenCount: 3,
          trust: "trusted",
          citation: { sourceRevision: "r1", startOffset: 2, endOffset: 18 },
        },
      ],
    })

    const result = await kernel.retrieve({ query: "fallback", reader: {}, domains: ["project"] })

    expect(result.hits.map((hit) => hit.id)).toEqual(["lexical"])
    expect(result.partial).toBe(true)
    expect(result.degraded).toBe(true)
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: "vector_unavailable", stage: "vector" })
    )
  })

  it("rejects mismatched precomputed embeddings and enforces the token budget", async () => {
    const kernel = createRetrievalKernel({
      profile,
      profileFingerprint: "fp-1",
      generationId: "generation-1",
      lexicalSearch: async () => [
        { id: "one", sourceId: "s", domain: "memory", score: 3 },
        { id: "two", sourceId: "s", domain: "memory", score: 2 },
      ],
      vectorSearch: async () => [],
      checkEligibility: async () => ({ eligible: true }),
      resolveContent: async (candidates) =>
        candidates.map((candidate) => ({
          ...candidate,
          content: candidate.id,
          tokenCount: 15,
          trust: "trusted" as const,
          citation: { sourceRevision: "r1", startOffset: 0, endOffset: 3 },
        })),
    })

    const result = await kernel.retrieve({
      query: "budget",
      reader: {},
      domains: ["memory"],
      precomputedEmbedding: { embedding: [1], safeTextHash: "query-hash" },
    })

    expect(result.hits.map((hit) => hit.id)).toEqual(["one"])
    expect(result.partial).toBe(true)
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["vector_dimension_mismatch", "token_budget_exhausted"])
    )
  })
})
