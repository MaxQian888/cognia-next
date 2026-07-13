"use client"

// Convenient client-side hook around the multi-provider search service.
// Wraps `search()` + the LRU cache so callers (chat composer, slash
// commands, dev tools) get a unified, stateful surface.

import { useCallback, useState } from "react"
import { useSettingsStore } from "@/stores/settings"
import { search } from "@/lib/search/search-service"
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
      const settings = useSettingsStore.getState().settings
      const providerSettings = settings?.searchProviders
      const cache = getSearchCache()
      const provider = overrideProvider ?? settings?.defaultSearchProvider

      const cacheable = !disableCache && (settings?.searchCacheEnabled ?? true)
      if (cacheable) {
        const cached = cache.get(query, provider, opts)
        if (cached) {
          setLastResponse(cached)
          return cached
        }
      }

      setIsSearching(true)
      setLastError(null)
      try {
        const resp = await search(query, {
          ...opts,
          provider,
          providerSettings,
          fallbackEnabled: settings?.searchFallbackEnabled ?? true,
          maxResults: opts.maxResults ?? settings?.searchMaxResults ?? 5,
          searchType: opts.searchType ?? settings?.defaultSearchType,
          searchDepth: opts.searchDepth ?? settings?.defaultSearchDepth,
          recency: opts.recency ?? settings?.defaultSearchRecency,
          country: opts.country ?? settings?.defaultSearchCountry,
          language: opts.language ?? settings?.defaultSearchLanguage,
          includeDomains: opts.includeDomains ?? settings?.defaultIncludeDomains,
          excludeDomains: opts.excludeDomains ?? settings?.defaultExcludeDomains,
          includeAnswer: opts.includeAnswer ?? settings?.defaultIncludeAnswer,
          includeRawContent: opts.includeRawContent ?? settings?.defaultIncludeRawContent,
        })
        if (cacheable) cache.set(query, resp, provider, opts)
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
