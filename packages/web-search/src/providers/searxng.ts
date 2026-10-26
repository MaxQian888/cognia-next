/**
 * SearXNG search provider — a user-run instance, no vendor key.
 *
 * `GET <baseUrl>/search?q=…&format=json` (https://docs.searxng.org/dev/
 * search_api.html, checked 2026-10-19). JSON output must be enabled in the
 * instance's `search.formats`; many public instances disable it and answer
 * 403, which surfaces as an actionable error rather than an empty result.
 *
 * The endpoint is validated by `validateSearchEndpoint`; a private/loopback
 * instance additionally needs the provider's explicit endpoint grant. That
 * grant covers this search endpoint only — it never widens `web_fetch`. A
 * redirect to another origin is refused so it cannot move the request (or a
 * granted private address) somewhere the user did not configure.
 */

import type {
  SafeSearchLevel,
  SearchImage,
  SearchOptions,
  SearchProviderSettings,
  SearchRecency,
  SearchResponse,
  SearchResult,
  SearchType,
} from "../types"
import { validateSearchEndpoint } from "../types"
import { ProviderHttpError, readErrorDetail, searxngFetch } from "../proxy-search-fetch"

/** A SearXNG engine name: instance-defined, so validated by shape only. */
export const SEARXNG_ENGINE_PATTERN = /^[a-z0-9][a-z0-9 _.-]{0,39}$/i

const CATEGORY: Record<SearchType, string> = {
  general: "general",
  news: "news",
  images: "images",
  videos: "videos",
  academic: "science",
}

const SAFESEARCH: Record<SafeSearchLevel, string> = { off: "0", moderate: "1", strict: "2" }

const TIME_RANGE: Partial<Record<SearchRecency, string>> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
}

interface SearXNGResult {
  title?: string
  url?: string | null
  content?: string
  engine?: string | null
  publishedDate?: string | null
  img_src?: string
  thumbnail?: string
  thumbnail_src?: string
  score?: number
}

interface SearXNGApiResponse {
  results?: SearXNGResult[]
}

export async function searchWithSearXNG(
  query: string,
  settings: Pick<SearchProviderSettings, "baseUrl" | "allowPrivateEndpoint" | "engine">,
  options: SearchOptions = {},
  searchType: SearchType = "general"
): Promise<SearchResponse> {
  const endpoint = validateSearchEndpoint(settings.baseUrl)
  if (!endpoint.ok || !endpoint.baseUrl) {
    throw new ProviderHttpError("SearXNG", 400, `invalid endpoint (${endpoint.issue ?? "missing"})`)
  }
  if (endpoint.isPrivate && settings.allowPrivateEndpoint !== true) {
    throw new ProviderHttpError("SearXNG", 403, "private endpoint has no explicit endpoint grant")
  }
  const params = new URLSearchParams({ q: query, format: "json", pageno: "1" })
  params.set("categories", CATEGORY[searchType])
  const engine = options.engine?.trim() || settings.engine?.trim()
  if (engine) {
    if (!SEARXNG_ENGINE_PATTERN.test(engine)) {
      throw new ProviderHttpError("SearXNG", 400, `invalid engine name "${engine}"`)
    }
    params.set("engines", engine)
  }
  if (options.language) params.set("language", options.language)
  const timeRange = options.recency ? TIME_RANGE[options.recency] : undefined
  if (timeRange) params.set("time_range", timeRange)
  if (options.safeSearch) params.set("safesearch", SAFESEARCH[options.safeSearch])

  const requestUrl = `${endpoint.baseUrl}/search?${params.toString()}`
  const startTime = Date.now()
  // Without the endpoint grant, ask the host transport to refuse private
  // targets too (the desktop proxy enforces it natively).
  const init: RequestInit & { blockPrivateHosts?: boolean } = {
    method: "GET",
    signal: options.signal,
    redirect: "error",
    headers: { Accept: "application/json" },
    ...(settings.allowPrivateEndpoint === true ? {} : { blockPrivateHosts: true }),
  }
  const response = await searxngFetch(requestUrl, init)
  // Transports that follow redirects regardless report the final URL; refuse
  // a response that came from a different origin than the configured one.
  if (response.url && new URL(response.url).origin !== new URL(endpoint.baseUrl).origin) {
    throw new ProviderHttpError("SearXNG", 400, "endpoint redirected to a different origin")
  }
  if (response.status === 403) {
    throw new ProviderHttpError(
      "SearXNG",
      403,
      "JSON output is disabled on this instance (enable `json` in search.formats)"
    )
  }
  if (!response.ok) {
    const { detail } = await readErrorDetail(response)
    throw new ProviderHttpError("SearXNG", response.status, detail)
  }
  const data = (await response.json()) as SearXNGApiResponse
  const limit = Math.max(1, Math.floor(options.maxResults ?? 10))
  const usable = (data.results ?? []).filter(
    (r): r is SearXNGResult & { url: string } => typeof r.url === "string" && r.url !== ""
  )

  if (searchType === "images") {
    const images: SearchImage[] = usable
      .filter((r) => r.img_src)
      .slice(0, limit)
      .map((r) => ({
        url: r.img_src!,
        ...(r.thumbnail_src || r.thumbnail ? { thumbnailUrl: r.thumbnail_src || r.thumbnail } : {}),
        ...(r.title ? { title: r.title } : {}),
      }))
    const results = usable.slice(0, limit).map((r, index) => toResult(r, index))
    return {
      provider: "searxng",
      query,
      results,
      images: images.length > 0 ? images : undefined,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  }

  const results = usable.slice(0, limit).map((r, index) => toResult(r, index))
  return {
    provider: "searxng",
    query,
    results,
    responseTime: Date.now() - startTime,
    totalResults: results.length,
  }
}

function toResult(r: SearXNGResult & { url: string }, index: number): SearchResult {
  return {
    title: r.title || r.url,
    url: r.url,
    content: r.content ?? "",
    // Instance scores are not comparable across engines; rank order is.
    score: 1 / (index + 1),
    ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
    ...(r.engine ? { source: r.engine } : {}),
    ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
  }
}

export async function testSearXNGConnection(
  settings: Pick<SearchProviderSettings, "baseUrl" | "allowPrivateEndpoint" | "engine">
): Promise<boolean> {
  try {
    await searchWithSearXNG("test", settings, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
