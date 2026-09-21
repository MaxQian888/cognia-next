// Only the generation is faked; everything else in the AI SDK stays real.
jest.mock("ai", () => ({ ...jest.requireActual("ai"), generateText: jest.fn() }))
jest.mock("@/lib/router-fusion/gate/current-settings", () => ({
  currentRouterFusionGateSettings: jest.fn(async () => null),
}))
jest.mock("@/lib/router-fusion/gate/load-engine", () => ({
  loadRouterFusionHost: jest.fn(),
}))
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: jest.fn(async () => ({ llm: { provider: "anthropic" } })),
}))
jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: jest.fn(async () => ({ embedding: [1, 0, 0] })),
}))
jest.mock("@cognia/vector/dimension-guard", () => ({
  ensureCollectionDimensionCompatible: jest.fn(async () => undefined),
  EmbeddingDimensionMismatchError: class extends Error {},
}))
jest.mock("@/lib/db/project-chunks", () => ({
  getProjectChunksByVectorDocIds: jest.fn(),
}))
jest.mock("@/lib/ai/retrieval/corrective-filter", () => ({
  filterByGrade: jest.fn(async (_q: string, chunks: unknown[]) => chunks),
}))
jest.mock("@cognia/rag/query-expansion", () => ({
  generateHypotheticalAnswer: jest.fn(async () => "hypothetical expanded answer"),
  generateStepBackQuery: jest.fn(async () => "step back query"),
}))

import { retrieveProjectChunks, type ProjectKnowledgeRuntimeDeps } from "./retrieve"
import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import { getProjectChunksByVectorDocIds } from "@/lib/db/project-chunks"
import { filterByGrade } from "@/lib/ai/retrieval/corrective-filter"
import { generateHypotheticalAnswer } from "@cognia/rag/query-expansion"

const embedMock = generateEmbedding as jest.Mock
const dimGuardMock = ensureCollectionDimensionCompatible as jest.Mock
const loadMock = getProjectChunksByVectorDocIds as jest.Mock
const filterMock = filterByGrade as jest.Mock
const hydeMock = generateHypotheticalAnswer as jest.Mock

import { generateText } from "ai"
import { currentRouterFusionGateSettings } from "@/lib/router-fusion/gate/current-settings"
import { loadRouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { __resetBreakerForTesting } from "@/lib/router-fusion/gate/breaker"
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type { BeginLedgeredUtilityCallInput } from "@/lib/router-fusion/gate/utility-ledger"

const mockedGenerateText = generateText as jest.Mock
const gateSettingsMock = currentRouterFusionGateSettings as jest.Mock
const loadHostMock = loadRouterFusionHost as jest.Mock
const twinSettingsMock = getTwinRuntimeSettings as jest.Mock

function chunkRow(vectorDocId: string, content: string) {
  return { vectorDocId, content, fileId: "file-1", contentRedacted: content }
}

function makeDeps(
  hits: Array<{ id: string; content: string; score: number }>,
  overrides: Partial<ProjectKnowledgeRuntimeDeps> = {}
): ProjectKnowledgeRuntimeDeps {
  return {
    store: {
      searchByEmbedding: jest.fn(async () => hits),
    } as unknown as ProjectKnowledgeRuntimeDeps["store"],
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "k" },
    ...overrides,
  }
}

beforeEach(() => {
  embedMock.mockClear().mockResolvedValue({ embedding: [1, 0, 0] })
  dimGuardMock.mockClear().mockResolvedValue(undefined)
  loadMock.mockReset()
  filterMock.mockClear().mockImplementation(async (_q: string, chunks: unknown[]) => chunks)
  hydeMock.mockClear().mockResolvedValue("hypothetical expanded answer")
})

