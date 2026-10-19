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

import { isResponseTooLarge, readBodyBounded } from "@cognia/web-search/bounded-response"
import { RESPONSE_BYTE_CEILING } from "@cognia/web-search/operation-policy"
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
    const body = (await readBodyBounded(res, RESPONSE_BYTE_CEILING)).trim()
    if (!body) return null
    return parseJinaBody(body, url)
  } catch {
    return null
  }
}

export type JinaReadOutcome =
  { ok: true; result: ReaderResult; status: number } | { ok: false; status?: number; error: string }

/**
 * Status-preserving form of {@link fetchViaJina} for the configured Reader:
 * reports the Jina service status (a reader-service status, never the
 * origin's) and lets an abort propagate instead of collapsing it to `null`.
 */
export async function readViaJina(
  url: string,
  fetchImpl: ReaderFetch,
  signal?: AbortSignal,
  byteCeiling: number = RESPONSE_BYTE_CEILING
): Promise<JinaReadOutcome> {
  let res: Response
  try {
    res = await fetchImpl(`${JINA_ENDPOINT}${url}`, {
      method: "GET",
      headers: { "X-Return-Format": "markdown", Accept: "text/plain" },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!res.ok) return { ok: false, status: res.status, error: `Jina Reader returned ${res.status}` }
  let body: string
  try {
    // Same decoded-byte ceiling as a direct read: a reader service must not
    // be buffered whole before the output caps apply.
    body = (await readBodyBounded(res, byteCeiling)).trim()
  } catch (error) {
    if (signal?.aborted) throw error
    if (isResponseTooLarge(error)) return { ok: false, status: res.status, error: "too_large" }
    return {
      ok: false,
      status: res.status,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!body) return { ok: false, status: res.status, error: "empty_content" }
  return { ok: true, result: parseJinaBody(body, url), status: res.status }
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
