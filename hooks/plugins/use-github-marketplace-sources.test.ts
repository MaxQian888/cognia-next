/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useGithubMarketplaceSources, canonicalSourceId } from "./use-github-marketplace-sources"

let liveRows: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRows,
}))

const listMarketplaceSources = jest.fn()
const addMarketplaceSource = jest.fn()
const removeMarketplaceSource = jest.fn()
jest.mock("@/lib/db/plugin-marketplace-sources", () => ({
  listMarketplaceSources: () => listMarketplaceSources(),
  addMarketplaceSource: (...a: unknown[]) => addMarketplaceSource(...a),
  removeMarketplaceSource: (...a: unknown[]) => removeMarketplaceSource(...a),
}))

const fetchAllSourceEntries = jest.fn()
const fetchMarketplaceCatalog = jest.fn()
jest.mock("@/lib/plugin/package/github-marketplace", () => ({
  fetchAllSourceEntries: (...a: unknown[]) => fetchAllSourceEntries(...a),
  fetchMarketplaceCatalog: (...a: unknown[]) => fetchMarketplaceCatalog(...a),
}))

describe("canonicalSourceId", () => {
  it("normalizes URLs and shorthand to owner/repo[@ref]", () => {
    expect(canonicalSourceId("https://github.com/acme/store")).toBe("acme/store")
    expect(canonicalSourceId("acme/store@v2")).toBe("acme/store@v2")
  })
})

describe("useGithubMarketplaceSources", () => {
  beforeEach(() => {
    liveRows = []
    fetchAllSourceEntries.mockReset().mockResolvedValue({ entries: [], errors: [] })
    fetchMarketplaceCatalog.mockReset()
    addMarketplaceSource.mockReset()
    removeMarketplaceSource.mockReset()
  })

  it("loads catalog entries for saved sources", async () => {
    liveRows = [{ id: "acme/store", repoRef: "acme/store", name: "Acme", addedAt: 1 }]
    fetchAllSourceEntries.mockResolvedValue({
      entries: [{ id: "acme/store:Alpha", name: "Alpha", version: "", type: "plugin", github: {} }],
      errors: [],
    })
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await waitFor(() => expect(result.current.entries).toHaveLength(1))
    expect(fetchAllSourceEntries).toHaveBeenCalledWith(["acme/store"])
  })

  it("add() validates the repo then persists with a canonical id", async () => {
    fetchMarketplaceCatalog.mockResolvedValue({ name: "Acme", entries: [] })
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await act(async () => {
      await result.current.add("https://github.com/acme/store")
    })
    expect(fetchMarketplaceCatalog).toHaveBeenCalledWith("https://github.com/acme/store")
    expect(addMarketplaceSource).toHaveBeenCalledWith({
      id: "acme/store",
      repoRef: "https://github.com/acme/store",
      name: "Acme",
    })
  })

  it("add() throws (no persist) when the repo has no catalog", async () => {
    fetchMarketplaceCatalog.mockRejectedValue(new Error("no marketplace.json found"))
    const { result } = renderHook(() => useGithubMarketplaceSources())
    await expect(result.current.add("acme/empty")).rejects.toThrow(/no marketplace.json/i)
    expect(addMarketplaceSource).not.toHaveBeenCalled()
  })
})