describe("retrieveProjectChunks", () => {
  it("returns empty for topK<=0 or blank message (no store call)", async () => {
    const deps = makeDeps([])
    expect(
      (await retrieveProjectChunks({ projectId: "p", userMessage: "hi", topK: 0, deps })).chunks
    ).toEqual([])
    expect(
      (await retrieveProjectChunks({ projectId: "p", userMessage: "   ", topK: 5, deps })).chunks
    ).toEqual([])
    expect(deps.store.searchByEmbedding).not.toHaveBeenCalled()
  })

  it("returns empty when the store has no searchByEmbedding", async () => {
    const deps = { ...makeDeps([]), store: {} as ProjectKnowledgeRuntimeDeps["store"] }
    const res = await retrieveProjectChunks({ projectId: "p", userMessage: "q", topK: 5, deps })
    expect(res.chunks).toEqual([])
  })

  it("resolves hits to chunks in ranking order, capped at topK", async () => {
    const deps = makeDeps([
      { id: "v0", content: "c0", score: 0.9 },
      { id: "v1", content: "c1", score: 0.8 },
      { id: "v2", content: "c2", score: 0.7 },
    ])
    loadMock.mockResolvedValue([chunkRow("v2", "c2"), chunkRow("v0", "c0"), chunkRow("v1", "c1")])
    const res = await retrieveProjectChunks({ projectId: "p", userMessage: "q", topK: 2, deps })
    expect(res.chunks.map((c) => c.chunk.vectorDocId)).toEqual(["v0", "v1"])
    expect(res.degraded).toBe(false)
  })

  it("reuses a precomputed embedding (no embed call)", async () => {
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }])
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])
    await retrieveProjectChunks({
      projectId: "p",
      userMessage: "q",
      topK: 3,
      precomputedQueryEmbedding: [0.5, 0.5, 0.5],
      deps,
    })
    expect(embedMock).not.toHaveBeenCalled()
  })

  it("applies a reranker over the over-fetched pool", async () => {
    const hits = Array.from({ length: 6 }, (_, i) => ({
      id: `v${i}`,
      content: `c${i}`,
      score: 1 - i * 0.1,
    }))
    const deps = makeDeps(hits, {
      reranker: {
        model: "lexical",
        overFetch: 3,
        // Reverse the order via score.
        scorer: (_q, cand) => Number(cand.id.slice(1)),
      },
    })
    loadMock.mockResolvedValue(hits.map((h) => chunkRow(h.id, h.content)))
    const res = await retrieveProjectChunks({ projectId: "p", userMessage: "q", topK: 2, deps })
    expect(res.chunks).toHaveLength(2)
    // Highest id wins under the reverse scorer.
    expect(res.chunks[0].chunk.vectorDocId).toBe("v5")
  })

  it("degrades (never throws) when the vector search fails", async () => {
    const deps = makeDeps([])
    ;(deps.store.searchByEmbedding as jest.Mock).mockRejectedValue(new Error("boom"))
    const res = await retrieveProjectChunks({ projectId: "p", userMessage: "q", topK: 5, deps })
    expect(res.chunks).toEqual([])
    expect(res.degraded).toBe(true)
    expect(res.degradedReason).toContain("retrieve-failed")
  })

  it("fuses an LLM query-expansion leg when configured (PII-free message)", async () => {
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model: {} as never, strategy: "hyde" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])
    const res = await retrieveProjectChunks({
      projectId: "p",
      userMessage: "what is the rollout plan",
      topK: 5,
      deps,
    })
    expect(hydeMock).toHaveBeenCalled()
    // Two searches: original + expanded.
    expect((deps.store.searchByEmbedding as jest.Mock).mock.calls.length).toBe(2)
    expect(res.chunks).toHaveLength(1)
  })

  it("uses the step-back strategy when configured", async () => {
    const { generateStepBackQuery } = jest.requireMock("@cognia/rag/query-expansion")
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model: {} as never, strategy: "stepback" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])
    await retrieveProjectChunks({ projectId: "p", userMessage: "how does it work", topK: 5, deps })
    expect(generateStepBackQuery).toHaveBeenCalled()
    expect(hydeMock).not.toHaveBeenCalled()
  })

  it("degrades (expansion-failed) but keeps vector results when expansion throws", async () => {
    hydeMock.mockRejectedValue(new Error("llm down"))
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model: {} as never, strategy: "hyde" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])
    const res = await retrieveProjectChunks({
      projectId: "p",
      userMessage: "clean query",
      topK: 5,
      deps,
    })
    expect(res.degraded).toBe(true)
    expect(res.degradedReason).toContain("expansion-failed")
    expect(res.chunks).toHaveLength(1)
  })

  it("skips expansion (degraded reason) when the message carries PII", async () => {
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model: {} as never, strategy: "hyde" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])
    const res = await retrieveProjectChunks({
      projectId: "p",
      userMessage: "email me at alice@example.com about it",
      topK: 5,
      deps,
    })
    expect(hydeMock).not.toHaveBeenCalled()
    expect(res.degraded).toBe(true)
    expect(res.degradedReason).toBe("expansion-pii-skip")
    // Vector results still returned.
    expect(res.chunks).toHaveLength(1)
  })

  it("reports a dimension-mismatch degradation distinctly", async () => {
    const { EmbeddingDimensionMismatchError } = jest.requireMock("@cognia/vector/dimension-guard")
    dimGuardMock.mockRejectedValue(new EmbeddingDimensionMismatchError("dim 1536 != 768"))
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }])
    const res = await retrieveProjectChunks({ projectId: "p", userMessage: "q", topK: 5, deps })
    expect(res.chunks).toEqual([])
    expect(res.degraded).toBe(true)
    expect(res.degradedReason).toContain("dimension-mismatch")
  })

  it("runs the corrective filter by default and can be disabled", async () => {
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }])
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])
    await retrieveProjectChunks({ projectId: "p", userMessage: "q", topK: 5, deps })
    expect(filterMock).toHaveBeenCalledTimes(1)
    filterMock.mockClear()
    await retrieveProjectChunks({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      enableCorrectiveFilter: false,
      deps,
    })
    expect(filterMock).not.toHaveBeenCalled()
  })
})

