import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"

const mockTryBuildTwinDeps = jest.fn()
const mockCreateProviderEmbeddingAdapter = jest.fn()
const mockSearchByEmbedding = jest.fn()

jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: () => mockTryBuildTwinDeps(),
}))
jest.mock("@cognia/memory/runtime/provider-embedding-adapter", () => ({
  createProviderEmbeddingAdapter: (...args: unknown[]) =>
    mockCreateProviderEmbeddingAdapter(...args),
}))
jest.mock("@/lib/claude/feature-call", () => ({
  createBedrockSidecarEmbeddingModel: jest.fn(() => ({ specificationVersion: "v3" })),
}))
jest.mock("@/lib/db/memories", () => ({
  listActiveForReader: jest.fn(async () => [{ id: "c1" }]),
  listActiveProcedural: jest.fn(async () => [{ id: "p1" }]),
  touchMemories: jest.fn(async () => undefined),
}))

import {
  tryBuildMemoryDeps,
  tryBuildMemoryVectorSink,
  describeMemoryRetrievalMode,
  MEMORY_VECTOR_COLLECTION,
} from "./build-deps"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSearchByEmbedding.mockResolvedValue([{ id: "v1", content: "x", score: 0.7 }])
  mockCreateProviderEmbeddingAdapter.mockReturnValue(async () => [0.1, 0.2])
})

