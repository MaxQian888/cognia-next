/**
 * Shared implementation for the first-class web tools (web_search + web_fetch).
 *
 * Extracted verbatim from `plugins/web-tools/src/index.ts` so the logic can be
 * reused by BOTH the promoted built-in tools (host-routed via
 * `lib/claude/web-builtin-tools.ts`) and the web-tools plugin's own wrappers.
 * The only behavioral change vs. the plugin is that `webSearch` takes
 * `providerSettings` as an explicit parameter instead of reading the renderer
 * settings store — this is what lets it run on the CLI host (no Zustand store)
 * as well as the desktop renderer.
 *
 * Reuses the app's existing infrastructure rather than reimplementing:
 *   - multi-provider web search → `lib/search/search-service`
 *   - readable HTML → text extraction → `lib/document/parsers/html-parser`
 */

import { search, formatSearchResultsForLLM } from "@/lib/search/search-service"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  isProviderConfigured,
  type SearchProviderType,
  type SearchProviderSettings,
} from "@/lib/search/types"
import { parseHTML } from "@/lib/document/parsers/html-parser"

/** How `web_fetch` should present the response body. */
export type FetchFormat = "auto" | "text" | "raw"

export interface WebFetchArgs {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  /**
   * `auto` (default) extracts readable text for HTML responses and returns the
   * raw body for everything else; `text` forces extraction; `raw` skips it.
   */
  format?: FetchFormat
}

export interface WebSearchArgs {
  query: string
  /** Force a specific provider; defaults to the user's configured default. */
  provider?: SearchProviderType
  maxResults?: number
}

export interface WebFetchDeps {
  /** Optional User-Agent header for outbound requests. */
  userAgent?: string
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface WebSearchDeps {
  /** The user's configured search-provider settings (keys, enabled flags). */
  providerSettings?: Partial<Record<SearchProviderType, SearchProviderSettings>>
  /** Default max results when the caller doesn't specify. */
  searchMaxResults?: number
  /** Whether to fall back to other providers on failure. Default true. */
  searchFallbackEnabled?: boolean
}

const DEFAULT_MAX = 256 * 1024

/** Perform an HTTP request and return the body (+ readable text for HTML). */
export async function webFetch(args: WebFetchArgs, deps: WebFetchDeps = {}): Promise<unknown> {
  if (!args.url) {
    return { ok: false as const, error: "url is required" }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (deps.userAgent && !headers["User-Agent"]) headers["User-Agent"] = deps.userAgent
  try {
    const res = await fetchImpl(args.url, {
      method: args.method ?? "GET",
      headers,
      body: args.body,
    })
    const cap = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX
    const raw = await res.text()
    const body = raw.length > cap ? raw.slice(0, cap) : raw
    const contentType = res.headers.get?.("content-type") ?? ""
    const format: FetchFormat = args.format ?? "auto"
    // HTML pages are mostly markup the model shouldn't wade through, so for
    // HTML responses we add a clean `text` (+ `title`) alongside the raw body.
    const wantsExtract = format !== "raw" && (format === "text" || /html/i.test(contentType))
    let extracted: { text: string; title?: string } | undefined
    if (wantsExtract && res.ok && raw) {
      try {
        const parsed = await parseHTML(raw, { includeLinks: false, includeImages: false })
        const text = parsed.text?.trim() ?? ""
        if (text) {
          extracted = {
            text: text.length > cap ? text.slice(0, cap) : text,
            ...(parsed.title ? { title: parsed.title } : {}),
          }
        }
      } catch {
        // Malformed HTML — fall back to the raw body the caller still receives.
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      url: args.url,
      headers: Object.fromEntries(res.headers.entries()),
      body,
      truncated: raw.length > cap,
      ...(extracted ? { text: extracted.text, title: extracted.title } : {}),
    }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Multi-provider web search over the user's configured providers. */
export async function webSearch(args: WebSearchArgs, deps: WebSearchDeps = {}): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { ok: false as const, error: "query is required" }
  }
  const providerSettings = deps.providerSettings ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  const configured = Object.values(providerSettings).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  )
  if (configured.length === 0) {
    return {
      ok: false as const,
      error:
        "No web search provider is configured. Enable one and add its API key in Settings → Search.",
    }
  }
  try {
    const response = await search(query, {
      providerSettings,
      ...(args.provider ? { provider: args.provider } : {}),
      ...(typeof args.maxResults === "number" ? { maxResults: args.maxResults } : {}),
      ...(typeof deps.searchMaxResults === "number" && args.maxResults == null
        ? { maxResults: deps.searchMaxResults }
        : {}),
      fallbackEnabled: deps.searchFallbackEnabled ?? true,
    })
    return {
      ok: true as const,
      query,
      provider: response.provider,
      answer: response.answer ?? null,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      })),
      // A ready-to-read block the model can cite directly.
      formatted: formatSearchResultsForLLM(response),
    }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}
