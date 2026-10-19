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
import { limitResponseBody } from "./bounded-response"
import { RESPONSE_BYTE_CEILING } from "./operation-policy"

/**
 * Search-specific fetch. Resolves the installed transport per call: providers
 * import this module at evaluation time, before the host's boot initializer
 * runs, so binding the transport once at import would pin the inert default.
 */
export async function searchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Every provider body is read under the shared decoded-byte ceiling, so a
  // runaway endpoint (a self-hosted SearXNG included) cannot be buffered,
  // parsed or cached whole.
  return limitResponseBody(await webSearchFetch(input, init), RESPONSE_BYTE_CEILING)
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
export const deepseekFetch = createSearchProviderFetch("DeepSeek")
export const tinyfishFetch = createSearchProviderFetch("TinyFish")
export const searxngFetch = createSearchProviderFetch("SearXNG")

/**
 * An HTTP failure from a vendor API, carrying the status so the retry
 * classifier and the Reader's failure mapping read it from the field instead
 * of parsing the message. The message keeps the `<Vendor> API error: <status>`
 * shape every adapter already used.
 */
export class ProviderHttpError extends Error {
  readonly status: number
  readonly vendorCode?: string
  constructor(vendor: string, status: number, detail: string, vendorCode?: string) {
    super(`${vendor} API error: ${status}${detail ? ` - ${detail}` : ""}`)
    this.name = "ProviderHttpError"
    this.status = status
    this.vendorCode = vendorCode
  }
}

/** Read a bounded, single-line error detail from a failed response. */
export async function readErrorDetail(
  response: Response
): Promise<{ detail: string; code?: string }> {
  const text = await response.text().catch(() => "")
  let detail = text
  let code: string | undefined
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string; code?: string | number; type?: string }
      message?: string
      tag?: string
      detail?: string
    }
    if (typeof parsed.error === "string") detail = parsed.error
    else if (parsed.error && typeof parsed.error === "object") {
      detail = parsed.error.message ?? detail
      if (parsed.error.code != null) code = String(parsed.error.code)
    } else if (parsed.message) detail = parsed.message
    else if (parsed.detail) detail = parsed.detail
    if (!code && parsed.tag) code = parsed.tag
  } catch {
    // Not JSON — keep the raw text.
  }
  return { detail: detail.replace(/\s+/g, " ").trim().slice(0, 300), code }
}

export default searchFetch
