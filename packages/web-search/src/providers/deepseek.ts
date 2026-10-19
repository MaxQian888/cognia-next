/**
 * DeepSeek Search and Fetch provider.
 *
 * Two independent REST operations behind one Bearer key
 * (https://api-docs.deepseek.com/zh-cn/guides/search/, checked 2026-10-19):
 * - Search `POST /v1/tools/search` — `query` 1–128 chars, `count` 1–50; domain
 *   and date filters are query operators (`site:`, `-site:`, `after:`, `lang:`).
 * - Fetch `POST /v1/tools/fetch` — one `url` (≤ 8192 chars) → `{ title, content }`
 *   Markdown. 403 is the vendor's safety refusal, 404 "no usable content".
 *
 * Billing is per successful request (non-empty search, fetched content), so an
 * invalid request is rejected here before it can reach the vendor. Search
 * enablement never enables the Fetch reader; the Reader policy owns that.
 */

import type { SearchOptions, SearchRecency, SearchResponse, SearchResult } from "../types"
import { deepseekFetch, ProviderHttpError, readErrorDetail } from "../proxy-search-fetch"

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search"
export const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch"

/** Vendor bounds, enforced before the request is sent. */
export const DEEPSEEK_QUERY_MAX_CHARS = 128
export const DEEPSEEK_COUNT_MAX = 50
export const DEEPSEEK_FETCH_URL_MAX_CHARS = 8192

interface DeepSeekSearchResult {
  rerank_score?: number
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  site_name?: string | null
  site_icon?: string | null
  date?: string | null
}

interface DeepSeekSearchApiResponse {
  results?: DeepSeekSearchResult[]
}

interface DeepSeekFetchApiResponse {
  title?: string
  content?: string
}

function isoDateFor(recency: SearchRecency | undefined, now: number): string | undefined {
  const days: Partial<Record<SearchRecency, number>> = { day: 1, week: 7, month: 31, year: 366 }
  const span = recency ? days[recency] : undefined
  if (!span) return undefined
  return new Date(now - span * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Append filter operators while the composed query stays within the vendor's
 * 128-character bound. Operators that do not fit are left out (the host still
 * applies domain policy to the results); the bare query never is.
 */
export function composeDeepSeekQuery(
  query: string,
  options: Pick<SearchOptions, "includeDomains" | "excludeDomains" | "recency" | "language">,
  now: number = Date.now()
): string {
  const operators: string[] = []
  // A single include domain maps to `site:`; several would AND together, so
  // they are left to the host-side include filter instead.
  if (options.includeDomains?.length === 1) operators.push(`site:${options.includeDomains[0]}`)
  for (const domain of options.excludeDomains ?? []) operators.push(`-site:${domain}`)
  const after = isoDateFor(options.recency, now)
  if (after) operators.push(`after:${after}`)
  if (options.language) operators.push(`lang:${options.language}`)
  let composed = query
  for (const op of operators) {
    const next = `${composed} ${op}`
    if ([...next].length > DEEPSEEK_QUERY_MAX_CHARS) continue
    composed = next
  }
  return composed
}

export async function searchWithDeepSeek(
  query: string,
  apiKey: string,
  options: SearchOptions = {}
): Promise<SearchResponse> {
  if (!apiKey) throw new Error("DeepSeek API key is required")
  const trimmed = query.trim()
  const length = [...trimmed].length
  if (length === 0 || length > DEEPSEEK_QUERY_MAX_CHARS) {
    throw new ProviderHttpError(
      "DeepSeek",
      400,
      `query must be 1-${DEEPSEEK_QUERY_MAX_CHARS} characters (got ${length})`
    )
  }
  const count = Math.min(Math.max(1, Math.floor(options.maxResults ?? 10)), DEEPSEEK_COUNT_MAX)
  const needContent = Boolean(options.includeRawContent)
  const startTime = Date.now()

  const response = await deepseekFetch(DEEPSEEK_SEARCH_URL, {
    method: "POST",
    signal: options.signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: composeDeepSeekQuery(trimmed, options),
      count,
      need_content: needContent,
    }),
  })
  if (!response.ok) {
    const { detail, code } = await readErrorDetail(response)
    throw new ProviderHttpError("DeepSeek", response.status, detail, code)
  }
  const data = (await response.json()) as DeepSeekSearchApiResponse
  const results: SearchResult[] = (data.results ?? [])
    .filter(
      (r): r is DeepSeekSearchResult & { url: string } => typeof r.url === "string" && r.url !== ""
    )
    .map((r, index) => ({
      title: r.title ?? r.url,
      url: r.url,
      content: r.snippet || r.summary || "",
      score: typeof r.rerank_score === "number" ? r.rerank_score : 1 / (index + 1),
      ...(r.date ? { publishedDate: r.date } : {}),
      ...(r.site_name ? { source: r.site_name } : {}),
      ...(r.site_icon ? { favicon: r.site_icon } : {}),
      ...(needContent && r.content ? { rawContent: r.content } : {}),
    }))
  return {
    provider: "deepseek",
    query,
    results,
    responseTime: Date.now() - startTime,
    totalResults: results.length,
  }
}

export interface DeepSeekFetchResult {
  title?: string
  markdown: string
}

/** Read one URL through DeepSeek Fetch. Throws {@link ProviderHttpError} on a vendor failure. */
export async function fetchWithDeepSeek(
  url: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<DeepSeekFetchResult> {
  if (!apiKey) throw new Error("DeepSeek API key is required")
  if (url.length > DEEPSEEK_FETCH_URL_MAX_CHARS) {
    throw new ProviderHttpError(
      "DeepSeek",
      400,
      `url exceeds ${DEEPSEEK_FETCH_URL_MAX_CHARS} characters`
    )
  }
  const response = await deepseekFetch(DEEPSEEK_FETCH_URL, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  if (!response.ok) {
    const { detail, code } = await readErrorDetail(response)
    throw new ProviderHttpError("DeepSeek", response.status, detail, code)
  }
  const data = (await response.json()) as DeepSeekFetchApiResponse
  return { ...(data.title ? { title: data.title } : {}), markdown: data.content ?? "" }
}

export async function testDeepSeekConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithDeepSeek("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
