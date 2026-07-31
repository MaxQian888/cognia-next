/**
 * Shared types for the web reader (`lib/web/reader/*`).
 *
 * The reader upgrades `web_fetch` / twin URL ingest from a shallow cheerio text
 * dump to clean Markdown, via (1) per-platform scrapers keyed off the hostname
 * and (2) a Jina Reader fallback for JS-rendered pages the local parser can't
 * see. Every network call is done through an INJECTED `fetchImpl` so the same
 * pure module works on the renderer (CORS-free via `proxy_http_request`), on
 * Capacitor (native `CapacitorHttp`), and in tests (a stub).
 */

/** Injectable fetch — same shape as the global `fetch`. */
export type ReaderFetch = typeof fetch

/** Where a reader result came from — surfaced for observability + tests. */
export type ReaderSource = "wechat" | "x" | "youtube" | "jina"

export interface ReaderResult {
  /** Clean Markdown body of the page. */
  markdown: string
  /** Best-effort page/article title. */
  title?: string
  /** Which reader produced this. */
  source: ReaderSource
  /** The original URL that was read. */
  url: string
}

/** Parse a hostname from a URL, returning null on malformed input. */
export function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}
