jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: jest.fn(async () => ({ embedding: [1, 0, 0] })),
}))
jest.mock("@cognia/vector/dimension-guard", () => ({
  ensureCollectionDimensionCompatible: jest.fn(async () => undefined),
  EmbeddingDimensionMismatchError: class extends Error {},
}))
jest.mock("@/lib/db/knowledge-bases", () => ({
  getKnowledgeBaseChunksByVectorDocIds: jest.fn(),
  listKnowledgeBaseRevisionChunks: jest.fn(),
}))
jest.mock("@/lib/db/retrieval-control", () => ({
  isRetrievalKillSwitchEngaged: jest.fn(async () => false),
}))
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: jest.fn(async () => ({
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    storage: { vectorBackend: "native" },
  })),
}))

import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import {
  getKnowledgeBaseChunksByVectorDocIds,
  listKnowledgeBaseRevisionChunks,
} from "@/lib/db/knowledge-bases"
import { retrieveKnowledgeBaseChunks, type KnowledgeBaseRuntimeDeps } from "./retrieve"
import { isRetrievalKillSwitchEngaged } from "@/lib/db/retrieval-control"

const embedMock = generateEmbedding as jest.Mock
const dimGuardMock = ensureCollectionDimensionCompatible as jest.Mock
const loadMock = getKnowledgeBaseChunksByVectorDocIds as jest.Mock
const revisionsMock = listKnowledgeBaseRevisionChunks as jest.Mock

function makeDeps(
  hits: Array<{ id: string; content: string; score: number }>,
  vectorBackend: KnowledgeBaseRuntimeDeps["vectorBackend"] = "native"
): KnowledgeBaseRuntimeDeps {
  return {
    store: {
      searchByEmbedding: jest.fn(async () => hits),
      getCollectionInfo: jest.fn(async () => ({
        name: "cognia_kb_kb-1",
        dimension: 3,
        documentCount: hits.length,
      })),
    },
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "key" },
    vectorBackend,
  }
}

function row(id: string, knowledgeBaseId = "kb-1") {
  return {
    id: `chunk-${id}`,
    knowledgeBaseId,
    sourceId: "source-1",
    content: `content ${id}`,
    contentRedacted: `content ${id}`,
    charStart: 0,
    charEnd: 5,
    vectorBackend: "native",
    vectorCollection: `cognia_kb_${knowledgeBaseId}`,
    vectorDocId: id,
    strategy: "paragraph",
    tokenCount: 2,
    metadata: {},
    contentHash: id,
    createdAt: 1,
  }
}

beforeEach(() => {
  ;(isRetrievalKillSwitchEngaged as jest.Mock).mockResolvedValue(false)
  embedMock.mockClear().mockResolvedValue({ embedding: [1, 0, 0] })
  dimGuardMock.mockClear().mockResolvedValue(undefined)
  loadMock.mockReset()
  revisionsMock.mockReset().mockResolvedValue([row("v-high"), row("v-low")])
})

