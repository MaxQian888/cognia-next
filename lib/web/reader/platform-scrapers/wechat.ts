/**
 * WeChat MP article scraper (mp.weixin.qq.com).
 *
 * WeChat articles put the real body in `#js_content` and the title in
 * `#activity-name`; the surrounding page is boilerplate the generic extractor
 * mangles. We fetch the origin HTML directly, pull those two nodes, and convert
 * the body to Markdown with the shared `htmlToMarkdown` walker.
 */

import { htmlToMarkdown } from "@cognia/document/parsers/html-parser"
import type { ReaderFetch, ReaderResult } from "../types"

export async function scrapeWeChat(
  url: string,
  fetchImpl: ReaderFetch,
  signal?: AbortSignal
): Promise<ReaderResult | null> {
  let html: string
  try {
    const res = await fetchImpl(url, { method: "GET", ...(signal ? { signal } : {}) })
    if (!res.ok) return null
    html = await res.text()
  } catch {
    return null
  }
  if (!html) return null

  const cheerio = await import("cheerio")
  const $ = cheerio.load(html)

  const title =
    $("#activity-name").text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    undefined

  const content = $("#js_content")
  if (content.length === 0) return null
  const inner = content.html()
  if (!inner) return null

  const markdown = (await htmlToMarkdown(inner)).trim()
  if (!markdown) return null

  return {
    markdown,
    ...(title ? { title } : {}),
    source: "wechat",
    url,
  }
}
