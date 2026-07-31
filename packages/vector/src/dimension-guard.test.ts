import {
  assertDimensionCompatible,
  ensureCollectionDimensionCompatible,
  EmbeddingDimensionMismatchError,
} from "./dimension-guard"

describe("assertDimensionCompatible", () => {
  it("no-ops when dimensions match", () => {
    expect(() =>
      assertDimensionCompatible({ collection: "c", existing: 1536, actual: 1536 })
    ).not.toThrow()
  })

  it("no-ops when either dimension is unknown", () => {
    expect(() =>
      assertDimensionCompatible({ collection: "c", existing: undefined, actual: 768 })
    ).not.toThrow()
    expect(() =>
      assertDimensionCompatible({ collection: "c", existing: 1024, actual: null })
    ).not.toThrow()
  })

  it("throws an actionable error on mismatch", () => {
    expect(() =>
      assertDimensionCompatible({
        collection: "cognia_twin_x",
        existing: 1536,
        actual: 768,
        provider: "google",
        model: "text-embedding-004",
      })
    ).toThrow(EmbeddingDimensionMismatchError)

    try {
      assertDimensionCompatible({ collection: "cognia_twin_x", existing: 1536, actual: 768 })
    } catch (err) {
      const e = err as EmbeddingDimensionMismatchError
      expect(e.existing).toBe(1536)
      expect(e.actual).toBe(768)
      expect(e.message).toContain("1536")
      expect(e.message).toContain("768")
      expect(e.message).toContain("cognia_twin_x")
    }
  })
})

describe("ensureCollectionDimensionCompatible", () => {
  const makeStore = (info: { dimension?: number } | Error) => ({
    getCollectionInfo: jest.fn(async () => {
      if (info instanceof Error) throw info
      return info as never
    }),
  })

  it("no-ops when actual dimension is unknown (no embedding yet)", async () => {
    const store = makeStore({ dimension: 768 })
    await expect(
      ensureCollectionDimensionCompatible(store, "c", undefined)
    ).resolves.toBeUndefined()
    expect(store.getCollectionInfo).not.toHaveBeenCalled()
  })

  it("no-ops when the collection does not exist yet", async () => {
    const store = makeStore(new Error("collection not found"))
    await expect(ensureCollectionDimensionCompatible(store, "c", 1536)).resolves.toBeUndefined()
  })

  it("no-ops when the stored dimension is absent", async () => {
    const store = makeStore({ dimension: undefined })
    await expect(ensureCollectionDimensionCompatible(store, "c", 1536)).resolves.toBeUndefined()
  })

  it("passes through context to the thrown error", async () => {
    const store = makeStore({ dimension: 1024 })
    await expect(
      ensureCollectionDimensionCompatible(store, "cognia_twin_y", 1536, {
        provider: "openai",
        model: "text-embedding-3-small",
      })
    ).rejects.toMatchObject({
      name: "EmbeddingDimensionMismatchError",
      existing: 1024,
      actual: 1536,
      provider: "openai",
      model: "text-embedding-3-small",
    })
  })

  it("resolves when dimensions match", async () => {
    const store = makeStore({ dimension: 1536 })
    await expect(ensureCollectionDimensionCompatible(store, "c", 1536)).resolves.toBeUndefined()
  })
})
