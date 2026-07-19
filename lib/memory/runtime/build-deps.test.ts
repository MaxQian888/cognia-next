import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"

const mockTryBuildTwinDeps = jest.fn()
const mockGenerateEmbedding = jest.fn()
const mockSearchByEmbedding = jest.fn()

jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: () => mockTryBuildTwinDeps(),
}))
jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}))
jest.mock("@/lib/db/memories", () => ({
  listActiveForReader: jest.fn(async () => [{ id: "c1" }]),
  listActiveProcedural: jest.fn(async () => [{ id: "p1" }]),
  touchMemories: jest.fn(async () => undefined),
}))

import {
  tryBuildMemoryDeps,
  tryBuildMemoryVectorSink,
  MEMORY_VECTOR_COLLECTION,
} from "./build-deps"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSearchByEmbedding.mockResolvedValue([{ id: "v1", content: "x", score: 0.7 }])
  mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] })
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
