/**
 * URL → `RawSource` fetcher for the twin ingest pipeline.
 *
 * Stages a remote document (article / docs page / Markdown gist / …) as a twin
 * source. Extraction quality now goes through the shared web reader
 * (`lib/web/reader/*`): a per-platform scraper (WeChat / X / YouTube) when the
 * host matches, otherwise a generic fetch with cheerio readable-text
 * extraction, and an optional Jina Reader fallback for JS-rendered pages.
 *
 * The `fetchImpl` is injectable so the caller can pass a CORS-free fetch
 * (`createProxyFetch()` on Tauri, `pinnedFetch` on Capacitor); it defaults to
 * the global `fetch` (browser CORS applies).
 *
 * Returns clean text/Markdown + a heuristic title + a content-type hint. The
 * caller (source uploader) decides which `TwinSourceFormat` to assign.
 */

import { parseHTML } from "@cognia/document/parsers/html-parser"
import { scrapePlatform } from "@/lib/web/reader/dispatch"
import { fetchViaJina } from "@/lib/web/reader/jina"

const HTTP_TIMEOUT_MS = 30_000
/** Below this many extracted chars an HTML page is treated as locally unreadable. */
const MIN_LOCAL_EXTRACT = 200

export interface FetchedUrl {
  url: string
  title: string
  contentType: string
  text: string
}

export interface FetchUrlOptions {
  /** CORS-free fetch (e.g. `createProxyFetch()` / `pinnedFetch`). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Abort signal; when omitted a 30 s timeout is applied internally. */
  signal?: AbortSignal
  /** Enable the Jina Reader fallback for thin HTML extraction. Default false. */
  jinaFallback?: boolean
}

function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  return m?.[1]?.trim() || null
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split("/").filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
    return u.hostname
  } catch {
    return url
  }
}

/**
 * Fetch a single URL. Throws on network / non-2xx errors so the caller
 * can surface a meaningful message — silent failures are a footgun in
 * batch import flows.
 */
export async function fetchUrlAsRawSource(
  url: string,
  opts: FetchUrlOptions = {}
): Promise<FetchedUrl> {
  const fetchImpl = opts.fetchImpl ?? fetch

  // 1. Platform scraper (WeChat / X / YouTube) → clean Markdown. Returns null
  //    (no network) for every other host.
  try {
    const scraped = await scrapePlatform(url, fetchImpl, opts.signal)
    if (scraped && scraped.markdown.trim()) {
      return {
        url,
        title: scraped.title || deriveTitleFromUrl(url),
        contentType: "text/markdown",
        text: scraped.markdown,
      }
    }
  } catch {
    // Fall through to the generic path.
  }

  // 2. Generic fetch.
  let response: Response
  if (opts.signal) {
    response = await fetchImpl(url, { signal: opts.signal })
  } else {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      response = await fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  const raw = await response.text()
  const isHtml = contentType.toLowerCase().includes("html")

  let text = raw
  let title: string | null = null
  if (isHtml) {
    title = extractHtmlTitle(raw)
    try {
      const parsed = await parseHTML(raw, { includeLinks: false, includeImages: false })
      const extracted = parsed.text?.trim()
      if (extracted) text = extracted
      if (!title && parsed.title) title = parsed.title
    } catch {
      // Keep the raw body.
    }
  }

  // 3. Jina Reader fallback (opt-in) for JS-rendered pages cheerio can't read.
  if (opts.jinaFallback && isHtml && text.trim().length < MIN_LOCAL_EXTRACT) {
    try {
      const jina = await fetchViaJina(url, fetchImpl, opts.signal)
      if (jina && jina.markdown.trim().length > text.trim().length) {
        text = jina.markdown
        if (jina.title) title = jina.title
      }
    } catch {
      // Keep local extraction.
    }
  }

  return {
    url,
    title: title || deriveTitleFromUrl(url),
    contentType,
    text,
  }
}

/**
 * Pick a sensible `TwinSourceFormat` based on the response content type.
 * Returns "markdown" by default — most user input is already markdown-
 * friendly text and downstream chunking degrades gracefully.
 */
export function pickFormatForUrl(contentType: string): "html" | "markdown" {
  if (contentType.toLowerCase().includes("html")) return "html"
  return "markdown"
}
