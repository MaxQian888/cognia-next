/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useGithubMarketplaceSources, canonicalSourceId } from "./use-github-marketplace-sources"
import type {
  GithubMarketplaceEntry,
  MarketplaceCatalog,
} from "@/lib/plugin/package/github-marketplace"

let liveRows: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRows,
}))

const listMarketplaceSources = jest.fn()
const addMarketplaceSource = jest.fn()
const removeMarketplaceSource = jest.fn()
const recordSourceSync = jest.fn()
jest.mock("@/lib/db/plugin-marketplace-sources", () => ({
  listMarketplaceSources: () => listMarketplaceSources(),
  addMarketplaceSource: (...a: unknown[]) => addMarketplaceSource(...a),
  removeMarketplaceSource: (...a: unknown[]) => removeMarketplaceSource(...a),
  recordSourceSync: (...a: unknown[]) => recordSourceSync(...a),
}))

const fetchAllSourceEntries = jest.fn()
const fetchMarketplaceCatalog = jest.fn()
jest.mock("@/lib/plugin/package/github-marketplace", () => ({
  fetchAllSourceEntries: (...a: unknown[]) => fetchAllSourceEntries(...a),
  fetchMarketplaceCatalog: (...a: unknown[]) => fetchMarketplaceCatalog(...a),
}))

function entry(id: string): GithubMarketplaceEntry {
  return {
    id,
    name: id,
    version: "",
    type: "plugin",
    source: "git",
    github: { owner: "acme", repo: "repo" },
  }
}

function catalogFor(repoRef: string, entryIds: string[], name = "Acme"): MarketplaceCatalog {
  return {
    id: repoRef,
    name,
    catalogPath: "marketplace.json",
    repoUrl: `https://github.com/${repoRef}`,
    entries: entryIds.map(entry),
  }
}

/** `fetchAllSourceEntries`-shaped result built from per-source catalogs. */
function allEntriesResult(catalogs: Array<{ repoRef: string; entryIds: string[] }>) {
  const results = catalogs.map((c) => ({
    repoRef: c.repoRef,
    ok: true as const,
    catalog: catalogFor(c.repoRef, c.entryIds),
  }))
  return { entries: results.flatMap((r) => r.catalog.entries), errors: [], results }
}

describe("canonicalSourceId", () => {
  it("normalizes URLs and shorthand to owner/repo[@ref]", () => {
    expect(canonicalSourceId("https://github.com/acme/store")).toBe("acme/store")
    expect(canonicalSourceId("acme/store@v2")).toBe("acme/store@v2")
  })
})

