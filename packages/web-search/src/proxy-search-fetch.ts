/**
 * Proxy-aware Fetch for Search Providers
 *
 * Every provider file in this package routes its HTTP through `searchFetch`,
 * which delegates to whatever transport the host installed via
 * `setWebSearchRuntimeAdapters`. On the desktop that is the Rust
 * `proxy_http_request` bridge, so search obeys the configured proxy and is
 * not stopped by the packaged shell's `connect-src` CSP. With no host
 * installed — Node scripts, tests, the browser build — the adapter's own
 * default is a bare `fetch`, which is what this module used to hard-code.
 */

import { log } from "./log"
import { webSearchFetch } from "./runtime-adapters"

/**
 * Search-specific fetch. Resolves the installed transport per call: providers
 * import this module at evaluation time, before the host's boot initializer
 * runs, so binding the transport once at import would pin the inert default.
 */
export async function searchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return webSearchFetch(input, init)
}

/**
 * Create a fetch function for a specific search provider with logging.
 */
export function createSearchProviderFetch(providerName: string) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startTime = Date.now()
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

    try {
      const response = await searchFetch(input, init)
      const duration = Date.now() - startTime

      if (process.env.NODE_ENV === "development") {
        log.debug(`${providerName} ${response.status} ${url} (${duration}ms)`)
      }

      return response
    } catch (error) {
      const duration = Date.now() - startTime
      log.error(`${providerName} failed ${url} (${duration}ms)`, error)
      throw error
    }
  }
}

/**
 * Pre-configured fetch functions for each search provider.
 */
export const braveFetch = createSearchProviderFetch("Brave")
export const bingFetch = createSearchProviderFetch("Bing")
export const googleFetch = createSearchProviderFetch("Google")
export const googleAIFetch = createSearchProviderFetch("GoogleAI")
export const serpApiFetch = createSearchProviderFetch("SerpAPI")
export const searchApiFetch = createSearchProviderFetch("SearchAPI")
export const exaFetch = createSearchProviderFetch("Exa")
export const tavilyFetch = createSearchProviderFetch("Tavily")
export const perplexityFetch = createSearchProviderFetch("Perplexity")
export const serperFetch = createSearchProviderFetch("Serper")

export default searchFetch
