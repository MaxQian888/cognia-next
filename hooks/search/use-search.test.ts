import { renderHook, act } from "@testing-library/react"
import type { SearchOptions, SearchResponse } from "@cognia/web-search/types"

const searchMock = jest.fn()
const cacheGetMock = jest.fn()
const cacheSetMock = jest.fn()
const cacheClearMock = jest.fn()
const cacheStatsMock = jest.fn()

jest.mock("@/lib/search/search-service", () => ({
  search: (...args: unknown[]) => searchMock(...args),
}))

jest.mock("@cognia/web-search/search-cache", () => ({
  getSearchCache: () => ({
    get: cacheGetMock,
    set: cacheSetMock,
    clear: cacheClearMock,
    getStats: cacheStatsMock,
  }),
}))

const settingsState = {
  settings: {
    searchProviders: { tavily: { providerId: "tavily", apiKey: "k", enabled: true, priority: 1 } },
    defaultSearchProvider: "tavily" as const,
    searchCacheEnabled: true,
    searchFallbackEnabled: true,
    searchMaxResults: 5,
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

import { useSearch } from "./use-search"

beforeEach(() => {
  searchMock.mockReset()
  cacheGetMock.mockReset()
  cacheSetMock.mockReset()
  cacheClearMock.mockReset()
  cacheStatsMock.mockReset().mockReturnValue({ size: 1 })
})

function makeResp(): SearchResponse {
  return {
    provider: "tavily",
    query: "q",
    results: [],
    responseTime: 1,
  }
}

describe("useSearch", () => {
  it("returns cached response when present", async () => {
    cacheGetMock.mockReturnValueOnce(makeResp())
    const { result } = renderHook(() => useSearch())
    let response: SearchResponse | undefined
    await act(async () => {
      response = await result.current.search("q")
    })
    expect(response?.provider).toBe("tavily")
    expect(searchMock).not.toHaveBeenCalled()
  })

  it("calls search service and stores in cache when no hit", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    searchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch())
    await act(async () => {
      await result.current.search("q")
    })
    expect(searchMock).toHaveBeenCalled()
    expect(cacheSetMock).toHaveBeenCalled()
  })

  it("disables cache when disableCache is true", async () => {
    searchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch({ disableCache: true }))
    await act(async () => {
      await result.current.search("q")
    })
    expect(cacheGetMock).not.toHaveBeenCalled()
    expect(cacheSetMock).not.toHaveBeenCalled()
  })

  it("captures errors and rethrows", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    searchMock.mockRejectedValueOnce(new Error("network"))
    const { result } = renderHook(() => useSearch())
    await act(async () => {
      try {
        await result.current.search("q")
      } catch {
        // expected
      }
    })
    expect(result.current.lastError?.message).toBe("network")
    act(() => {
      result.current.clearError()
    })
    expect(result.current.lastError).toBeNull()
  })

  it("forwards searchByType options", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    searchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch())
    await act(async () => {
      await result.current.searchByType("q", "news")
    })
    const calledOptions = searchMock.mock.calls[0][1] as SearchOptions
    expect(calledOptions.searchType).toBe("news")
  })

  it("override provider takes precedence", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    searchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch({ provider: "perplexity" }))
    await act(async () => {
      await result.current.search("q")
    })
    const calledOptions = searchMock.mock.calls[0][1] as { provider?: string }
    expect(calledOptions.provider).toBe("perplexity")
  })

  it("clearCache and getCacheStats work", () => {
    const { result } = renderHook(() => useSearch())
    act(() => {
      result.current.clearCache()
    })
    expect(cacheClearMock).toHaveBeenCalled()
    expect(result.current.getCacheStats()).toEqual({ size: 1 })
  })

  it("wraps non-Error throws into Error", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    searchMock.mockRejectedValueOnce("string-failure")
    const { result } = renderHook(() => useSearch())
    await act(async () => {
      try {
        await result.current.search("q")
      } catch {
        // expected
      }
    })
    expect(result.current.lastError).toBeInstanceOf(Error)
    expect(result.current.lastError?.message).toBe("string-failure")
  })
})
