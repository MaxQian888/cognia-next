/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import {
  usePluginMarketplace,
  __resetPluginMarketplaceClientForTests,
  type PluginMarketplaceEntry,
} from "./use-plugin-marketplace"

const SAMPLE: PluginMarketplaceEntry[] = [
  { id: "p1", name: "Plugin 1", version: "1.0.0", type: "plugin" },
  { id: "p2", name: "Plugin 2", version: "0.5.0", type: "plugin" },
]

function makeClient(
  over: Partial<{
    search: jest.Mock
    install: jest.Mock
    uninstall: jest.Mock
    featured: jest.Mock
    popular: jest.Mock
    recent: jest.Mock
  }> = {}
) {
  return {
    searchPlugins: over.search ?? jest.fn(async () => ({ entries: SAMPLE })),
    getFeaturedPlugins: over.featured ?? jest.fn(async () => SAMPLE.slice(0, 1)),
    getPopularPlugins: over.popular ?? jest.fn(async () => SAMPLE),
    getRecentPlugins: over.recent ?? jest.fn(async () => SAMPLE.slice(1)),
    installPlugin: over.install ?? jest.fn(async () => ({ ok: true })),
    uninstallPlugin: over.uninstall ?? jest.fn(async () => ({ ok: true })),
  }
}

beforeEach(() => {
  __resetPluginMarketplaceClientForTests(null)
})

describe("usePluginMarketplace", () => {
  it("loads featured / popular / recent and returns ready state on mount", async () => {
    const client = makeClient()
    __resetPluginMarketplaceClientForTests(client)

    const { result } = renderHook(() => usePluginMarketplace())
    await waitFor(() => expect(result.current.state.kind).toBe("ready"))

    expect(client.searchPlugins).toHaveBeenCalled()
    expect(client.getFeaturedPlugins).toHaveBeenCalled()
    expect(client.getPopularPlugins).toHaveBeenCalled()
    expect(client.getRecentPlugins).toHaveBeenCalled()
    expect(result.current.featured).toHaveLength(1)
    expect(result.current.popular).toHaveLength(2)
    expect(result.current.recent).toHaveLength(1)
    expect(result.current.state.kind === "ready" && result.current.state.results.length).toBe(2)
  })

  it("install / uninstall toggle installingId and call client", async () => {
    const install = jest.fn(async () => ({ ok: true }))
    const uninstall = jest.fn(async () => ({ ok: true }))
    const client = makeClient({ install, uninstall })
    __resetPluginMarketplaceClientForTests(client)

    const { result } = renderHook(() => usePluginMarketplace())
    await waitFor(() => expect(result.current.state.kind).toBe("ready"))

    await act(async () => {
      await result.current.install("p1", "1.0.0")
    })
    expect(install).toHaveBeenCalledWith("p1", "1.0.0")
    expect(result.current.installingId).toBeNull()

    await act(async () => {
      await result.current.uninstall("p1")
    })
    expect(uninstall).toHaveBeenCalledWith("p1")
    expect(result.current.installingId).toBeNull()
  })

  it("setQuery + refresh re-queries the marketplace", async () => {
    const search = jest.fn(async () => ({ entries: SAMPLE }))
    const client = makeClient({ search })
    __resetPluginMarketplaceClientForTests(client)

    const { result } = renderHook(() => usePluginMarketplace())
    await waitFor(() => expect(result.current.state.kind).toBe("ready"))
    expect(search).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.setQuery("search-term")
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(search).toHaveBeenCalledWith({ query: "search-term" })
  })

  it("error state captures thrown error message", async () => {
    const search = jest.fn(async () => {
      throw new Error("boom")
    })
    const client = makeClient({ search })
    __resetPluginMarketplaceClientForTests(client)

    const { result } = renderHook(() => usePluginMarketplace())
    await waitFor(() => expect(result.current.state.kind).toBe("error"))
    expect(result.current.state.kind === "error" && result.current.state.error).toBe("boom")
  })

  it("accepts client returning entries as bare array (not wrapped)", async () => {
    const search = jest.fn(async () => SAMPLE)
    const client = makeClient({ search })
    __resetPluginMarketplaceClientForTests(client)

    const { result } = renderHook(() => usePluginMarketplace())
    await waitFor(() => expect(result.current.state.kind).toBe("ready"))
    expect(result.current.state.kind === "ready" && result.current.state.results.length).toBe(2)
  })
})
