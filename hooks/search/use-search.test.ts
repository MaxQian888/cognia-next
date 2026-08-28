import { renderHook, act } from "@testing-library/react"
import type { SearchOptions, SearchResponse } from "@cognia/web-search/types"

const configuredSearchMock = jest.fn()
const cacheGetMock = jest.fn()
const cacheSetMock = jest.fn()
const cacheClearMock = jest.fn()
const cacheStatsMock = jest.fn()

jest.mock("@/lib/search/configured-search", () => ({
  searchWithAppSettings: (...args: unknown[]) => configuredSearchMock(...args),
}))

jest.mock("@cognia/web-search/search-cache", () => ({
  getSearchCache: () => ({
    get: cacheGetMock,
    set: cacheSetMock,
    clear: cacheClearMock,
    getStats: cacheStatsMock,
  }),
}))

import { useSearch } from "./use-search"

beforeEach(() => {
  configuredSearchMock.mockReset()
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
  it("returns the configured search response", async () => {
    configuredSearchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch())
    let response: SearchResponse | undefined
    await act(async () => {
      response = await result.current.search("q")
    })
    expect(response?.provider).toBe("tavily")
    expect(configuredSearchMock).toHaveBeenCalledTimes(1)
  })

  it("calls search service and stores in cache when no hit", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    configuredSearchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch())
    await act(async () => {
      await result.current.search("q")
    })
    expect(configuredSearchMock).toHaveBeenCalledWith("q", {
      options: {},
      useCache: true,
    })
  })

  it("disables cache when disableCache is true", async () => {
    configuredSearchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch({ disableCache: true }))
    await act(async () => {
      await result.current.search("q")
    })
    expect(configuredSearchMock).toHaveBeenCalledWith("q", {
      options: {},
      useCache: false,
    })
  })

  it("captures errors and rethrows", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    configuredSearchMock.mockRejectedValueOnce(new Error("network"))
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
    configuredSearchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch())
    await act(async () => {
      await result.current.searchByType("q", "news")
    })
    const request = configuredSearchMock.mock.calls[0][1] as { options: SearchOptions }
    expect(request.options.searchType).toBe("news")
  })

  it("override provider takes precedence", async () => {
    cacheGetMock.mockReturnValueOnce(null)
    configuredSearchMock.mockResolvedValueOnce(makeResp())
    const { result } = renderHook(() => useSearch({ provider: "perplexity" }))
    await act(async () => {
      await result.current.search("q")
    })
    const request = configuredSearchMock.mock.calls[0][1] as { options: SearchOptions }
    expect((request.options as { provider?: string }).provider).toBe("perplexity")
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
    configuredSearchMock.mockRejectedValueOnce("string-failure")
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
