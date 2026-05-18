import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { readCachedResult, writeCachedResult } from "./cache"
import type { OcrResult } from "./types"

const sample: OcrResult = {
  providerId: "mistral-ocr",
  pages: [{ pageNumber: 1, markdown: "# hello", text: "hello" }],
  combinedMarkdown: "# hello",
  combinedText: "hello",
  languages: ["en"],
  durationMs: 0,
  cached: false,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

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