describe("useGithubMarketplaceSources", () => {
  beforeEach(() => {
    liveRows = []
    fetchAllSourceEntries.mockReset().mockResolvedValue({ entries: [], errors: [], results: [] })
    fetchMarketplaceCatalog.mockReset()
    addMarketplaceSource.mockReset()
    removeMarketplaceSource.mockReset()
    recordSourceSync.mockReset()
  })

  it("loads catalog entries for saved sources", async () => {
    liveRows = [{ id: "acme/store", repoRef: "acme/store", name: "Acme", addedAt: 1 }]
    fetchAllSourceEntries.mockResolvedValue(
      allEntriesResult([{ repoRef: "acme/store", entryIds: ["acme/store:Alpha"] }])
    )
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
    expect(fetchAllSourceEntries).toHaveBeenCalledWith(["acme/store"])
  })

  it("orders entries by the source list, not by which fetch resolved first", async () => {
    liveRows = [
      { id: "a/one", repoRef: "a/one", name: "One", addedAt: 2 },
      { id: "b/two", repoRef: "b/two", name: "Two", addedAt: 1 },
    ]
    // Deliberately reversed: the merged list must still follow the row order.
    fetchAllSourceEntries.mockResolvedValue(
      allEntriesResult([
        { repoRef: "b/two", entryIds: ["b:1"] },
        { repoRef: "a/one", entryIds: ["a:1"] },
      ])
    )
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(result.current.entries).toHaveLength(2))
    expect(result.current.entries.map((e) => e.id)).toEqual(["a:1", "b:1"])
  })

  it("records each fetch outcome against its own source", async () => {
    liveRows = [
      { id: "acme/good", repoRef: "acme/good", name: "Good", addedAt: 2 },
      { id: "acme/bad", repoRef: "acme/bad", name: "Bad", addedAt: 1 },
    ]
    fetchAllSourceEntries.mockResolvedValue({
      entries: [entry("acme/good:Alpha")],
      errors: [{ repoRef: "acme/bad", message: "no marketplace.json" }],
      results: [
        { repoRef: "acme/good", ok: true, catalog: catalogFor("acme/good", ["acme/good:Alpha"]) },
        { repoRef: "acme/bad", ok: false, message: "no marketplace.json" },
      ],
    })
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(recordSourceSync).toHaveBeenCalledTimes(2))
    expect(recordSourceSync).toHaveBeenCalledWith("acme/good", {
      ok: true,
      pluginCount: 1,
      name: "Acme",
    })
    expect(recordSourceSync).toHaveBeenCalledWith("acme/bad", {
      ok: false,
      message: "no marketplace.json",
    })
    expect(result.current.errors).toEqual([{ repoRef: "acme/bad", message: "no marketplace.json" }])
  })

  it("preview() fetches without persisting anything", async () => {
    const catalog = catalogFor("acme/store", ["acme/store:Alpha"])
    fetchMarketplaceCatalog.mockResolvedValue(catalog)
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await act(async () => {
      await expect(result.current.preview("acme/store")).resolves.toBe(catalog)
    })
    expect(addMarketplaceSource).not.toHaveBeenCalled()
  })

  it("commitPreview() persists from an already-fetched catalog, with no second fetch", async () => {
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await act(async () => {
      await result.current.commitPreview(
        "https://github.com/acme/store",
        catalogFor("acme/store", ["a", "b"], "Acme Plugins")
      )
    })
    expect(fetchMarketplaceCatalog).not.toHaveBeenCalled()
    expect(addMarketplaceSource).toHaveBeenCalledWith({
      id: "acme/store",
      repoRef: "https://github.com/acme/store",
      name: "Acme Plugins",
      pluginCount: 2,
      lastSyncedAt: expect.any(Number),
    })
  })

  it("add() validates the repo then persists with a canonical id", async () => {
    fetchMarketplaceCatalog.mockResolvedValue(catalogFor("acme/store", ["a"], "Acme"))
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await act(async () => {
      await result.current.add("https://github.com/acme/store")
    })
    expect(fetchMarketplaceCatalog).toHaveBeenCalledWith("https://github.com/acme/store")
    expect(addMarketplaceSource).toHaveBeenCalledWith({
      id: "acme/store",
      repoRef: "https://github.com/acme/store",
      name: "Acme",
      pluginCount: 1,
      lastSyncedAt: expect.any(Number),
    })
  })

  it("add() throws (no persist) when the repo has no catalog", async () => {
    fetchMarketplaceCatalog.mockRejectedValue(new Error("no marketplace.json found"))
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await expect(result.current.add("acme/empty")).rejects.toThrow(/no marketplace.json/i)
    expect(addMarketplaceSource).not.toHaveBeenCalled()
  })

  it("refreshSource() refetches one source and clears its stale error", async () => {
    liveRows = [
      { id: "acme/bad", repoRef: "acme/bad", name: "Bad", addedAt: 2 },
      { id: "acme/other", repoRef: "acme/other", name: "Other", addedAt: 1 },
    ]
    fetchAllSourceEntries.mockResolvedValue({
      entries: [entry("other:1")],
      errors: [{ repoRef: "acme/bad", message: "rate limited" }],
      results: [
        { repoRef: "acme/bad", ok: false, message: "rate limited" },
        { repoRef: "acme/other", ok: true, catalog: catalogFor("acme/other", ["other:1"]) },
      ],
    })
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(result.current.errors).toHaveLength(1))

    fetchMarketplaceCatalog.mockResolvedValue(catalogFor("acme/bad", ["bad:1"]))
    await act(async () => {
      await result.current.refreshSource("acme/bad")
    })

    // Only the one source was refetched…
    expect(fetchMarketplaceCatalog).toHaveBeenCalledTimes(1)
    expect(fetchMarketplaceCatalog).toHaveBeenCalledWith("acme/bad")
    // …its error is gone, and the other source's entries survived.
    expect(result.current.errors).toEqual([])
    expect(result.current.entries.map((e) => e.id)).toEqual(["bad:1", "other:1"])
  })

  it("refreshSource() records a failure and keeps the source listed", async () => {
    liveRows = [{ id: "acme/bad", repoRef: "acme/bad", name: "Bad", addedAt: 1 }]
    const { result } = renderHook(() => useGithubMarketplaceSources())
    fetchMarketplaceCatalog.mockRejectedValue(new Error("GitHub API 403"))
    await act(async () => {
      await result.current.refreshSource("acme/bad")
    })
    expect(recordSourceSync).toHaveBeenCalledWith("acme/bad", {
      ok: false,
      message: "GitHub API 403",
    })
    expect(result.current.errors).toEqual([{ repoRef: "acme/bad", message: "GitHub API 403" }])
    expect(result.current.syncingIds.size).toBe(0)
  })

  // `useLiveQuery` yields undefined on the first tick, before Dexie answers.
  it("renders empty rather than crashing before Dexie answers", () => {
    liveRows = undefined
    const { result } = renderHook(() => useGithubMarketplaceSources())
    expect(result.current.sources).toEqual([])
    expect(result.current.entries).toEqual([])
    expect(fetchAllSourceEntries).not.toHaveBeenCalled()
  })

  it("refreshSource() stringifies a non-Error rejection", async () => {
    liveRows = [{ id: "acme/bad", repoRef: "acme/bad", name: "Bad", addedAt: 1 }]
    const { result } = renderHook(() => useGithubMarketplaceSources())
    fetchMarketplaceCatalog.mockRejectedValue("socket hang up")
    await act(async () => {
      await result.current.refreshSource("acme/bad")
    })
    expect(result.current.errors).toEqual([{ repoRef: "acme/bad", message: "socket hang up" }])
  })

  it("remove() deletes the row", async () => {
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await act(async () => {
      await result.current.remove("acme/store")
    })
    expect(removeMarketplaceSource).toHaveBeenCalledWith("acme/store")
  })

  it("refresh() re-runs the full load", async () => {
    liveRows = [{ id: "acme/store", repoRef: "acme/store", name: "Acme", addedAt: 1 }]
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(fetchAllSourceEntries).toHaveBeenCalledTimes(1))
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(fetchAllSourceEntries).toHaveBeenCalledTimes(2))
  })

  // Health is bookkeeping about the fetch; letting its write reject would take
  // down the load that already produced the entries.
  it("keeps the catalog when the health write fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    liveRows = [{ id: "acme/store", repoRef: "acme/store", name: "Acme", addedAt: 1 }]
    fetchAllSourceEntries.mockResolvedValue(
      allEntriesResult([{ repoRef: "acme/store", entryIds: ["acme/store:Alpha"] }])
    )
    recordSourceSync.mockRejectedValue(new Error("db closed"))
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.loading).toBe(false)
    warn.mockRestore()
  })

  it("refreshSource() is a no-op for an id that is no longer saved", async () => {
    liveRows = []
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await act(async () => {
      await result.current.refreshSource("acme/gone")
    })
    expect(fetchMarketplaceCatalog).not.toHaveBeenCalled()
    expect(recordSourceSync).not.toHaveBeenCalled()
  })
})
