/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  OPEN_VSX_CACHE_MAX_PAYLOAD_BYTES,
  OPEN_VSX_CACHE_MAX_ROWS,
  OPEN_VSX_CACHE_TTL_MS,
  cacheRowFromQueryEntry,
  cacheRowFromSearchEntry,
  getCached,
  isStale,
  pruneStale,
  putCached,
} from "./openvsx-cache"
import { getDb } from "@/lib/db/schema"
import type { OpenVsxCacheRow } from "@/types/plugin/vscode-extension-cache"
import type { OpenVsxQueryEntry, OpenVsxSearchEntry } from "./openvsx-client"

const BASE = "https://open-vsx.org"

function row(
  extensionId: string,
  fetchedAt: number,
  payload: unknown = { ok: true }
): OpenVsxCacheRow {
  return {
    extensionId,
    fetchedAt,
    displayName: extensionId,
    latestVersion: "1.0.0",
    categories: [],
    downloadCount: 1,
    verified: false,
    payload,
  }
}

function searchEntry(overrides: Partial<OpenVsxSearchEntry> = {}): OpenVsxSearchEntry {
  return {
    files: {
      download: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/x.vsix`,
      icon: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/icon.png`,
    },
    name: "prettier-vscode",
    namespace: "esbenp",
    version: "12.4.0",
    displayName: "Prettier - Code formatter",
    downloadCount: 8_222_247,
    averageRating: 4.35,
    verified: true,
    ...overrides,
  }
}

// Cold-opening the versioned CogniaDB under fake-indexeddb can exceed the
// default 5s hook timeout on the first test; give it headroom.
beforeEach(async () => {
  await getDb().openVsxCache.clear()
}, 30_000)

describe("openvsx-cache — read/write", () => {
  it("round-trips a row", async () => {
    await putCached([row("esbenp.prettier-vscode", Date.now())])
    const found = await getCached("esbenp.prettier-vscode")
    expect(found?.displayName).toBe("esbenp.prettier-vscode")
    expect(await getCached("nobody.nothing")).toBeUndefined()
  })

  it("bulk-writes and overwrites by extensionId", async () => {
    await putCached([row("a.b", 1_000), row("c.d", 1_000)])
    await putCached([{ ...row("a.b", 2_000), latestVersion: "2.0.0" }])
    expect(await getDb().openVsxCache.count()).toBe(2)
    expect((await getCached("a.b", Number.MAX_SAFE_INTEGER))?.latestVersion).toBe("2.0.0")
  })
})

describe("openvsx-cache — TTL", () => {
  it("cache_entries_expire_after_ttl", async () => {
    const now = Date.now()
    const fresh = now - 60_000
    const expired = now - (OPEN_VSX_CACHE_TTL_MS + 60_000)

    await putCached([row("fresh.ext", fresh), row("stale.ext", expired)])

    expect(await getCached("fresh.ext")).toBeDefined()
    // Aged past 24h -> reported absent, so a caller can't render day-old data
    // as current by forgetting to check.
    expect(await getCached("stale.ext")).toBeUndefined()

    // The row is still on disk: expiry on read is side-effect free.
    expect(await getDb().openVsxCache.get("stale.ext")).toBeDefined()
  })

  it("isStale reports staleness against an injectable clock", () => {
    expect(isStale({ fetchedAt: 0 }, OPEN_VSX_CACHE_TTL_MS, OPEN_VSX_CACHE_TTL_MS - 1)).toBe(false)
    expect(isStale({ fetchedAt: 0 }, OPEN_VSX_CACHE_TTL_MS, OPEN_VSX_CACHE_TTL_MS + 1)).toBe(true)
  })

  it("pruneStale deletes only aged rows", async () => {
    const now = 10 * OPEN_VSX_CACHE_TTL_MS
    await putCached([
      row("fresh.ext", now - 1_000),
      row("stale.ext", now - OPEN_VSX_CACHE_TTL_MS * 2),
    ])

    const deleted = await pruneStale(OPEN_VSX_CACHE_TTL_MS, now)

    expect(deleted).toBe(1)
    expect(await getDb().openVsxCache.get("stale.ext")).toBeUndefined()
    expect(await getDb().openVsxCache.get("fresh.ext")).toBeDefined()
  })
})

