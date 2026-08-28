"use client"

// React state wrapper around the canonical configured-search executor. Cache
// controls are exposed for UI actions, but policy and execution stay in the
// shared binding rather than being reimplemented by this hook.

import { useCallback, useState } from "react"
import { searchWithAppSettings } from "@/lib/search/configured-search"
import { getSearchCache } from "@cognia/web-search/search-cache"
import type {
  SearchOptions,
  SearchProviderType,
  SearchResponse,
  SearchType,
} from "@cognia/web-search/types"

export interface UseSearchOptions {
  /** Override the default provider for all calls from this hook instance. */
  provider?: SearchProviderType
  /** Force-disable LRU caching. */
  disableCache?: boolean
}

export interface UseSearchReturn {
  search: (query: string, options?: SearchOptions) => Promise<SearchResponse>
  searchByType: (
    query: string,
    type: SearchType,
    options?: SearchOptions
  ) => Promise<SearchResponse>
  isSearching: boolean
  lastResponse: SearchResponse | null
  lastError: Error | null
  clearError: () => void
  clearCache: () => void
  getCacheStats: () => ReturnType<ReturnType<typeof getSearchCache>["getStats"]>
}

export function useSearch(options: UseSearchOptions = {}): UseSearchReturn {
  const { provider: overrideProvider, disableCache = false } = options
  const [isSearching, setIsSearching] = useState(false)
  const [lastResponse, setLastResponse] = useState<SearchResponse | null>(null)
  const [lastError, setLastError] = useState<Error | null>(null)

  const doSearch = useCallback(
    async (query: string, opts: SearchOptions = {}): Promise<SearchResponse> => {
      setIsSearching(true)
      setLastError(null)
      try {
        const resp = await searchWithAppSettings(query, {
          options: {
            ...opts,
            ...(overrideProvider ? { provider: overrideProvider } : {}),
          },
          useCache: !disableCache,
        })
        setLastResponse(resp)
        return resp
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        setLastError(err)
        throw err
      } finally {
        setIsSearching(false)
      }
    },
    [overrideProvider, disableCache]
  )

  const searchByType = useCallback(
    (query: string, type: SearchType, opts: SearchOptions = {}) =>
      doSearch(query, { ...opts, searchType: type }),
    [doSearch]
  )

  const clearError = useCallback(() => setLastError(null), [])
  const clearCache = useCallback(() => getSearchCache().clear(), [])
  const getCacheStats = useCallback(() => getSearchCache().getStats(), [])

  return {
    search: doSearch,
    searchByType,
    isSearching,
    lastResponse,
    lastError,
    clearError,
    clearCache,
    getCacheStats,
  }
}
