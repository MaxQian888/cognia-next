import { createNullOcrCache, createNullOcrPageCache } from "./cache-contract"
import type { OcrPage, OcrResult } from "./types"

const key = { fileSha: "sha", providerId: "mock", languages: ["en"] }

const result: OcrResult = {
  providerId: "mock",
  pages: [{ pageNumber: 1, markdown: "# p1", text: "p1" }],
  combinedMarkdown: "# p1",
  combinedText: "p1",
  languages: ["en"],
  durationMs: 1,
  cached: false,
}

describe("createNullOcrCache", () => {
  it("always misses on read", async () => {
    await expect(createNullOcrCache().read(key)).resolves.toBeNull()
  })

  it("accepts a write without persisting it", async () => {
    const cache = createNullOcrCache()
    await expect(cache.write({ ...key, result, bytesIn: 10 })).resolves.toBeUndefined()
    // The write must not become readable — that is the whole point of the null cache.
    await expect(cache.read(key)).resolves.toBeNull()
  })
})

describe("createNullOcrPageCache", () => {
  const pageKey = { ...key, pageNumber: 1 }
  const page: OcrPage = { pageNumber: 1, markdown: "# p1", text: "p1" }

  it("always misses on read", async () => {
    await expect(createNullOcrPageCache().read(pageKey)).resolves.toBeNull()
  })

  it("accepts a write without persisting it", async () => {
    const cache = createNullOcrPageCache()
    await expect(cache.write(pageKey, page)).resolves.toBeUndefined()
    await expect(cache.write(pageKey, page, 42)).resolves.toBeUndefined()
    await expect(cache.read(pageKey)).resolves.toBeNull()
  })
})
