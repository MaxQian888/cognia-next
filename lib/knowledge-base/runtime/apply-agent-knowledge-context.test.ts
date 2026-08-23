jest.mock("@/lib/db/knowledge-bases", () => ({
  getKnowledgeBasesByIds: jest.fn(),
  getKnowledgeBaseSourcesByIds: jest.fn(),
}))
jest.mock("./retrieve", () => ({
  retrieveKnowledgeBaseChunks: jest.fn(),
}))

import type { KnowledgeBase, KnowledgeBaseChunk, KnowledgeBaseSource } from "@/types/knowledge-base"
import {
  applyAgentKnowledgeContext,
  applyAgentKnowledgeContextFromDb,
  type AgentKnowledgeLibraryResult,
} from "./apply-agent-knowledge-context"
import * as knowledgeBaseDb from "@/lib/db/knowledge-bases"
import * as retrieval from "./retrieve"

function chunk(
  id: string,
  knowledgeBaseId: string,
  sourceId: string,
  content: string,
  score: number,
  tokenCount = 10
): AgentKnowledgeLibraryResult["chunks"][number] {
  return {
    chunk: {
      id,
      knowledgeBaseId,
      sourceId,
      content,
      contentRedacted: content,
      charStart: 0,
      charEnd: content.length,
      vectorBackend: "native",
      vectorCollection: `cognia_kb_${knowledgeBaseId}`,
      vectorDocId: `vector-${id}`,
      strategy: "paragraph",
      tokenCount,
      metadata: { headingPath: ["Overview"] },
      contentHash: id,
      createdAt: 1,
    } satisfies KnowledgeBaseChunk,
    score,
  }
}

const libraries: KnowledgeBase[] = [
  { id: "kb-a", name: "Product", createdAt: 1, updatedAt: 1 },
  { id: "kb-b", name: "Support", createdAt: 1, updatedAt: 1 },
]

const sources: KnowledgeBaseSource[] = [
  {
    id: "source-a",
    knowledgeBaseId: "kb-a",
    kind: "document",
    format: "markdown",
    title: "Product guide",
    content: "",
    bytes: 0,
    fingerprint: "a",
    status: "ready",
    chunkCount: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "source-b",
    knowledgeBaseId: "kb-b",
    kind: "email",
    format: "eml",
    title: "Support notes",
    content: "",
    bytes: 0,
    fingerprint: "b",
    status: "ready",
    chunkCount: 1,
    createdAt: 1,
    updatedAt: 1,
  },
]