describe("tryBuildMemoryDeps", () => {
  it("returns undefined when memory is disabled", async () => {
    expect(await tryBuildMemoryDeps(cfg({ enabled: false }))).toBeUndefined()
    expect(await tryBuildMemoryDeps(cfg({ temporary: true }))).toBeUndefined()
  })

  it("builds local deps when global recall is off so a chat-level opt-in can work", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    expect(await tryBuildMemoryDeps(cfg({ useMemory: false }))).toBeDefined()
  })

  it("returns base (BM25-only) deps when no twin backend is available", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps).toBeDefined()
    expect(deps!.embed).toBeUndefined()
    expect(deps!.vectorSearch).toBeUndefined()
    expect((await deps!.loadCandidates()).length).toBe(1)
    expect((await deps!.loadProcedural()).length).toBe(1)
  })

  it("does NOT attach cloud embedding when allowCloudEmbedding is false", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: false }))
    expect(deps!.embed).toBeUndefined()
    expect(deps!.vectorSearch).toBeUndefined()
  })

  it("attaches embedding for a local provider even without cloud opt-in", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: false }))
    expect(deps!.embed).toBeDefined()
    expect(deps!.vectorSearch).toBeDefined()
    expect(await deps!.embed!("hi")).toEqual([0.1, 0.2])
    const hits = await deps!.vectorSearch!([0.1], 3)
    expect(mockSearchByEmbedding).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, [0.1], {
      limit: 3,
    })
    expect(hits).toEqual([{ id: "v1", score: 0.7 }])
  })

  it("attaches cloud embedding when the user opts in", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: true }))
    expect(deps!.embed).toBeDefined()
    expect(deps!.vectorSearch).toBeDefined()
  })

  it("builds a sidecar embedding proxy for Bedrock default-chain auth", async () => {
    const bedrock = { authMode: "default-chain" as const, region: "us-west-2", profile: "dev" }
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: {
        provider: "amazon-bedrock",
        model: "amazon.titan-embed-text-v2:0",
        apiKey: "",
        bedrock,
      },
    })

    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: true }))

    expect(deps?.embed).toBeDefined()
    expect(mockCreateProviderEmbeddingAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "amazon-bedrock",
        bedrock,
        bedrockModel: { specificationVersion: "v3" },
      })
    )
  })

  it("falls back to BM25-only when building the backend throws", async () => {
    mockTryBuildTwinDeps.mockRejectedValue(new Error("boom"))
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps).toBeDefined()
    expect(deps!.embed).toBeUndefined()
  })

  it("skips embedding when the store lacks searchByEmbedding", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: {},
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps!.vectorSearch).toBeUndefined()
  })

  it("stays BM25-only when hybridEnabled is off, even with a usable local backend", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ hybridEnabled: false }))
    expect(deps).toBeDefined()
    expect(deps!.embed).toBeUndefined()
    expect(deps!.vectorSearch).toBeUndefined()
  })

  it("scopes the vector leg to the plan's allowlist and scores locally", async () => {
    // The eligible-candidate allowlist replaces the global top-K query: only
    // the authorized doc ids are fetched, then cosine-scored in-process —
    // unauthorized rows can no longer crowd out the result window.
    const getDocuments = jest.fn(async () => [
      { id: "auth-close", embedding: [1, 0] },
      { id: "auth-far", embedding: [0, 1] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    const hits = await deps!.vectorSearch!([1, 0], 5, {
      vectorDocIds: ["auth-close", "auth-far"],
    })
    expect(getDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, ["auth-close", "auth-far"])
    expect(mockSearchByEmbedding).not.toHaveBeenCalled()
    expect(hits[0].id).toBe("auth-close")
    expect(hits[0].score).toBeCloseTo(1)
    expect(hits[1].id).toBe("auth-far")
    expect(hits[1].score).toBeCloseTo(0)
  })

  it("returns [] for an empty allowlist without touching the store", async () => {
    const getDocuments = jest.fn()
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    expect(await deps!.vectorSearch!([1, 0], 5, { vectorDocIds: [] })).toEqual([])
    expect(getDocuments).not.toHaveBeenCalled()
    expect(mockSearchByEmbedding).not.toHaveBeenCalled()
  })

  it("scores all authorized vectors in bounded batches, retaining late best matches", async () => {
    const ids = Array.from({ length: 601 }, (_, index) => `memory-${index}`)
    const getDocuments = jest.fn(async (_collection: string, batch: string[]) => {
      expect(batch.length).toBeLessThanOrEqual(256)
      return batch.map((id) => ({
        id,
        embedding: id === "memory-600" ? [1, 0] : [0, 1],
      }))
    })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await expect(deps!.vectorSearch!([1, 0], 1, { vectorDocIds: ids })).resolves.toEqual([
      { id: "memory-600", score: 1 },
    ])
    expect(getDocuments.mock.calls.flatMap(([, batch]) => batch)).toEqual(ids)
  })

  it("excludes non-finite vectors and unexpected ids returned by a scoped backend", async () => {
    const getDocuments = jest.fn(async () => [
      { id: "unauthorized", embedding: [1, 0] },
      { id: "nan", embedding: [NaN, 1] },
      { id: "infinite", embedding: [Infinity, 0] },
      { id: "safe", embedding: [0, 1] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await expect(
      deps!.vectorSearch!([1, 0], 5, {
        vectorDocIds: ["nan", "infinite", "safe"],
      })
    ).resolves.toEqual([{ id: "safe", score: 0 }])
  })

  it("stops a cancelled vector scan before requesting the next batch", async () => {
    const controller = new AbortController()
    const getDocuments = jest.fn(async () => {
      controller.abort()
      return []
    })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await expect(
      deps!.vectorSearch!([1, 0], 1, {
        vectorDocIds: Array.from({ length: 600 }, (_, index) => String(index)),
        signal: controller.signal,
      })
    ).rejects.toThrow()
    expect(getDocuments).toHaveBeenCalledTimes(1)
  })

  it("passes cancellation to the embedding adapter and refuses an aborted query", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    const controller = new AbortController()
    await deps!.embed!("bounded query", { signal: controller.signal })
    expect(mockCreateProviderEmbeddingAdapter).toHaveBeenLastCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    )
    controller.abort()
    const count = mockCreateProviderEmbeddingAdapter.mock.calls.length
    await expect(deps!.embed!("aborted query", { signal: controller.signal })).rejects.toThrow()
    expect(mockCreateProviderEmbeddingAdapter).toHaveBeenCalledTimes(count)
  })

  it("drops unembedded or dimension-mismatched docs and respects topK", async () => {
    const getDocuments = jest.fn(async () => [
      { id: "no-vec" },
      { id: "wrong-dims", embedding: [1, 0, 0] },
      { id: "best", embedding: [1, 0] },
      { id: "worst", embedding: [-1, 0] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    const hits = await deps!.vectorSearch!([1, 0], 1, {
      vectorDocIds: ["no-vec", "wrong-dims", "best", "worst"],
    })
    expect(hits).toEqual([{ id: "best", score: expect.closeTo(1) }])
  })

  it("keeps the global search for a plan-less (legacy) call", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments: jest.fn() },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await deps!.vectorSearch!([0.1], 3)
    expect(mockSearchByEmbedding).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, [0.1], {
      limit: 3,
    })
  })

  it("reuses prebuilt twin deps and does not call tryBuildTwinDeps again", async () => {
    const prebuilt = {
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    } as never
    const deps = await tryBuildMemoryDeps(cfg(), prebuilt)
    expect(deps!.embed).toBeDefined()
    expect(deps!.vectorSearch).toBeDefined()
    // The second tryBuildTwinDeps() call is skipped — the backend came from the
    // caller-supplied deps.
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })
})

describe("tryBuildMemoryVectorSink", () => {
  it("blocks unsafe content at the sink before provider embedding or persistence", async () => {
    const addDocuments = jest.fn(async () => undefined)
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    const sink = await tryBuildMemoryVectorSink(cfg({ allowCloudEmbedding: true }))
    await expect(sink!.upsert("m1", "Email bob@example.com")).rejects.toThrow(
      "memory_vector_pii_blocked"
    )
    expect(addDocuments).not.toHaveBeenCalled()
  })

  it("returns undefined when memory is disabled", async () => {
    expect(await tryBuildMemoryVectorSink(cfg({ enabled: false }))).toBeUndefined()
  })

  it("returns undefined when there is no embedding backend", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    expect(await tryBuildMemoryVectorSink(cfg())).toBeUndefined()
  })

  it("returns undefined when the store cannot add documents", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding }, // no addDocuments
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    expect(await tryBuildMemoryVectorSink(cfg())).toBeUndefined()
  })

  it("upserts a memory's text into the collection when a backend is available", async () => {
    const addDocuments = jest.fn(async () => undefined)
    const deleteDocuments = jest.fn(async () => undefined)
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments, deleteDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const sink = await tryBuildMemoryVectorSink(cfg())
    expect(sink).toBeDefined()
    await sink!.upsert("m1", "The user prefers pnpm")
    expect(addDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, [
      { id: "m1", content: "The user prefers pnpm" },
    ])
    await sink!.delete(["m1"])
    expect(deleteDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, ["m1"])
  })

  it("exposes listIds paging over scrollDocuments, absent otherwise", async () => {
    const addDocuments = jest.fn(async () => undefined)
    // No scrollDocuments → no listIds (reconcile degrades to heal-only).
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    expect((await tryBuildMemoryVectorSink(cfg()))!.listIds).toBeUndefined()

    // With scrollDocuments → pages until hasMore is false.
    const scrollDocuments = jest
      .fn()
      .mockResolvedValueOnce({ documents: [{ id: "a" }, { id: "b" }], hasMore: true })
      .mockResolvedValueOnce({ documents: [{ id: "c" }], hasMore: false })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments, scrollDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const sink = await tryBuildMemoryVectorSink(cfg())
    await expect(sink!.listIds!()).resolves.toEqual(["a", "b", "c"])
    expect(scrollDocuments).toHaveBeenNthCalledWith(1, MEMORY_VECTOR_COLLECTION, {
      offset: 0,
      limit: 500,
    })
    expect(scrollDocuments).toHaveBeenNthCalledWith(2, MEMORY_VECTOR_COLLECTION, {
      offset: 2,
      limit: 500,
    })
  })

  it("returns undefined when hybridEnabled is off", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments: jest.fn() },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    expect(await tryBuildMemoryVectorSink(cfg({ hybridEnabled: false }))).toBeUndefined()
  })

  it("respects the cloud-embedding privacy gate", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments: jest.fn() },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    expect(await tryBuildMemoryVectorSink(cfg({ allowCloudEmbedding: false }))).toBeUndefined()
    expect(await tryBuildMemoryVectorSink(cfg({ allowCloudEmbedding: true }))).toBeDefined()
  })
})

