/**
 * TinyFish Search and Fetch provider.
 *
 * Contracts (https://docs.tinyfish.ai/search-api/reference,
 * https://docs.tinyfish.ai/fetch-api/reference, checked 2026-10-19):
 * - Search `GET https://api.search.tinyfish.ai` with query parameters and an
 *   `X-API-Key` header. No result-count parameter: the adapter slices.
 * - Fetch `POST https://api.fetch.tinyfish.ai` with `urls[]` (1–10). Per-URL
 *   failures arrive in `errors[]` under HTTP 200 and must not read as success.
 *
 * Commercial note (dated 2026-10-19): the docs describe a daily free allowance
 * and a 402 `INSUFFICIENT_CREDITS` once it and the wallet are exhausted; the
 * pricing page and the API reference disagree at that boundary. Nothing here
 * assumes zero cost and nothing ever tops up a wallet.
 */

import type {
  SearchOptions,
  SearchRecency,
  SearchResponse,
  SearchResult,
  SearchType,
} from "../types"
import { ProviderHttpError, readErrorDetail, tinyfishFetch } from "../proxy-search-fetch"

export const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai"
export const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai"
export const TINYFISH_QUERY_MAX_CHARS = 2000

interface TinyFishSearchItem {
  position?: number
  site_name?: string
  title?: string
  snippet?: string
  url?: string
  date?: string
  thumbnail_url?: string
}

interface TinyFishSearchApiResponse {
  query?: string
  results?: TinyFishSearchItem[]
  total_results?: number
}

const RECENCY_MINUTES: Partial<Record<SearchRecency, number>> = {
  day: 60 * 24,
  week: 60 * 24 * 7,
  month: 60 * 24 * 31,
  year: 60 * 24 * 366,
}

function domainType(searchType: SearchType | undefined): "web" | "news" | "research_paper" {
  if (searchType === "news") return "news"
  if (searchType === "academic") return "research_paper"
  return "web"
}

export async function searchWithTinyFish(
  query: string,
  apiKey: string,
  options: SearchOptions = {}
): Promise<SearchResponse> {
  if (!apiKey) throw new Error("TinyFish API key is required")
  const trimmed = query.trim()
  if (!trimmed || trimmed.length > TINYFISH_QUERY_MAX_CHARS) {
    throw new ProviderHttpError(
      "TinyFish",
      400,
      `query must be 1-${TINYFISH_QUERY_MAX_CHARS} characters (got ${trimmed.length})`
    )
  }
  const type = domainType(options.searchType)
  const params = new URLSearchParams({ query: trimmed, domain_type: type })
  if (options.language) params.set("language", options.language)
  if (options.includeDomains?.length)
    params.set("include_domains", options.includeDomains.join(","))
  if (options.excludeDomains?.length)
    params.set("exclude_domains", options.excludeDomains.join(","))
  // Research-paper search takes publication years, not minute recency.
  const minutes = options.recency ? RECENCY_MINUTES[options.recency] : undefined
  if (minutes && type !== "research_paper") params.set("recency_minutes", String(minutes))

  const startTime = Date.now()
  const response = await tinyfishFetch(`${TINYFISH_SEARCH_URL}?${params.toString()}`, {
    method: "GET",
    signal: options.signal,
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
  })
  if (!response.ok) {
    const { detail, code } = await readErrorDetail(response)
    throw new ProviderHttpError("TinyFish", response.status, detail, code)
  }
  const data = (await response.json()) as TinyFishSearchApiResponse
  const limit = Math.max(1, Math.floor(options.maxResults ?? 10))
  const results: SearchResult[] = (data.results ?? [])
    .filter(
      (r): r is TinyFishSearchItem & { url: string } => typeof r.url === "string" && r.url !== ""
    )
    .slice(0, limit)
    .map((r, index) => ({
      title: r.title ?? r.url,
      url: r.url,
      content: r.snippet ?? "",
      // Rank-derived only; TinyFish returns a position, not a relevance score.
      score: 1 / ((r.position ?? index + 1) || index + 1),
      ...(r.date ? { publishedDate: r.date } : {}),
      ...(r.site_name ? { source: r.site_name } : {}),
      ...(r.thumbnail_url ? { thumbnail: r.thumbnail_url } : {}),
    }))
  return {
    provider: "tinyfish",
    query,
    results,
    responseTime: Date.now() - startTime,
    totalResults: results.length,
  }
}

/** One TinyFish per-URL failure, as documented under `errors[]`. */
export interface TinyFishFetchError {
  url: string
  /** e.g. `page_not_found`, `bot_blocked`, `login_required`, `content_too_large`, `timeout`. */
  error: string
  /** Target site's HTTP status, present for `target_http_error` / `page_not_found`. */
  status?: number
}

interface TinyFishFetchApiResponse {
  results?: Array<{
    url?: string
    final_url?: string
    title?: string | null
    text?: string | null
    published_date?: string | null
  }>
  errors?: TinyFishFetchError[]
}

export type TinyFishFetchOutcome =
  | { ok: true; title?: string; markdown: string; finalUrl?: string; publishedDate?: string }
  | { ok: false; error: TinyFishFetchError }

/**
 * Read exactly one URL through TinyFish Fetch as Markdown. A per-URL failure
 * returns `{ ok: false }` (HTTP 200 with `errors[]`); a request-level failure
 * throws {@link ProviderHttpError}.
 */
export async function fetchWithTinyFish(
  url: string,
  apiKey: string,
  options: { signal?: AbortSignal; perUrlTimeoutMs?: number } = {}
): Promise<TinyFishFetchOutcome> {
  if (!apiKey) throw new Error("TinyFish API key is required")
  const body: Record<string, unknown> = { urls: [url], format: "markdown" }
  if (options.perUrlTimeoutMs) {
    body.per_url_timeout_ms = Math.min(110_000, Math.max(1, Math.floor(options.perUrlTimeoutMs)))
  }
  const response = await tinyfishFetch(TINYFISH_FETCH_URL, {
    method: "POST",
    signal: options.signal,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const { detail, code } = await readErrorDetail(response)
    throw new ProviderHttpError("TinyFish", response.status, detail, code)
  }
  const data = (await response.json()) as TinyFishFetchApiResponse
  const failure = data.errors?.[0]
  if (failure) return { ok: false, error: failure }
  const result = data.results?.[0]
  if (!result || typeof result.text !== "string" || !result.text.trim()) {
    return { ok: false, error: { url, error: "empty_content" } }
  }
  return {
    ok: true,
    markdown: result.text,
    ...(result.title ? { title: result.title } : {}),
    ...(result.final_url ? { finalUrl: result.final_url } : {}),
    ...(result.published_date ? { publishedDate: result.published_date } : {}),
  }
}

export async function testTinyFishConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithTinyFish("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
