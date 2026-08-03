import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  buildOcrCacheId,
  clearOcrCache,
  clearOcrCacheForProvider,
  decodeOcrResult,
  deleteOcrCacheRow,
  encodeOcrResult,
  getOcrCacheRow,
  ocrCacheStats,
  purgeOcrCacheOlderThan,
  putOcrCacheRow,
  type OcrResultRow,
} from "./ocr-results"
import type { OcrResult } from "@/types/ocr"

const sampleResult: OcrResult = {
  providerId: "mistral-ocr",
  pages: [{ pageNumber: 1, markdown: "# hello", text: "hello" }],
  combinedMarkdown: "# hello",
  combinedText: "hello",
  languages: ["en"],
  durationMs: 42,
  cached: false,
}

function makeRow(overrides: Partial<OcrResultRow> = {}): OcrResultRow {
  const fileSha = overrides.fileSha ?? "abc123"
  const providerId = overrides.providerId ?? "mistral-ocr"
  const langs = overrides.langs ?? "en"
  return {
    id: overrides.id ?? buildOcrCacheId(fileSha, providerId, langs ? langs.split(",") : []),
    fileSha,
    providerId,
    langs,
    result: overrides.result ?? encodeOcrResult(sampleResult),
    createdAt: overrides.createdAt ?? Date.now(),
    bytesIn: overrides.bytesIn ?? 1024,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("buildOcrCacheId", () => {
  it("lowercases and sorts languages", () => {
    expect(buildOcrCacheId("sha", "p", ["EN", "zh"])).toBe("sha|p|en,zh")
    expect(buildOcrCacheId("sha", "p", ["zh", "EN"])).toBe("sha|p|en,zh")
  })

  it("renders an empty language slice as an empty trailing segment", () => {
    expect(buildOcrCacheId("sha", "p", [])).toBe("sha|p|")
    expect(buildOcrCacheId("sha", "p", undefined)).toBe("sha|p|")
  })
})

describe("encode/decode round-trip", () => {
  it("flips cached:false on encode and cached:true on decode", () => {
    const encoded = encodeOcrResult({ ...sampleResult, cached: true })
    const parsed = JSON.parse(encoded) as OcrResult
    expect(parsed.cached).toBe(false)
    const decoded = decodeOcrResult(encoded)
    expect(decoded?.cached).toBe(true)
    expect(decoded?.combinedMarkdown).toBe("# hello")
  })

  it("returns null on malformed input", () => {
    expect(decodeOcrResult("not json")).toBeNull()
  })
})

describe("Dexie table operations", () => {
  it("getOcrCacheRow returns null for missing rows", async () => {
    expect(await getOcrCacheRow("nope")).toBeNull()
  })

  it("put + get round-trips a row", async () => {
    const row = makeRow()
    await putOcrCacheRow(row)
    const fetched = await getOcrCacheRow(row.id)
    expect(fetched).not.toBeNull()
    expect(fetched?.providerId).toBe("mistral-ocr")
    expect(fetched?.fileSha).toBe("abc123")
  })

  it("deleteOcrCacheRow removes the entry", async () => {
    const row = makeRow()
    await putOcrCacheRow(row)
    await deleteOcrCacheRow(row.id)
    expect(await getOcrCacheRow(row.id)).toBeNull()
  })

  it("clearOcrCache returns the prior row count and empties the table", async () => {
    await putOcrCacheRow(makeRow({ id: "a" }))
    await putOcrCacheRow(makeRow({ id: "b" }))
    expect(await clearOcrCache()).toBe(2)
    expect(await getDb().ocrResults.count()).toBe(0)
  })

  it("clearOcrCacheForProvider only deletes rows for that provider", async () => {
    await putOcrCacheRow(makeRow({ id: "m1", providerId: "mistral-ocr" }))
    await putOcrCacheRow(makeRow({ id: "m2", providerId: "mistral-ocr" }))
    await putOcrCacheRow(makeRow({ id: "g1", providerId: "google-vision" }))
    expect(await clearOcrCacheForProvider("mistral-ocr")).toBe(2)
    expect(await getDb().ocrResults.count()).toBe(1)
    expect((await getOcrCacheRow("g1"))?.providerId).toBe("google-vision")
  })

  it("clearOcrCacheForProvider returns 0 when no rows match", async () => {
    expect(await clearOcrCacheForProvider("missing")).toBe(0)
  })

  it("purgeOcrCacheOlderThan removes rows older than the TTL", async () => {
    const now = 1_700_000_000_000
    await putOcrCacheRow(makeRow({ id: "old", createdAt: now - 1_000_000 }))
    await putOcrCacheRow(makeRow({ id: "fresh", createdAt: now - 1_000 }))
    const removed = await purgeOcrCacheOlderThan(500_000, now)
    expect(removed).toBe(1)
    expect(await getOcrCacheRow("old")).toBeNull()
    expect(await getOcrCacheRow("fresh")).not.toBeNull()
  })

  it("purgeOcrCacheOlderThan with a non-positive TTL is a no-op", async () => {
    await putOcrCacheRow(makeRow({ id: "a", createdAt: 1 }))
    expect(await purgeOcrCacheOlderThan(0)).toBe(0)
    expect(await purgeOcrCacheOlderThan(-1)).toBe(0)
    expect(await purgeOcrCacheOlderThan(Number.NaN)).toBe(0)
    expect(await getOcrCacheRow("a")).not.toBeNull()
  })

  it("purgeOcrCacheOlderThan returns 0 when nothing is stale", async () => {
    const now = 1_700_000_000_000
    await putOcrCacheRow(makeRow({ id: "fresh", createdAt: now }))
    expect(await purgeOcrCacheOlderThan(100, now)).toBe(0)
  })

  it("ocrCacheStats aggregates count and bytes", async () => {
    await putOcrCacheRow(makeRow({ id: "a", bytesIn: 100 }))
    await putOcrCacheRow(makeRow({ id: "b", bytesIn: 250 }))
    const stats = await ocrCacheStats()
    expect(stats).toEqual({ count: 2, bytes: 350 })
  })
})
