jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: jest.fn(),
}))

import { tryBuildProjectKnowledgeDeps } from "./build-deps"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"

const twinMock = tryBuildTwinDeps as jest.Mock

function twinDeps(overrides: Record<string, unknown> = {}) {
  return {
    store: { provider: "qdrant", addDocuments: jest.fn(), searchByEmbedding: jest.fn() },
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "k", baseURL: "u" },
    vectorBackend: "qdrant",
    reranker: { model: "lexical" },
    expansion: { strategy: "hyde" },
    ...overrides,
  }
}

beforeEach(() => twinMock.mockReset())

describe("tryBuildProjectKnowledgeDeps", () => {
  it("returns undefined when no twin deps are configured", async () => {
    twinMock.mockResolvedValue(undefined)
    expect(await tryBuildProjectKnowledgeDeps()).toBeUndefined()
  })

  it("returns undefined when the store can't ingest (no addDocuments)", async () => {
    twinMock.mockResolvedValue(
      twinDeps({ store: { provider: "native", searchByEmbedding: jest.fn() } })
    )
    expect(await tryBuildProjectKnowledgeDeps()).toBeUndefined()
  })

  it("maps twin deps into project-knowledge deps", async () => {
    twinMock.mockResolvedValue(twinDeps())
    const deps = await tryBuildProjectKnowledgeDeps()
    expect(deps).toBeDefined()
    expect(deps?.vectorBackend).toBe("qdrant")
    expect(deps?.embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "k",
      baseURL: "u",
    })
    expect(deps?.reranker).toEqual({ model: "lexical" })
    expect(deps?.expansion).toEqual({ strategy: "hyde" })
  })

  it("falls back to store.provider when vectorBackend is absent", async () => {
    twinMock.mockResolvedValue(twinDeps({ vectorBackend: undefined }))
    const deps = await tryBuildProjectKnowledgeDeps()
    expect(deps?.vectorBackend).toBe("qdrant")
  })

  it("reuses prebuilt twin deps without calling tryBuildTwinDeps", async () => {
    const deps = await tryBuildProjectKnowledgeDeps(twinDeps() as never)
    expect(deps).toBeDefined()
    expect(twinMock).not.toHaveBeenCalled()
  })

  it("returns undefined when the resolver throws", async () => {
    twinMock.mockRejectedValue(new Error("boom"))
    expect(await tryBuildProjectKnowledgeDeps()).toBeUndefined()
  })
})
