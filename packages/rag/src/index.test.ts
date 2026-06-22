import { LRUCache, createEmptyRAGSearchMetadata, detectCJKLanguage, isCJKText } from "./index"

describe("rag package barrel", () => {
  it("re-exports cache utilities", () => {
    const cache = new LRUCache<string>(2, 1000)
    cache.set("q:a", "answer", "docs")

    expect(cache.get("q:a")).toBe("answer")
    expect(cache.getStats()).toMatchObject({ hits: 1, size: 1, maxSize: 2 })
  })

  it("re-exports retrieval metadata and tokenizer helpers", () => {
    expect(createEmptyRAGSearchMetadata({ finalResultCount: 2 })).toMatchObject({
      hybridSearchUsed: false,
      finalResultCount: 2,
    })
    expect(isCJKText("你好 world")).toBe(true)
    expect(detectCJKLanguage("你好")).toBe("chinese")
  })
})