describe("retrieveKnowledgeBaseChunks", () => {
  it("short-circuits invalid inputs and can reuse a precomputed embedding", async () => {
    const deps = makeDeps([])
    await expect(
      retrieveKnowledgeBaseChunks({ knowledgeBaseId: "kb-1", userMessage: " ", topK: 2, deps })
    ).resolves.toEqual({ chunks: [], degraded: false })
    await expect(
      retrieveKnowledgeBaseChunks({ knowledgeBaseId: "kb-1", userMessage: "q", topK: 0, deps })
    ).resolves.toEqual({ chunks: [], degraded: false })
    await expect(
      retrieveKnowledgeBaseChunks({
        knowledgeBaseId: "kb-1",
        userMessage: "q",
        topK: 2,
        deps: {
          ...deps,
          store: { getCollectionInfo: deps.store.getCollectionInfo },
        },
      })
    ).resolves.toEqual({ chunks: [], degraded: false })
    loadMock.mockResolvedValue([])
    await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "q",
      topK: 2,
      precomputedQueryEmbedding: [0, 1],
      deps,
    })
    expect(embedMock).not.toHaveBeenCalled()
  })

  it("redacts cloud embedding input and preserves vector ranking and ownership", async () => {
    const deps = makeDeps(
      [
        { id: "v-high", content: "", score: 0.9 },
        { id: "v-low", content: "", score: 0.5 },
      ],
      "qdrant"
    )
    loadMock.mockResolvedValue([row("v-low"), row("v-high"), row("v-foreign", "kb-other")])

    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "Email alice@example.com about ACME-123",
      topK: 2,
      deps,
    })

    expect(embedMock).toHaveBeenCalledTimes(1)
    expect(embedMock.mock.calls[0][0]).not.toContain("alice@example.com")
    expect(result.chunks.map((item) => item.chunk.vectorDocId)).toEqual(["v-high", "v-low"])
    expect(deps.store.searchByEmbedding).toHaveBeenCalledWith("cognia_kb_kb-1", [1, 0, 0], {
      limit: 2,
    })
  })

  it("uses provider locality rather than vector locality for the PII boundary", async () => {
    const deps = makeDeps([])
    loadMock.mockResolvedValue([])

    await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "Email alice@example.com",
      topK: 2,
      deps,
    })

    expect(embedMock).toHaveBeenCalledWith("Email <EMAIL_001>", deps.embedding)
  })

  it("reports dimension incompatibility without throwing", async () => {
    const { EmbeddingDimensionMismatchError } = jest.requireMock("@cognia/vector/dimension-guard")
    dimGuardMock.mockRejectedValue(new EmbeddingDimensionMismatchError("changed embedding model"))

    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "query",
      topK: 2,
      deps: makeDeps([]),
    })

    expect(result).toEqual({
      chunks: [],
      degraded: true,
      degradedReason: "dimension-mismatch",
    })
  })

  it("isolates vector-store failures", async () => {
    const deps = makeDeps([])
    ;(deps.store.searchByEmbedding as jest.Mock).mockRejectedValue(new Error("offline"))

    await expect(
      retrieveKnowledgeBaseChunks({
        knowledgeBaseId: "kb-1",
        userMessage: "query",
        topK: 2,
        deps,
      })
    ).resolves.toEqual({ chunks: [], degraded: true, degradedReason: "retrieve-failed" })
  })

  it("loads only an explicitly frozen revision set", async () => {
    const deps = makeDeps([{ id: "v-high", content: "", score: 0.9 }])
    loadMock.mockResolvedValue([row("v-high")])

    await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "query",
      topK: 2,
      generationIds: ["gen-frozen"],
      deps,
    })

    expect(revisionsMock).toHaveBeenCalledWith("kb-1", ["gen-frozen"])
  })

  it("finds lexical evidence without embeddings and enforces authorization before scoring", async () => {
    const allowed = {
      ...row("allowed"),
      content: "The ORBIT-729 warranty is seven years.",
      contentRedacted: "The ORBIT-729 warranty is seven years.",
    }
    const denied = {
      ...row("denied"),
      sourceId: "secret",
      content: "ORBIT-729",
      contentRedacted: "ORBIT-729",
    }
    revisionsMock.mockResolvedValue([allowed, denied])
    const deps = makeDeps([])
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "ORBIT-729",
      topK: 5,
      strategy: "keyword",
      authorizeChunk: (chunk) => chunk.sourceId !== "secret",
      deps,
    })
    expect(result.chunks.map(({ chunk }) => chunk.vectorDocId)).toEqual(["allowed"])
    expect(result.degraded).toBe(false)
    expect(embedMock).not.toHaveBeenCalled()
    expect(deps.store.searchByEmbedding).not.toHaveBeenCalled()
  })

  it("honors the shared retrieval kill switch while retaining safe lexical reads", async () => {
    ;(isRetrievalKillSwitchEngaged as jest.Mock).mockResolvedValue(true)
    revisionsMock.mockResolvedValue([row("fact")])
    const deps = makeDeps([])
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "content",
      topK: 3,
      strategy: "hybrid",
      deps,
    })
    expect(result.chunks.map(({ chunk }) => chunk.vectorDocId)).toEqual(["fact"])
    expect(result).toMatchObject({ degraded: true, degradedReason: "kill_switch_active" })
    expect(embedMock).not.toHaveBeenCalled()
    expect(deps.store.searchByEmbedding).not.toHaveBeenCalled()
  })

  it("keeps lexical results with an explicit degradation when vector search fails", async () => {
    revisionsMock.mockResolvedValue([
      { ...row("fact"), content: "neutrino warranty", contentRedacted: "neutrino warranty" },
    ])
    const deps = makeDeps([])
    ;(deps.store.searchByEmbedding as jest.Mock).mockRejectedValue(new Error("offline"))
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "neutrino",
      topK: 2,
      strategy: "hybrid",
      deps,
    })
    expect(result.chunks.map(({ chunk }) => chunk.vectorDocId)).toEqual(["fact"])
    expect(result).toMatchObject({ degraded: true, degradedReason: "retrieve-failed" })
  })

  it("returns no lexical answer for unmatched terms and respects a zero token budget", async () => {
    revisionsMock.mockResolvedValue([row("fact")])
    const input = {
      knowledgeBaseId: "kb-1",
      userMessage: "astronaut",
      topK: 3,
      strategy: "keyword" as const,
      deps: makeDeps([]),
    }
    expect((await retrieveKnowledgeBaseChunks(input)).chunks).toEqual([])
    expect(
      (await retrieveKnowledgeBaseChunks({ ...input, userMessage: "content", tokenBudget: 0 }))
        .chunks
    ).toEqual([])
    expect((await retrieveKnowledgeBaseChunks({ ...input, topK: NaN })).chunks).toEqual([])
  })

  it("uses existing lexical rows when no vector runtime can be constructed", async () => {
    revisionsMock.mockResolvedValue([row("fact")])
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "content",
      topK: 3,
      strategy: "keyword",
    })
    expect(result.chunks.map(({ chunk }) => chunk.vectorDocId)).toEqual(["fact"])
    expect(result.degraded).toBe(false)
    expect(embedMock).not.toHaveBeenCalled()
  })

  it("rechecks vector authorization after search and applies the direct-call token budget", async () => {
    const deps = makeDeps([
      { id: "v-high", content: "", score: 1 },
      { id: "v-low", content: "", score: 0.5 },
    ])
    loadMock.mockResolvedValue([row("v-high"), row("v-low")])
    const authorize = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "q",
      topK: 3,
      tokenBudget: 2,
      authorizeChunk: authorize,
      deps,
    })
    expect(result.chunks.map(({ chunk }) => chunk.vectorDocId)).toEqual(["v-low"])
    expect(authorize).toHaveBeenCalledTimes(4)
    expect(
      (
        await retrieveKnowledgeBaseChunks({
          knowledgeBaseId: "kb-1",
          userMessage: "q",
          topK: 3,
          tokenBudget: 1,
          deps,
        })
      ).chunks
    ).toEqual([])
  })

  it("stops the default vector lane when the shared kill switch is engaged", async () => {
    ;(isRetrievalKillSwitchEngaged as jest.Mock).mockResolvedValue(true)
    revisionsMock.mockResolvedValue([row("fact")])
    const deps = makeDeps([])
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "content",
      topK: 3,
      deps,
    })
    expect(result).toMatchObject({ degraded: true, degradedReason: "kill_switch_active" })
    expect(result.chunks).toHaveLength(1)
    expect(embedMock).not.toHaveBeenCalled()
  })

  it("filters foreign hits before limiting the vector result", async () => {
    const deps = makeDeps([
      { id: "foreign", content: "", score: 1 },
      { id: "v-high", content: "", score: 0.9 },
    ])
    loadMock.mockResolvedValue([row("v-high")])
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "query",
      topK: 1,
      deps,
    })
    expect(result.chunks.map(({ chunk }) => chunk.vectorDocId)).toEqual(["v-high"])
  })

  it("keeps malformed stored token counts from bypassing lexical budgets", async () => {
    revisionsMock.mockResolvedValue([{ ...row("fact"), tokenCount: Number.NaN }])
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      userMessage: "content",
      topK: 3,
      tokenBudget: 1,
      strategy: "keyword",
    })
    expect(result.chunks).toEqual([])
  })
})
