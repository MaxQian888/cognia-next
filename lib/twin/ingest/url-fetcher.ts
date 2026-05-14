/**
 * URL → `RawSource` fetcher for the twin ingest pipeline.
 *
 * Fetches a remote document (article / docs page / Markdown gist / …)
 * and stages it as a twin source the workbench can ingest. We use the
 * native `fetch()` API everywhere — Tauri's window-context fetch is
 * already same-origin-bypass-friendly via `tauri.conf.json` allowlist,
 * and the web build accepts whatever CORS allows. A future M7 polish
 * could lazy-import `@tauri-apps/plugin-http` for CORS-bypass on Tauri,
 * but the plugin isn't a current dependency.
 *
 * Returns the raw text + a heuristic title + a content-type hint. The
 * caller (source uploader) decides which `TwinSourceFormat` to assign
 * (markdown / html / code) — usually html.
 */

const HTTP_TIMEOUT_MS = 30_000

export interface FetchedUrl {
  url: string
  title: string
  contentType: string
  text: string
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
export async function fetchUrlAsRawSource(url: string): Promise<FetchedUrl> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }
  const contentType = response.headers.get("content-type") ?? ""
  const text = await response.text()
  const titleFromHtml = contentType.includes("html") ? extractHtmlTitle(text) : null
  return {
    url,
    title: titleFromHtml || deriveTitleFromUrl(url),
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
