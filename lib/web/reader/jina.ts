/**
 * Jina Reader fallback (https://r.jina.ai).
 *
 * `r.jina.ai/<url>` proxy-renders a page (executing JS) and returns clean
 * Markdown. We use it ONLY as a fallback when local cheerio extraction came
 * back empty/too thin (a JS-rendered SPA) — never for every fetch — so the
 * common case never leaves the machine and only pages the local parser can't
 * read are proxied. The `url` the model already chose to fetch is all that is
 * sent.
 */

import type { ReaderFetch, ReaderResult } from "./types"

const JINA_ENDPOINT = "https://r.jina.ai/"

/**
 * Read a URL through Jina Reader. Returns `null` (never throws) on any
 * failure so the caller can fall back to whatever local extraction it has.
 */
export async function fetchViaJina(
  url: string,
  fetchImpl: ReaderFetch,
  signal?: AbortSignal
): Promise<ReaderResult | null> {
  try {
    const res = await fetchImpl(`${JINA_ENDPOINT}${url}`, {
      method: "GET",
      headers: { "X-Return-Format": "markdown", Accept: "text/plain" },
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return null
    const body = (await res.text()).trim()
    if (!body) return null
    return parseJinaBody(body, url)
  } catch {
    return null
  }
}

/**
 * Jina prefixes its Markdown with a small header:
 *
 *   Title: <title>
 *   URL Source: <url>
 *   Markdown Content:
 *   <markdown…>
 *
 * Strip the header into `title` + body; if the markers are absent, treat the
 * whole payload as Markdown.
 */
export function parseJinaBody(body: string, url: string): ReaderResult {
  const titleMatch = /^Title:\s*(.+)$/m.exec(body)
  const title = titleMatch?.[1]?.trim()
  const marker = "Markdown Content:"
  const idx = body.indexOf(marker)
  const markdown = idx >= 0 ? body.slice(idx + marker.length).trim() : body
  return {
    markdown,
    ...(title ? { title } : {}),
    source: "jina",
    url,
  }
}
