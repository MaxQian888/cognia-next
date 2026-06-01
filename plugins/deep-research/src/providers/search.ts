/**
 * Self-contained web search + page reading over Exa / Tavily.
 *
 * The plugin brings its own API key (from `ctx.secrets`/`ctx.config`) and hits
 * the provider HTTP API directly via `fetch` — no dependency on the host's
 * `lib/search`. On Tauri/Capacitor `fetch` is native (CORS-free); in a plain
 * browser the provider endpoints are the only reliable cross-origin path,
 * which is why reading prefers provider-supplied content + extract endpoints
 * before falling back to a direct page fetch.
 */
import type { ReadFn, SearchFn, SearchHit } from "../types"

export type SearchProviderId = "exa" | "tavily"

/**
 * Minimal `fetch` shape so providers can be unit-tested with a stub and so the
 * plugin never depends on a specific runtime's fetch typing. The real
 * `globalThis.fetch` satisfies this structurally.
 */
export interface FetchResponseLike {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FetchResponseLike>

export interface ProviderOptions {
  provider: SearchProviderId
  apiKey: string
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike
  /** Max characters of page content to keep when reading. */
  readMaxChars?: number
}

const DEFAULT_READ_MAX = 8_000
const MIN_INLINE_CONTENT = 400 // below this we try a real "read" rather than reuse the snippet

interface Resolved {
  provider: ProviderOptions["provider"]
  apiKey: string
  /** Resolved lazily — fetch may be absent at construction (jsdom) but present at call time. */
  getFetch: () => FetchLike
  readMaxChars: number
}

function resolve(opts: ProviderOptions): Resolved {
  // API key is known at build time, so validate it eagerly.
  if (!opts.apiKey) throw new Error(`missing API key for ${opts.provider}`)
  return {
    provider: opts.provider,
    apiKey: opts.apiKey,
    readMaxChars: opts.readMaxChars ?? DEFAULT_READ_MAX,
    getFetch: () => {
      const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
      if (!fetchImpl) throw new Error("no fetch implementation available")
      return fetchImpl
    },
  }
}

/** Build the engine's `search` dependency. */
export function makeSearchFn(opts: ProviderOptions): SearchFn {
  const r = resolve(opts)
  return async (query, limit) =>
    r.provider === "exa" ? exaSearch(r, query, limit) : tavilySearch(r, query, limit)
}

/** Build the engine's `read` dependency (provider content → extract → fetch). */
export function makeReadFn(opts: ProviderOptions): ReadFn {
  const r = resolve(opts)
  return async (url, hit) => {
    // Tier 1: reuse content the search already returned.
    if (hit && hit.content.trim().length >= MIN_INLINE_CONTENT) {
      return hit.content.slice(0, r.readMaxChars)
    }
    // Tier 2: provider extract endpoint.
    try {
      const extracted =
        r.provider === "exa" ? await exaContents(r, url) : await tavilyExtract(r, url)
      if (extracted.trim()) return extracted.slice(0, r.readMaxChars)
    } catch {
      // fall through to a direct fetch
    }
    // Tier 3: direct fetch + strip (works native; may be CORS-blocked in browser).
    try {
      const res = await r.getFetch()(url)
      if (!res.ok) return hit?.content ?? ""
      return stripHtml(await res.text()).slice(0, r.readMaxChars)
    } catch {
      return hit?.content ?? ""
    }
  }
}

// ── Exa ──────────────────────────────────────────────────────────────────────

async function exaSearch(r: Resolved, query: string, limit: number): Promise<SearchHit[]> {
  const body = JSON.stringify({
    query,
    numResults: limit,
    contents: { text: { maxCharacters: 1_200 } },
  })
  const data = await postJson(r, "https://api.exa.ai/search", body, { "x-api-key": r.apiKey })
  const results = asArray((data as { results?: unknown }).results)
  return results.map((row) => {
    const o = row as Record<string, unknown>
    return {
      title: str(o.title) || str(o.url),
      url: str(o.url),
      content: str(o.text) || str(o.summary),
      score: num(o.score),
      publishedDate: str(o.publishedDate) || undefined,
    }
  })
}

async function exaContents(r: Resolved, url: string): Promise<string> {
  const body = JSON.stringify({ ids: [url], text: { maxCharacters: r.readMaxChars } })
  const data = await postJson(r, "https://api.exa.ai/contents", body, { "x-api-key": r.apiKey })
  const results = asArray((data as { results?: unknown }).results)
  return results.length > 0 ? str((results[0] as Record<string, unknown>).text) : ""
}

// ── Tavily ───────────────────────────────────────────────────────────────────

async function tavilySearch(r: Resolved, query: string, limit: number): Promise<SearchHit[]> {
  const body = JSON.stringify({
    api_key: r.apiKey,
    query,
    max_results: limit,
    search_depth: "advanced",
    include_raw_content: true,
  })
  const data = await postJson(r, "https://api.tavily.com/search", body)
  const results = asArray((data as { results?: unknown }).results)
  return results.map((row) => {
    const o = row as Record<string, unknown>
    return {
      title: str(o.title) || str(o.url),
      url: str(o.url),
      content: str(o.raw_content) || str(o.content),
      score: num(o.score),
      publishedDate: str(o.published_date) || undefined,
    }
  })
}

async function tavilyExtract(r: Resolved, url: string): Promise<string> {
  const body = JSON.stringify({ api_key: r.apiKey, urls: [url] })
  const data = await postJson(r, "https://api.tavily.com/extract", body)
  const results = asArray((data as { results?: unknown }).results)
  return results.length > 0 ? str((results[0] as Record<string, unknown>).raw_content) : ""
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function postJson(
  r: Resolved,
  url: string,
  body: string,
  extraHeaders: Record<string, string> = {}
): Promise<unknown> {
  const res = await r.getFetch()(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body,
  })
  if (!res.ok) throw new Error(`${url} responded ${res.status}`)
  return res.json()
}

/** Strip scripts/styles/tags from HTML and collapse whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
