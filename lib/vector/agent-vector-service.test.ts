import type { IVectorStore } from "@cognia/vector/store"
import {
  VectorServiceError,
  createAgentVectorService,
  type AgentVectorEmbeddingConfig,
} from "./agent-vector-service"

const EMBEDDING: AgentVectorEmbeddingConfig = {
  embeddingConfig: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
  embeddingApiKey: "sk-test",
}

/** Minimal in-memory `IVectorStore` double covering the surface the service uses. */
function makeStore(seed: Record<string, { dimension?: number; docs: string[] }> = {}) {
  const collections = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v }]))
  const calls = {
    createCollection: [] as Array<{ name: string; options?: Record<string, unknown> }>,
    addDocuments: [] as Array<{ collection: string; ids: string[] }>,
    deleteDocuments: [] as Array<{ collection: string; ids: string[] }>,
    searchDocuments: [] as Array<{ collection: string; query: string; options?: unknown }>,
  }
  const store: Partial<IVectorStore> = {
    async getCollectionInfo(name) {
      const c = collections.get(name)
      if (!c) throw new Error(`collection not found: ${name}`)
      return {
        name,
        documentCount: c.docs.length,
        dimension: c.dimension,
      } as Awaited<ReturnType<IVectorStore["getCollectionInfo"]>>
    },
    async createCollection(name, options) {
      calls.createCollection.push({ name, options: options as Record<string, unknown> })
      collections.set(name, { dimension: options?.dimension, docs: [] })
    },
    async addDocuments(collection, documents) {
      calls.addDocuments.push({ collection, ids: documents.map((d) => d.id) })
      const c = collections.get(collection)
      if (!c) throw new Error("missing collection")
      for (const doc of documents) if (!c.docs.includes(doc.id)) c.docs.push(doc.id)
    },
    async deleteDocuments(collection, ids) {
      calls.deleteDocuments.push({ collection, ids })
      const c = collections.get(collection)
      if (c) c.docs = c.docs.filter((id) => !ids.includes(id))
    },
    async getDocuments(collection, ids) {
      const c = collections.get(collection)
      if (!c) return []
      return c.docs
        .filter((id) => ids.includes(id))
        .map((id) => ({ id, content: `content-${id}`, metadata: {} }))
    },
    async searchDocuments(collection, query, options) {
      calls.searchDocuments.push({ collection, query, options })
      const c = collections.get(collection)
      if (!c) throw new Error("missing collection")
      return c.docs.map((id, i) => ({
        id,
        content: `content-${id}`,
        score: 1 - i * 0.1,
        metadata: { seq: i },
      }))
    },
  }
  return { store: store as IVectorStore, calls, collections }
}

function makeService(
  overrides: {
    isTauri?: boolean
    embedding?: AgentVectorEmbeddingConfig | null
    seed?: Record<string, { dimension?: number; docs: string[] }>
  } = {}
) {
  const fixture = makeStore(overrides.seed)
  const service = createAgentVectorService({
    isTauri: () => overrides.isTauri ?? true,
    resolveEmbedding: () => (overrides.embedding === undefined ? EMBEDDING : overrides.embedding),
    createStore: () => fixture.store,
  })
  return { service, ...fixture }
}

describe("platform + configuration gating", () => {
  it("refuses outside Tauri with unsupported-platform", async () => {
    const { service } = makeService({ isTauri: false })
    await expect(service.search("project_p1__documents", "q")).rejects.toMatchObject({
      name: "VectorServiceError",
      code: "unsupported-platform",
    })
  })

  it("refuses every operation outside Tauri", async () => {
    const { service } = makeService({ isTauri: false })
    await expect(service.addDocument("c", { id: "1", content: "x" })).rejects.toMatchObject({
      code: "unsupported-platform",
    })
    await expect(service.deleteDocument("c", "1")).rejects.toMatchObject({
      code: "unsupported-platform",
    })
  })

  it("refuses when no embedding provider is configured", async () => {
    const { service } = makeService({ embedding: null })
    await expect(service.search("c", "q")).rejects.toMatchObject({
      code: "embedding-not-configured",
    })
  })

  it("never constructs a cloud store — the injected factory is the only store", async () => {
    const createStore = jest.fn(() => makeStore().store)
    const service = createAgentVectorService({
      isTauri: () => true,
      resolveEmbedding: () => EMBEDDING,
      createStore,
    })
    await service.search("c", "q")
    await service.search("c", "q")
    // Memoised: one store per service instance.
    expect(createStore).toHaveBeenCalledTimes(1)
    expect(createStore).toHaveBeenCalledWith(EMBEDDING)
  })
})

