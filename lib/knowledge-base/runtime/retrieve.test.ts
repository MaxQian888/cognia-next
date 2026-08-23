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

import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import {
  getKnowledgeBaseChunksByVectorDocIds,
  listKnowledgeBaseRevisionChunks,
} from "@/lib/db/knowledge-bases"
import { retrieveKnowledgeBaseChunks, type KnowledgeBaseRuntimeDeps } from "./retrieve"

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
})