// --- Router + Fusion ledger (ADR-0188 D27) -----------------------------------
// The expansion call is a utility generation. With `utilityLedger` on it runs
// through the real `@cognia/rag/query-expansion`, wrapped by the host seam; off,
// it is the call it always was, and no Router + Fusion module loads.

describe("retrieveProjectChunks — ledgered query expansion", () => {
  const actualExpansion = jest.requireActual("@cognia/rag/query-expansion") as {
    generateHypotheticalAnswer: typeof generateHypotheticalAnswer
  }
  const model = { modelId: "claude-haiku-4-5" } as never
  const ON = { routerFusion: { enabled: true, surfaces: { utilityLedger: true } } }
  const OFF = { routerFusion: { enabled: false, surfaces: { utilityLedger: true } } }

  const reserved: BeginLedgeredUtilityCallInput[] = []

  beforeEach(() => {
    __resetBreakerForTesting()
    reserved.length = 0
    mockedGenerateText.mockReset().mockResolvedValue({
      text: "a hypothetical passage",
      usage: { inputTokens: 90, outputTokens: 30 },
    })
    // The real package function, so the seam is exercised end to end.
    hydeMock.mockImplementation(actualExpansion.generateHypotheticalAnswer)
    twinSettingsMock.mockClear()
    loadHostMock.mockReset().mockResolvedValue({
      beginLedgeredUtilityCall: async (input: BeginLedgeredUtilityCallInput) => {
        reserved.push(input)
        return {
          kind: "granted",
          handle: {
            runId: "run-1",
            maxOutputTokens: 300,
            succeeded: async () => {},
            failed: async () => {},
            unknown: async () => {},
          },
        }
      },
    } as unknown as RouterFusionHost)
  })

  it("reserves the expansion call on the ledger when the utility switch is on", async () => {
    gateSettingsMock.mockResolvedValue(ON)
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model, strategy: "hyde" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])

    const res = await retrieveProjectChunks({
      projectId: "p-42",
      userMessage: "what is the rollout plan",
      topK: 5,
      deps,
    })

    expect(res.degraded).toBe(false)
    expect(reserved).toHaveLength(1)
    expect(reserved[0]).toMatchObject({
      featureId: "project-knowledge-expansion:rag.hyde",
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
      workspaceId: "p-42",
    })
    // The reservation's bound and no hidden retries reach the provider call.
    expect(mockedGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 300, maxRetries: 0 })
    )
  })

  it("prefers a provider id the deps carry over a twin settings read", async () => {
    gateSettingsMock.mockResolvedValue(ON)
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model, strategy: "hyde", providerId: "deepseek" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])

    await retrieveProjectChunks({ projectId: "p", userMessage: "clean query", topK: 5, deps })

    expect(reserved[0]).toMatchObject({ providerId: "deepseek" })
    expect(twinSettingsMock).not.toHaveBeenCalled()
  })

  it("[ACC:OFF-03] leaves the call untouched, and loads no ledger, while the switch is off", async () => {
    gateSettingsMock.mockResolvedValue(OFF)
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model, strategy: "hyde" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])

    await retrieveProjectChunks({ projectId: "p", userMessage: "clean query", topK: 5, deps })

    expect(loadHostMock).not.toHaveBeenCalled()
    expect(twinSettingsMock).not.toHaveBeenCalled()
    const args = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(args).sort()).toEqual(["model", "prompt", "temperature"])
  })

  it("[ACC:ISO-01] still expands, unledgered, when the ledger faults", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    gateSettingsMock.mockResolvedValue(ON)
    loadHostMock.mockRejectedValue(new Error("fusion database unavailable"))
    const deps = makeDeps([{ id: "v0", content: "c0", score: 1 }], {
      expansion: { model, strategy: "hyde" },
    })
    loadMock.mockResolvedValue([chunkRow("v0", "c0")])

    const res = await retrieveProjectChunks({
      projectId: "p",
      userMessage: "clean query",
      topK: 5,
      deps,
    })

    expect(res.degraded).toBe(false)
    const args = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(args).sort()).toEqual(["model", "prompt", "temperature"])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