describe("describeMemoryRetrievalMode", () => {
  it("reports `off` rather than a degradation when memory is not running", async () => {
    await expect(describeMemoryRetrievalMode(cfg({ enabled: false }))).resolves.toEqual({
      kind: "off",
      reason: "disabled",
    })
    await expect(describeMemoryRetrievalMode(cfg({ temporary: true }))).resolves.toEqual({
      kind: "off",
      reason: "temporary",
    })
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })

  it("reports hybrid_disabled without even consulting the backend", async () => {
    await expect(describeMemoryRetrievalMode(cfg({ hybridEnabled: false }))).resolves.toEqual({
      kind: "bm25",
      reason: "hybrid_disabled",
    })
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })

  it("reports no_backend when twin embeddings were never configured", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "no_backend",
    })
  })

  it("reports store_unsupported when the vector store cannot search by embedding", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: {},
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "store_unsupported",
      provider: "transformersjs",
    })
  })

  it("reports cloud_blocked — the default state for a cloud embedder", async () => {
    // hybridEnabled defaults to true and allowCloudEmbedding defaults to false,
    // so anyone whose twin embedder is cloud-hosted silently gets keyword-only
    // recall while the config claims hybrid. This is the case the alert exists for.
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "cloud_blocked",
      provider: "openai",
    })
  })

  it("reports hybrid once every gate passes", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "hybrid",
      provider: "transformersjs",
    })
  })

  it("never throws — a backend explosion reads as no_backend", async () => {
    mockTryBuildTwinDeps.mockRejectedValue(new Error("boom"))
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "no_backend",
    })
  })

  it("agrees with tryBuildMemoryDeps about whether the vector leg attached", async () => {
    // The probe and the runtime share `resolveMemoryBackendOutcome`; this pins
    // that they can never disagree about a given configuration.
    for (const embedding of [
      { provider: "transformersjs", model: "x", apiKey: "" },
      { provider: "openai", model: "x", apiKey: "k" },
    ]) {
      mockTryBuildTwinDeps.mockResolvedValue({
        store: { searchByEmbedding: mockSearchByEmbedding },
        embedding,
      })
      const config = cfg()
      const mode = await describeMemoryRetrievalMode(config)
      const deps = await tryBuildMemoryDeps(config)
      expect(mode.kind === "hybrid").toBe(deps?.vectorSearch !== undefined)
    }
  })
})