describe("applyAgentKnowledgeContext", () => {
  it("returns an empty result for disabled inputs", async () => {
    const deps = {
      retrieveLibrary: jest.fn(),
      loadLibraries: jest.fn(),
      loadSources: jest.fn(),
    }
    for (const input of [
      { knowledgeBaseIds: [], userMessage: "q", topKPerBase: 1, tokenBudget: 10 },
      { knowledgeBaseIds: ["kb-a"], userMessage: " ", topKPerBase: 1, tokenBudget: 10 },
      { knowledgeBaseIds: ["kb-a"], userMessage: "q", topKPerBase: 0, tokenBudget: 10 },
      { knowledgeBaseIds: ["kb-a"], userMessage: "q", topKPerBase: 1, tokenBudget: 0 },
    ]) {
      await expect(applyAgentKnowledgeContext({ ...input, deps })).resolves.toEqual(
        expect.objectContaining({ systemPromptSection: null, retrievedChunks: [] })
      )
    }
    expect(deps.retrieveLibrary).not.toHaveBeenCalled()
  })

  it("queries bound libraries concurrently, deduplicates, ranks, budgets, and cites", async () => {
    const resolvers = new Map<string, (value: AgentKnowledgeLibraryResult) => void>()
    const retrieveLibrary = jest.fn(
      ({ knowledgeBaseId }: { knowledgeBaseId: string }) =>
        new Promise<AgentKnowledgeLibraryResult>((resolve) =>
          resolvers.set(knowledgeBaseId, resolve)
        )
    )

    const pending = applyAgentKnowledgeContext({
      knowledgeBaseIds: ["kb-a", "kb-b", "kb-a"],
      userMessage: "How does setup work?",
      topKPerBase: 3,
      tokenBudget: 25,
      deps: {
        retrieveLibrary,
        loadLibraries: async () => libraries,
        loadSources: async () => sources,
      },
    })

    await Promise.resolve()
    expect(retrieveLibrary).toHaveBeenCalledTimes(2)
    resolvers.get("kb-a")?.({
      chunks: [
        chunk("a-high", "kb-a", "source-a", "Install with pnpm.", 0.95, 10),
        chunk("a-large", "kb-a", "source-a", "Large appendix", 0.8, 30),
      ],
      degraded: false,
    })
    resolvers.get("kb-b")?.({
      chunks: [
        chunk("b-duplicate", "kb-b", "source-b", " install  with   pnpm. ", 0.9, 10),
        chunk("b-next", "kb-b", "source-b", "Restart the app.", 0.7, 10),
      ],
      degraded: false,
    })

    const result = await pending

    expect(result.retrievedChunks.map((item) => item.chunk.id)).toEqual(["a-high", "b-next"])
    expect(result.budget).toEqual({ limit: 25, used: 20, truncated: true })
    expect(result.citations).toEqual([
      expect.objectContaining({
        scope: "agent-knowledge-base",
        knowledgeBaseId: "kb-a",
        knowledgeBaseName: "Product",
        sourceId: "source-a",
        sourceTitle: "Product guide",
      }),
      expect.objectContaining({ knowledgeBaseId: "kb-b", sourceTitle: "Support notes" }),
    ])
    expect(result.systemPromptSection).toContain("## Agent knowledge bases")
    expect(result.systemPromptSection).toContain("[Product / Product guide]")
  })

  it("degrades only the failed library and preserves successful results", async () => {
    const result = await applyAgentKnowledgeContext({
      knowledgeBaseIds: ["kb-a", "kb-b"],
      userMessage: "refund",
      topKPerBase: 2,
      tokenBudget: 100,
      deps: {
        retrieveLibrary: async ({ knowledgeBaseId }) => {
          if (knowledgeBaseId === "kb-a") throw new Error("vector store offline")
          return {
            chunks: [chunk("b-one", "kb-b", "source-b", "Refunds take three days.", 0.8)],
            degraded: false,
          }
        },
        loadLibraries: async () => libraries,
        loadSources: async () => sources,
      },
    })

    expect(result.retrievedChunks.map((item) => item.chunk.id)).toEqual(["b-one"])
    expect(result.degraded).toBe(true)
    expect(result.failures).toEqual([
      { knowledgeBaseId: "kb-a", reason: "retrieve-failed", rebuildRequired: false },
    ])
  })

  it("removes unauthorized chunks before prompt, citation, and budget construction", async () => {
    const result = await applyAgentKnowledgeContext({
      knowledgeBaseIds: ["kb-a", "kb-b"],
      userMessage: "private material",
      topKPerBase: 2,
      tokenBudget: 100,
      authorizeChunk: ({ source }) => source?.id === "source-b",
      deps: {
        retrieveLibrary: async ({ knowledgeBaseId }) => ({
          chunks:
            knowledgeBaseId === "kb-a"
              ? [chunk("private", "kb-a", "source-a", "Do not leak", 1, 10)]
              : [chunk("public", "kb-b", "source-b", "Allowed", 0.5, 6)],
          degraded: false,
        }),
        loadLibraries: async () => libraries,
        loadSources: async () => sources,
      },
    })

    expect(result.retrievedChunks.map((item) => item.chunk.id)).toEqual(["public"])
    expect(result.citations).toHaveLength(1)
    expect(result.systemPromptSection).not.toContain("Do not leak")
    expect(result.budget.used).toBe(6)
  })

  it("applies a minimum score before budget construction", async () => {
    const result = await applyAgentKnowledgeContext({
      knowledgeBaseIds: ["kb-a"],
      userMessage: "threshold",
      topKPerBase: 2,
      tokenBudget: 100,
      minScore: 0.8,
      deps: {
        retrieveLibrary: async () => ({
          chunks: [
            chunk("high", "kb-a", "source-a", "Keep", 0.9, 4),
            chunk("low", "kb-a", "source-a", "Drop", 0.79, 5),
          ],
          degraded: false,
        }),
        loadLibraries: async () => libraries,
        loadSources: async () => sources,
      },
    })

    expect(result.retrievedChunks.map((item) => item.chunk.id)).toEqual(["high"])
    expect(result.budget.used).toBe(4)
  })

  it("surfaces embedding incompatibility as an explicit rebuild requirement", async () => {
    const result = await applyAgentKnowledgeContext({
      knowledgeBaseIds: ["kb-a"],
      userMessage: "query",
      topKPerBase: 2,
      tokenBudget: 100,
      deps: {
        retrieveLibrary: async () => ({
          chunks: [],
          degraded: true,
          degradedReason: "dimension-mismatch",
        }),
        loadLibraries: async () => libraries,
        loadSources: async () => sources,
      },
    })

    expect(result.failures).toEqual([
      { knowledgeBaseId: "kb-a", reason: "dimension-mismatch", rebuildRequired: true },
    ])
  })

  it("uses stable fallbacks for sparse metadata and empty/degraded candidates", async () => {
    const sparse = chunk("sparse", "kb-missing", "source-missing", "Sparse", 0.5, -2)
    sparse.chunk.metadata = { pageNumber: 3, filePath: "docs/a.md" }
    const tied = chunk("tied", "kb-missing", "source-missing", "Tied", 0.5, 1)
    const result = await applyAgentKnowledgeContext({
      knowledgeBaseIds: ["kb-missing"],
      userMessage: "q",
      topKPerBase: 3,
      tokenBudget: 10,
      deps: {
        retrieveLibrary: async () => ({
          chunks: [tied, sparse, chunk("empty", "kb-missing", "source-missing", " ", 0.4)],
          degraded: true,
        }),
        loadLibraries: async () => [],
        loadSources: async () => [],
      },
    })

    expect(result.failures[0].reason).toBe("retrieve-failed")
    expect(result.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeBaseName: "kb-missing",
          sourceTitle: "source-missing",
        }),
        expect.objectContaining({ pageNumber: 3, filePath: "docs/a.md" }),
      ])
    )
  })

  it("wires the production adapter to Dexie metadata and the library retriever", async () => {
    ;(knowledgeBaseDb.getKnowledgeBasesByIds as jest.Mock).mockResolvedValue(libraries)
    ;(knowledgeBaseDb.getKnowledgeBaseSourcesByIds as jest.Mock).mockResolvedValue(sources)
    const retrieve = retrieval.retrieveKnowledgeBaseChunks as jest.Mock
    retrieve.mockResolvedValue({
      chunks: [chunk("a-one", "kb-a", "source-a", "Product answer", 0.9)],
      degraded: false,
    })

    const result = await applyAgentKnowledgeContextFromDb({
      knowledgeBaseIds: ["kb-a"],
      userMessage: "question",
      topKPerBase: 2,
      tokenBudget: 100,
      precomputedQueryEmbedding: [1, 0],
      runtimeDeps: {
        store: { getCollectionInfo: jest.fn() },
        embedding: { provider: "openai", model: "embedding", apiKey: "key" },
        vectorBackend: "native",
      },
    })

    expect(result.retrievedChunks).toHaveLength(1)
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-a",
        precomputedQueryEmbedding: [1, 0],
      })
    )
  })
})
