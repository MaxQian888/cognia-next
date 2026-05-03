import type { TwinRuntimeSettings } from "@/types/twin"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import { tryBuildTwinDeps } from "./build-deps"

jest.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: jest.fn(),
}))

jest.mock("@/lib/vector/store", () => ({
  createVectorStore: jest.fn().mockReturnValue({ provider: "qdrant" }),
}))

const { getTwinRuntimeSettings } = jest.requireMock("@/lib/db/twin-runtime-settings")
const { createVectorStore } = jest.requireMock("@/lib/vector/store")

function settings(patch: Partial<TwinRuntimeSettings> = {}): TwinRuntimeSettings {
  return {
    ...DEFAULT_TWIN_RUNTIME_SETTINGS,
    workerEnabled: true,
    embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "k" },
    ...patch,
  }
}

describe("tryBuildTwinDeps", () => {
  beforeEach(() => jest.resetAllMocks())

  it("returns undefined when worker is disabled", async () => {
    getTwinRuntimeSettings.mockResolvedValue(settings({ workerEnabled: false }))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("returns undefined when embedding apiKey is missing", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "" } })
    )
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("builds qdrant deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } } })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps).toBeDefined()
    expect(deps?.vectorBackend).toBe("qdrant")
    expect(createVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "qdrant", qdrantUrl: "http://q" })
    )
  })

  it("builds pinecone deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "pinecone", pinecone: { apiKey: "p", indexName: "idx" } },
      })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("pinecone")
  })

  it("builds weaviate deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "weaviate", weaviate: { url: "http://w" } } })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("weaviate")
  })

  it("builds milvus deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "milvus", milvus: { address: "localhost:19530" } } })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("milvus")
  })

  it("builds chroma deps in embedded mode", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "chroma", chroma: { mode: "embedded" } } })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("chroma")
  })

  it("builds native deps without further config", async () => {
    getTwinRuntimeSettings.mockResolvedValue(settings({ storage: { vectorBackend: "native" } }))
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("native")
  })

  it("returns undefined when qdrant url is missing", async () => {
    getTwinRuntimeSettings.mockResolvedValue(settings({ storage: { vectorBackend: "qdrant" } }))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("returns undefined on any thrown error", async () => {
    getTwinRuntimeSettings.mockRejectedValue(new Error("boom"))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })
})
