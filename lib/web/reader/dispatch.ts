/**
 * Hostname → platform-scraper routing for the web reader.
 *
 * `scrapePlatform` is tried BEFORE the generic fetch+extract in `web_fetch`:
 * for the handful of sites where a bespoke scraper beats generic extraction
 * (WeChat, X/Twitter, YouTube) it returns clean Markdown; for everything else
 * it returns `null` and the caller falls through to local extraction (and, if
 * that is too thin, the Jina fallback).
 */

import { scrapeWeChat } from "./platform-scrapers/wechat"
import { scrapeX } from "./platform-scrapers/x-twitter"
import { scrapeYouTube } from "./platform-scrapers/youtube"
import { safeHostname, type ReaderFetch, type ReaderResult } from "./types"

function isHost(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

/**
 * Which Reader a URL's platform scraper belongs to: `platform` for scrapers
 * that read the origin site itself (WeChat, YouTube), `fxtwitter` for X posts,
 * which go to the third-party FxTwitter API. `null` when no scraper applies.
 */
export function platformReaderFor(url: string): "platform" | "fxtwitter" | null {
  const host = safeHostname(url)
  if (!host) return null
  if (isHost(host, "mp.weixin.qq.com")) return "platform"
  if (isHost(host, "youtube.com") || isHost(host, "youtu.be")) return "platform"
  if (isHost(host, "x.com") || isHost(host, "twitter.com")) return "fxtwitter"
  return null
}

/**
 * Route a URL to its platform scraper, or return `null` when no scraper
 * applies. Never throws — individual scrapers swallow their own failures.
 */
export async function scrapePlatform(
  url: string,
  fetchImpl: ReaderFetch,
  signal?: AbortSignal
): Promise<ReaderResult | null> {
  const host = safeHostname(url)
  if (!host) return null

  if (isHost(host, "mp.weixin.qq.com")) return scrapeWeChat(url, fetchImpl, signal)
  if (isHost(host, "x.com") || isHost(host, "twitter.com")) return scrapeX(url, fetchImpl, signal)
  if (isHost(host, "youtube.com") || isHost(host, "youtu.be")) {
    return scrapeYouTube(url, fetchImpl, signal)
  }
  return null
}