describe("search", () => {
  it("returns an empty result for a missing collection without searching", async () => {
    const { service, calls } = makeService()
    await expect(service.search("project_p1__documents", "q")).resolves.toEqual([])
    expect(calls.searchDocuments).toHaveLength(0)
  })

  it("maps hits to id/content/score/metadata", async () => {
    const { service } = makeService({
      seed: { project_p1__documents: { dimension: 1536, docs: ["a", "b"] } },
    })
    await expect(service.search("project_p1__documents", "q")).resolves.toEqual([
      { id: "a", content: "content-a", score: 1, metadata: { seq: 0 } },
      { id: "b", content: "content-b", score: 0.9, metadata: { seq: 1 } },
    ])
  })

  it("defaults topK to 5 and forwards threshold and filters", async () => {
    const { service, calls } = makeService({
      seed: { c: { dimension: 1536, docs: ["a"] } },
    })
    await service.search("c", "q")
    expect(calls.searchDocuments[0].options).toEqual({ topK: 5 })

    await service.search("c", "q", {
      topK: 10,
      threshold: 0.7,
      filters: [{ key: "kind", value: "note", operation: "equals" }],
    })
    expect(calls.searchDocuments[1].options).toEqual({
      topK: 10,
      threshold: 0.7,
      filters: [{ key: "kind", value: "note", operation: "equals" }],
    })
  })

  it("omits empty filter arrays", async () => {
    const { service, calls } = makeService({ seed: { c: { docs: ["a"] } } })
    await service.search("c", "q", { filters: [] })
    expect(calls.searchDocuments[0].options).toEqual({ topK: 5 })
  })

  it("wraps a store failure as store-error", async () => {
    const { service, store } = makeService({ seed: { c: { docs: ["a"] } } })
    jest.spyOn(store, "searchDocuments").mockRejectedValue(new Error("sqlite exploded"))
    await expect(service.search("c", "q")).rejects.toMatchObject({
      code: "store-error",
      message: "sqlite exploded",
    })
  })

  it("cancels before the store is touched when the signal is already aborted", async () => {
    const { service, calls } = makeService({ seed: { c: { docs: ["a"] } } })
    await expect(service.search("c", "q", { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "cancelled",
    })
    expect(calls.searchDocuments).toHaveLength(0)
  })

  it("cancels between the existence probe and the search", async () => {
    const controller = new AbortController()
    const { service, store, calls } = makeService({ seed: { c: { docs: ["a"] } } })
    jest.spyOn(store, "getCollectionInfo").mockImplementation(async () => {
      controller.abort()
      return { name: "c", documentCount: 1 } as Awaited<
        ReturnType<IVectorStore["getCollectionInfo"]>
      >
    })
    await expect(service.search("c", "q", { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
    expect(calls.searchDocuments).toHaveLength(0)
  })
})

describe("addDocument", () => {
  it("lazily creates the collection at the configured dimensions", async () => {
    const { service, calls } = makeService()
    await expect(
      service.addDocument("project_p1__documents", { id: "d1", content: "hello" })
    ).resolves.toEqual({ id: "d1", createdCollection: true })
    expect(calls.createCollection).toEqual([
      {
        name: "project_p1__documents",
        options: {
          dimension: 1536,
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
        },
      },
    ])
    expect(calls.addDocuments).toEqual([{ collection: "project_p1__documents", ids: ["d1"] }])
  })

  it("omits the dimension when the embedding config has none", async () => {
    const service = createAgentVectorService({
      isTauri: () => true,
      resolveEmbedding: () => ({
        embeddingConfig: { provider: "openai", model: "m" },
        embeddingApiKey: "k",
      }),
      createStore: () => makeStore().store,
    })
    await expect(service.addDocument("c", { id: "d", content: "x" })).resolves.toMatchObject({
      createdCollection: true,
    })
  })

  it("does not recreate an existing collection", async () => {
    const { service, calls } = makeService({ seed: { c: { dimension: 1536, docs: [] } } })
    await expect(service.addDocument("c", { id: "d1", content: "x" })).resolves.toEqual({
      id: "d1",
      createdCollection: false,
    })
    expect(calls.createCollection).toHaveLength(0)
  })

  it("forwards metadata when supplied", async () => {
    const { service, store } = makeService()
    const spy = jest.spyOn(store, "addDocuments")
    await service.addDocument("c", { id: "d", content: "x", metadata: { kind: "note" } })
    expect(spy).toHaveBeenCalledWith("c", [{ id: "d", content: "x", metadata: { kind: "note" } }])
  })

  it("omits the metadata key entirely when not supplied", async () => {
    const { service, store } = makeService()
    const spy = jest.spyOn(store, "addDocuments")
    await service.addDocument("c", { id: "d", content: "x" })
    expect(spy).toHaveBeenCalledWith("c", [{ id: "d", content: "x" }])
  })

  it("refuses to write into a collection built at a different dimension", async () => {
    const { service, calls } = makeService({ seed: { c: { dimension: 768, docs: [] } } })
    await expect(service.addDocument("c", { id: "d", content: "x" })).rejects.toMatchObject({
      code: "dimension-mismatch",
    })
    expect(calls.addDocuments).toHaveLength(0)
  })

  it("wraps a store failure as store-error", async () => {
    const { service, store } = makeService({ seed: { c: { dimension: 1536, docs: [] } } })
    jest.spyOn(store, "addDocuments").mockRejectedValue(new Error("disk full"))
    await expect(service.addDocument("c", { id: "d", content: "x" })).rejects.toMatchObject({
      code: "store-error",
      message: "disk full",
    })
  })

  it("honours cancellation before writing", async () => {
    const { service, calls } = makeService()
    await expect(
      service.addDocument("c", { id: "d", content: "x", signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(calls.addDocuments).toHaveLength(0)
  })
})

describe("deleteDocument", () => {
  it("returns deleted:false for a missing collection", async () => {
    const { service, calls } = makeService()
    await expect(service.deleteDocument("project_p1__documents", "d1")).resolves.toEqual({
      deleted: false,
    })
    expect(calls.deleteDocuments).toHaveLength(0)
  })

  it("returns deleted:false for a missing document in an existing collection", async () => {
    const { service, calls } = makeService({ seed: { c: { docs: ["other"] } } })
    await expect(service.deleteDocument("c", "d1")).resolves.toEqual({ deleted: false })
    expect(calls.deleteDocuments).toHaveLength(0)
  })

  it("deletes an existing document", async () => {
    const { service, calls, collections } = makeService({ seed: { c: { docs: ["d1", "d2"] } } })
    await expect(service.deleteDocument("c", "d1")).resolves.toEqual({ deleted: true })
    expect(calls.deleteDocuments).toEqual([{ collection: "c", ids: ["d1"] }])
    expect(collections.get("c")?.docs).toEqual(["d2"])
  })

  it("wraps a store failure as store-error", async () => {
    const { service, store } = makeService({ seed: { c: { docs: ["d1"] } } })
    jest.spyOn(store, "deleteDocuments").mockRejectedValue(new Error("locked"))
    await expect(service.deleteDocument("c", "d1")).rejects.toMatchObject({
      code: "store-error",
      message: "locked",
    })
  })

  it("honours cancellation", async () => {
    const { service, calls } = makeService({ seed: { c: { docs: ["d1"] } } })
    await expect(
      service.deleteDocument("c", "d1", { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(calls.deleteDocuments).toHaveLength(0)
  })

  it("cancels after the existence probe but before deleting", async () => {
    const controller = new AbortController()
    const { service, store, calls } = makeService({ seed: { c: { docs: ["d1"] } } })
    jest.spyOn(store, "getDocuments").mockImplementation(async () => {
      controller.abort()
      return [{ id: "d1", content: "x", metadata: {} }]
    })
    await expect(
      service.deleteDocument("c", "d1", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "cancelled" })
    expect(calls.deleteDocuments).toHaveLength(0)
  })
})

describe("VectorServiceError", () => {
  it("carries the code and a readable name", () => {
    const err = new VectorServiceError("store-error", "boom")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("VectorServiceError")
    expect(err.code).toBe("store-error")
    expect(err.message).toBe("boom")
  })
})
