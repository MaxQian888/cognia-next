/**
 * Proxy-aware Fetch for Search Providers
 *
 * In cognia-next we don't (yet) have a project-wide proxy abstraction. This
 * module mirrors the surface of Cognia's `proxy-search-fetch` so provider
 * files compile unchanged — internally it just delegates to the global
 * `fetch`. When proxy support lands, swap the implementation here.
 */

import { log } from "./log"

/**
 * Search-specific fetch. Currently a thin wrapper over `fetch`; kept as a
 * named export so providers (and the rest of the codebase) can later be
 * pointed at a proxy-aware fetch without touching call sites.
 */
export async function searchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init)
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
