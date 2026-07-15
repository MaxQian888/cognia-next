/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/plugin/vscode-shim/openvsx-client", () => ({
  getOpenVsxClient: jest.fn(),
}))

import { getOpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"
import {
  useOpenVsxMarketplace,
  toMarketplaceEntry,
  OPEN_VSX_SEARCH_DEBOUNCE_MS,
} from "./use-openvsx-marketplace"

const getOpenVsxClientMock = getOpenVsxClient as jest.Mock

/** A live-shaped search entry (`downloadCount`, not the docs' `downloads`). */
function searchEntry(overrides: Record<string, unknown> = {}) {
  return {
    namespace: "esbenp",
    name: "prettier-vscode",
    version: "11.0.0",
    displayName: "Prettier",
    description: "Code formatter",
    downloadCount: 4321,
    averageRating: 4.5,
    verified: true,
    files: { download: "https://open-vsx.org/x.vsix", icon: "https://open-vsx.org/i.png" },
    ...overrides,
  }
}

function mockSearch(impl: (opts: Record<string, unknown>) => unknown) {
  const searchExtensions = jest.fn(async (opts: Record<string, unknown>) => impl(opts))
  getOpenVsxClientMock.mockReturnValue({ searchExtensions })
  return searchExtensions
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("toMarketplaceEntry", () => {
  it("checksum_badge_does_not_claim_publisher_verification", () => {
    // The load-bearing mapping decision. The card renders `signed: true` as a
    // ShieldCheck labelled "Verified" with the tooltip "Publisher signature
    // verified." We verify no signature — only a SHA-256 fetched over the same
    // TLS connection, from the same host, as the .vsix. So `verified` must
    // never land on `signed`, and `signatureState` is pinned explicitly.
    const entry = toMarketplaceEntry(searchEntry({ verified: true }) as never)

    expect(entry.signed).toBeUndefined()
    expect(entry.signatureState).toBe("unknown")
    // The registry's claim survives, but on its own attributed field.
    expect(entry.verifiedPublisher).toBe(true)
  })

  it("verified_badge_is_attributed_to_open_vsx", () => {
    // The attributed flag tracks the API's `verified` exactly — the card is
    // what adds the "by Open VSX" attribution, and it keys off this.
    expect(toMarketplaceEntry(searchEntry({ verified: true }) as never).verifiedPublisher).toBe(
      true
    )
    expect(toMarketplaceEntry(searchEntry({ verified: false }) as never).verifiedPublisher).toBe(
      false
    )
    // Absent must not become truthy.
    expect(
      toMarketplaceEntry(searchEntry({ verified: undefined }) as never).verifiedPublisher
    ).toBe(false)
  })

  it("maps live field names and composes the canonical id", () => {
    const entry = toMarketplaceEntry(searchEntry() as never)
    expect(entry.id).toBe("esbenp.prettier-vscode")
    expect(entry.name).toBe("Prettier")
    expect(entry.downloads).toBe(4321)
    expect(entry.rating).toBe(4.5)
    expect(entry.type).toBe("vscode-extension")
    // PluginRow's vocabulary has no "openvsx" member — that value belongs to
    // manifest.vscodeExtension.source. Two fields, same name.
    expect(entry.source).toBe("marketplace")
  })

  it("falls back to the raw name when the registry omits displayName", () => {
    const entry = toMarketplaceEntry(searchEntry({ displayName: undefined }) as never)
    expect(entry.name).toBe("prettier-vscode")
  })
})

describe("useOpenVsxMarketplace", () => {
  it("fetches nothing while disabled", async () => {
    // Opening the Plugins page must not hit open-vsx.org.
    const searchExtensions = mockSearch(() => ({ offset: 0, totalSize: 0, extensions: [] }))

    renderHook(() => useOpenVsxMarketplace({ enabled: false, pageSize: 12 }))
    await new Promise((r) => setTimeout(r, 20))

    expect(getOpenVsxClientMock).not.toHaveBeenCalled()
    expect(searchExtensions).not.toHaveBeenCalled()
  })

  it("fetches once enabled", async () => {
    const searchExtensions = mockSearch(() => ({
      offset: 0,
      totalSize: 1,
      extensions: [searchEntry()],
    }))

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))

    await waitFor(() => expect(result.current.entries).toHaveLength(1))
    expect(result.current.entries[0].id).toBe("esbenp.prettier-vscode")
    expect(searchExtensions).toHaveBeenCalledTimes(1)
  })

  it("pagination_maps_to_size_and_offset", async () => {
    // Server-side paging only — never fetch-all. The fake honours size/offset
    // against a 30-item corpus, so the last window is a short page (6), as the
    // real registry returns.
    const TOTAL = 30
    const searchExtensions = mockSearch((opts) => {
      const offset = opts.offset as number
      const size = opts.size as number
      const count = Math.max(0, Math.min(size, TOTAL - offset))
      return {
        offset,
        totalSize: TOTAL,
        extensions: Array.from({ length: count }, (_, i) =>
          searchEntry({ name: `ext-${offset + i}` })
        ),
      }
    })

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))
    await waitFor(() => expect(result.current.entries).toHaveLength(12))

    expect(searchExtensions).toHaveBeenCalledWith(expect.objectContaining({ size: 12, offset: 0 }))
    expect(result.current.total).toBe(30)
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.entries).toHaveLength(24))

    // The next window is requested from the server, not sliced from a
    // pre-fetched list.
    expect(searchExtensions).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: 12, offset: 12 })
    )
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.entries).toHaveLength(30))
    expect(searchExtensions).toHaveBeenLastCalledWith(
      expect.objectContaining({ size: 12, offset: 24 })
    )
    // Everything loaded — no further page offered.
    expect(result.current.hasMore).toBe(false)
  })

  it("dedupes across page boundaries", async () => {
    // The registry can shift an entry between requests; a duplicate id would
    // throw on React's key.
    mockSearch((opts) => ({
      offset: opts.offset,
      totalSize: 4,
      extensions: [searchEntry({ name: "same" }), searchEntry({ name: `p-${opts.offset}` })],
    }))

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 2 }))
    await waitFor(() => expect(result.current.entries).toHaveLength(2))

    act(() => result.current.loadMore())
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.id)).toEqual([
        "esbenp.same",
        "esbenp.p-0",
        "esbenp.p-2",
      ])
    )
  })

  it("debounces the search box and resets paging on a new query", async () => {
    const searchExtensions = mockSearch((opts) => ({
      offset: opts.offset,
      totalSize: 1,
      extensions: [searchEntry()],
    }))

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))
    await waitFor(() => expect(searchExtensions).toHaveBeenCalledTimes(1))

    // Type four characters well inside the debounce window.
    act(() => result.current.setQuery("p"))
    act(() => result.current.setQuery("pr"))
    act(() => result.current.setQuery("pre"))
    act(() => result.current.setQuery("pret"))

    // Still one request — the keystrokes collapsed.
    expect(searchExtensions).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(searchExtensions).toHaveBeenCalledTimes(2), {
      timeout: OPEN_VSX_SEARCH_DEBOUNCE_MS + 1000,
    })
    expect(searchExtensions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "pret", offset: 0 })
    )
  })

  it("omits an empty query rather than sending query=''", async () => {
    const searchExtensions = mockSearch(() => ({ offset: 0, totalSize: 0, extensions: [] }))
    renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))
    await waitFor(() => expect(searchExtensions).toHaveBeenCalled())
    expect(searchExtensions.mock.calls[0][0]).not.toHaveProperty("query")
  })

  it("surfaces a registry failure as an error state", async () => {
    mockSearch(() => {
      throw new Error("HTTP 429")
    })

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))

    await waitFor(() => expect(result.current.state.kind).toBe("error"))
    expect(result.current.state).toMatchObject({ error: "HTTP 429" })
  })

  it("stringifies a non-Error rejection instead of rendering [object Object]", async () => {
    mockSearch(() => {
      throw "registry exploded"
    })

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))

    await waitFor(() => expect(result.current.state.kind).toBe("error"))
    expect(result.current.state).toMatchObject({ error: "registry exploded" })
  })

  it("loadMore is a no-op while a page is already in flight", async () => {
    // The guard reads committed state inside the setter, so a double-click
    // requests the next window once rather than skipping a page.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const searchExtensions = jest.fn(async (opts: Record<string, unknown>) => {
      if ((opts.offset as number) > 0) await gate
      return {
        offset: opts.offset,
        totalSize: 100,
        extensions: [searchEntry({ name: `p-${opts.offset}` })],
      }
    })
    getOpenVsxClientMock.mockReturnValue({ searchExtensions })

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 1 }))
    await waitFor(() => expect(result.current.entries).toHaveLength(1))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.state.kind).toBe("loading"))
    // Second click lands while page 2 is still in flight.
    act(() => result.current.loadMore())

    release()
    await waitFor(() => expect(result.current.entries).toHaveLength(2))

    // offset 0 and offset 1 — never a jump to offset 2.
    expect(searchExtensions.mock.calls.map((c) => c[0].offset)).toEqual([0, 1])
  })

  it("a page that resolves after the section closes does not write state", async () => {
    // Switching away mid-flight must not repopulate the section behind the
    // user (and must not warn about setting state on an unmounted hook).
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const searchExtensions = jest.fn(async (opts: Record<string, unknown>) => {
      await gate
      return { offset: opts.offset, totalSize: 1, extensions: [searchEntry()] }
    })
    getOpenVsxClientMock.mockReturnValue({ searchExtensions })

    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useOpenVsxMarketplace({ enabled, pageSize: 12 }),
      { initialProps: { enabled: true } }
    )
    await waitFor(() => expect(searchExtensions).toHaveBeenCalled())

    rerender({ enabled: false })
    release()
    await new Promise((r) => setTimeout(r, 20))

    expect(result.current.entries).toEqual([])
    unmount()
  })

  it("refresh re-runs the current query", async () => {
    const searchExtensions = mockSearch(() => ({
      offset: 0,
      totalSize: 1,
      extensions: [searchEntry()],
    }))

    const { result } = renderHook(() => useOpenVsxMarketplace({ enabled: true, pageSize: 12 }))
    await waitFor(() => expect(searchExtensions).toHaveBeenCalledTimes(1))

    act(() => result.current.refresh())
    await waitFor(() => expect(searchExtensions).toHaveBeenCalledTimes(2))
  })
})
