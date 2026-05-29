/**
 * Coverage for the per-twin BM25 index cache. Uses fake-indexeddb so the
 * cache's version-signal rebuild path runs against the real Dexie indexes.
 */

import "fake-indexeddb/auto"
import { keywordSearch, __resetTwinBm25Cache } from "./bm25-index"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { bulkCreateTwinChunks, deleteTwinChunksBySource } from "@/lib/db/twin-chunks"

function chunk(twinId: string, sourceId: string, vectorDocId: string, content: string) {
  return {
    twinId,
    sourceId,
    content,
    contentRedacted: content,
    charStart: 0,
    charEnd: content.length,
    vectorBackend: "qdrant" as const,
    vectorCollection: `cognia_twin_${twinId}`,
    vectorDocId,
    strategy: "paragraph" as const,
    tokenCount: 10,
    metadata: {},
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().twinChunks.clear()
  __resetTwinBm25Cache()
})

describe("keywordSearch", () => {
  it("returns empty for a blank query or non-positive limit", async () => {
    await bulkCreateTwinChunks([chunk("twin_a", "s1", "v1", "alpha beta gamma")])
    expect(await keywordSearch("twin_a", "   ", 5)).toEqual([])
    expect(await keywordSearch("twin_a", "alpha", 0)).toEqual([])
  })

  it("returns empty when the twin has no chunks", async () => {
    expect(await keywordSearch("twin_empty", "anything", 5)).toEqual([])
  })

  it("ranks the chunk whose text matches the query terms first, keyed by vectorDocId", async () => {
    await bulkCreateTwinChunks([
      chunk("twin_a", "s1", "v_payroll", "quarterly payroll reconciliation spreadsheet"),
      chunk("twin_a", "s1", "v_login", "how to reset the VPN password and login token"),
      chunk("twin_a", "s1", "v_misc", "lunch menu options for the offsite"),
    ])
    const hits = await keywordSearch("twin_a", "reset my login password", 3)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].id).toBe("v_login")
    expect(hits[0].score).toBeGreaterThan(0)
  })

  it("isolates per twin — never returns another twin's chunks", async () => {
    await bulkCreateTwinChunks([
      chunk("twin_a", "s1", "a1", "shared keyword apple"),
      chunk("twin_b", "s2", "b1", "shared keyword apple"),
    ])
    const hits = await keywordSearch("twin_a", "apple", 5)
    expect(hits.map((h) => h.id)).toEqual(["a1"])
  })

  it("rebuilds the cached index when the corpus changes", async () => {
    await bulkCreateTwinChunks([chunk("twin_a", "s1", "v1", "original needle term")])
    expect((await keywordSearch("twin_a", "needle", 5)).map((h) => h.id)).toEqual(["v1"])

    // Add a more relevant chunk; the version signal (count) changes → rebuild.
    await bulkCreateTwinChunks([chunk("twin_a", "s2", "v2", "needle needle needle stronger")])
    const after = await keywordSearch("twin_a", "needle", 5)
    expect(after.map((h) => h.id).sort()).toEqual(["v1", "v2"])

    // Remove the original source; rebuild again and v1 drops out.
    await deleteTwinChunksBySource("s1")
    const final = await keywordSearch("twin_a", "needle", 5)
    expect(final.map((h) => h.id)).toEqual(["v2"])
  })
})
