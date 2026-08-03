import { createDbTestFixture } from "@/lib/db/test-fixture"
import { readCachedPage, readCachedResult, writeCachedPage, writeCachedResult } from "./cache"
import type { OcrPage, OcrResult } from "@/types/ocr"

const sample: OcrResult = {
  providerId: "mistral-ocr",
  pages: [{ pageNumber: 1, markdown: "# hello", text: "hello" }],
  combinedMarkdown: "# hello",
  combinedText: "hello",
  languages: ["en"],
  durationMs: 0,
  cached: false,
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

afterAll(dbFixture.dispose)

describe("cache read/write", () => {
  it("readCachedResult returns null when the row is missing", async () => {
    const out = await readCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["en"],
    })
    expect(out).toBeNull()
  })

  it("write then read returns the result with cached:true", async () => {
    await writeCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["en"],
      result: sample,
      bytesIn: 1024,
    })
    const out = await readCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["en"],
    })
    expect(out).not.toBeNull()
    expect(out?.cached).toBe(true)
    expect(out?.combinedMarkdown).toBe("# hello")
  })

  it("the cache key is independent of language order/case", async () => {
    await writeCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["EN", "zh"],
      result: sample,
      bytesIn: 1024,
    })
    const swapped = await readCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["zh", "en"],
    })
    expect(swapped).not.toBeNull()
    expect(swapped?.cached).toBe(true)
  })

  it("write overwrites a previous entry under the same key", async () => {
    await writeCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["en"],
      result: { ...sample, combinedMarkdown: "v1" },
      bytesIn: 100,
    })
    await writeCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["en"],
      result: { ...sample, combinedMarkdown: "v2" },
      bytesIn: 200,
    })
    const out = await readCachedResult({
      fileSha: "abc",
      providerId: "mistral-ocr",
      languages: ["en"],
    })
    expect(out?.combinedMarkdown).toBe("v2")
  })
})

describe("per-page cache (2e)", () => {
  const page: OcrPage = { pageNumber: 3, markdown: "# p3", text: "page three", fromTextLayer: true }
  const key = { fileSha: "doc-sha", providerId: "ocrs", languages: ["en"], pageNumber: 3 }

  it("returns null for an unprocessed page", async () => {
    expect(await readCachedPage(key)).toBeNull()
  })

  it("round-trips a single page and keeps pages independent of the whole-doc row", async () => {
    await writeCachedPage(key, page)
    expect(await readCachedPage(key)).toEqual(page)
    // a different page number is a separate entry.
    expect(await readCachedPage({ ...key, pageNumber: 4 })).toBeNull()
    // the per-page row doesn't satisfy a whole-document lookup.
    expect(
      await readCachedResult({ fileSha: "doc-sha", providerId: "ocrs", languages: ["en"] })
    ).toBeNull()
  })
})