describe("openvsx-cache — caps", () => {
  it("cache_evicts_oldest_beyond_cap", async () => {
    // The table's only index is `&extensionId, fetchedAt` and nothing has ever
    // evicted from it — without this cap, browsing grows it without bound.
    const base = Date.now()
    const rows = Array.from({ length: OPEN_VSX_CACHE_MAX_ROWS + 25 }, (_, i) =>
      row(`ns.ext${String(i).padStart(4, "0")}`, base + i)
    )

    await putCached(rows)

    expect(await getDb().openVsxCache.count()).toBe(OPEN_VSX_CACHE_MAX_ROWS)
    // The 25 oldest by fetchedAt are gone; the newest survive.
    expect(await getDb().openVsxCache.get("ns.ext0000")).toBeUndefined()
    expect(await getDb().openVsxCache.get("ns.ext0024")).toBeUndefined()
    expect(await getDb().openVsxCache.get("ns.ext0025")).toBeDefined()
    expect(await getDb().openVsxCache.get("ns.ext0524")).toBeDefined()
  })

  it("re-caching an extension refreshes its position and spares it from eviction", async () => {
    const base = Date.now()
    await putCached([row("ns.oldest", base)])
    // Touch it so its fetchedAt is newest, then flood the cache.
    await putCached([row("ns.oldest", base + 10_000)])
    await putCached(
      Array.from({ length: OPEN_VSX_CACHE_MAX_ROWS }, (_, i) => row(`ns.filler${i}`, base + 1 + i))
    )

    expect(await getDb().openVsxCache.get("ns.oldest")).toBeDefined()
  })

  it("oversized_payload_is_not_cached", async () => {
    // `payload` is typed `unknown` and filled straight from a registry
    // response, so its size is registry-controlled.
    const huge = { blob: "x".repeat(OPEN_VSX_CACHE_MAX_PAYLOAD_BYTES + 1_000) }
    await putCached([row("huge.ext", Date.now(), huge), row("small.ext", Date.now())])

    // Skipped entirely — not truncated, which would be a lie the UI can't see.
    expect(await getDb().openVsxCache.get("huge.ext")).toBeUndefined()
    // ...and it doesn't poison the rest of the batch.
    expect(await getCached("small.ext")).toBeDefined()
  })

  it("skips an unserialisable payload rather than throwing on write", async () => {
    const cyclic: Record<string, unknown> = { name: "x" }
    cyclic.self = cyclic
    await expect(putCached([row("cyclic.ext", Date.now(), cyclic)])).resolves.toBeUndefined()
    expect(await getDb().openVsxCache.get("cyclic.ext")).toBeUndefined()
  })

  it("writes nothing when every row is rejected", async () => {
    const huge = { blob: "x".repeat(OPEN_VSX_CACHE_MAX_PAYLOAD_BYTES + 1) }
    await putCached([row("huge.ext", Date.now(), huge)])
    expect(await getDb().openVsxCache.count()).toBe(0)
  })

  it("caches a row with an undefined payload", async () => {
    // JSON.stringify(undefined) returns undefined, not a string — that must
    // read as size 0, not crash the size check.
    await putCached([row("empty.ext", Date.now(), undefined)])
    expect(await getCached("empty.ext")).toBeDefined()
  })
})

describe("openvsx-cache — row mappers", () => {
  it("writes categories: [] for search-sourced rows", async () => {
    // The live /api/-/search response has NO categories field at all; it exists
    // only on /query. `[]` records "unknown", not "none".
    const built = cacheRowFromSearchEntry(searchEntry(), 1_234)

    expect(built).toMatchObject({
      extensionId: "esbenp.prettier-vscode",
      fetchedAt: 1_234,
      displayName: "Prettier - Code formatter",
      latestVersion: "12.4.0",
      categories: [],
      downloadCount: 8_222_247,
      averageRating: 4.35,
      verified: true,
    })
    expect(built.iconUrl).toContain("/file/icon.png")
  })

  it("carries the real categories through for query-sourced rows", () => {
    const entry = { ...searchEntry(), categories: ["Formatters"] } as OpenVsxQueryEntry
    expect(cacheRowFromQueryEntry(entry, 99).categories).toEqual(["Formatters"])
  })

  it("a /query row overwrites a search row's placeholder categories", async () => {
    await putCached([cacheRowFromSearchEntry(searchEntry(), 1_000)])
    expect(
      (await getCached("esbenp.prettier-vscode", Number.MAX_SAFE_INTEGER))?.categories
    ).toEqual([])

    const queryEntry = { ...searchEntry(), categories: ["Formatters"] } as OpenVsxQueryEntry
    await putCached([cacheRowFromQueryEntry(queryEntry, 2_000)])

    expect(
      (await getCached("esbenp.prettier-vscode", Number.MAX_SAFE_INTEGER))?.categories
    ).toEqual(["Formatters"])
  })

  it("falls back to the extension name when displayName is absent", () => {
    const built = cacheRowFromSearchEntry(searchEntry({ displayName: undefined }))
    expect(built.displayName).toBe("prettier-vscode")
    expect(built.verified).toBe(true)

    const fromQuery = cacheRowFromQueryEntry({
      ...searchEntry({ displayName: undefined }),
    } as OpenVsxQueryEntry)
    expect(fromQuery.displayName).toBe("prettier-vscode")
  })

  it("defaults a search entry's missing downloadCount to 0", () => {
    const built = cacheRowFromSearchEntry(
      searchEntry({ downloadCount: undefined, verified: undefined })
    )
    expect(built.downloadCount).toBe(0)
    expect(built.verified).toBe(false)
  })

  it("defaults a missing downloadCount to 0 and unverified to false", () => {
    const built = cacheRowFromQueryEntry({
      ...searchEntry({ downloadCount: undefined, verified: undefined }),
    } as OpenVsxQueryEntry)
    expect(built.downloadCount).toBe(0)
    expect(built.verified).toBe(false)
    expect(built.categories).toEqual([])
  })
})
