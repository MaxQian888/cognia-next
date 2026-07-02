/**
 * X / Twitter scraper.
 *
 * x.com is a JS-only, increasingly auth-walled SPA that returns no usable
 * article HTML. The community-standard workaround is the public FxTwitter API
 * (api.fxtwitter.com), which resolves a tweet id to structured JSON. Only the
 * public tweet id (already in the URL the model chose to fetch) is sent.
 */

import type { ReaderFetch, ReaderResult } from "../types"

/** Pull the numeric status id from an x.com / twitter.com status URL. */
export function extractTweetId(url: string): string | null {
  const m = /\/status(?:es)?\/(\d+)/.exec(url)
  return m?.[1] ?? null
}

interface FxTweetAuthor {
  name?: string
  screen_name?: string
}

interface FxTweetMedia {
  photos?: { url?: string }[]
  videos?: { url?: string }[]
}

interface FxTweet {
  text?: string
  author?: FxTweetAuthor
  url?: string
  created_at?: string
  media?: FxTweetMedia
  quote?: FxTweet
}

interface FxResponse {
  code?: number
  tweet?: FxTweet
}

function renderTweet(tweet: FxTweet, depth = 0): string {
  const lines: string[] = []
  const author = tweet.author
  if (author?.name || author?.screen_name) {
    const handle = author.screen_name ? ` (@${author.screen_name})` : ""
    lines.push(`**${author.name ?? author.screen_name}${handle}**`)
  }
  if (tweet.text) lines.push(tweet.text)
  const photos = tweet.media?.photos?.map((p) => p.url).filter(Boolean) ?? []
  const videos = tweet.media?.videos?.map((v) => v.url).filter(Boolean) ?? []
  for (const p of photos) lines.push(`![image](${p})`)
  for (const v of videos) lines.push(`[video](${v})`)
  // Quoted tweet — one level deep is enough; guard against pathological chains.
  if (tweet.quote && depth < 1) {
    const quoted = renderTweet(tweet.quote, depth + 1)
    if (quoted) lines.push("", "> " + quoted.split("\n").join("\n> "))
  }
  return lines.join("\n\n")
}

export async function scrapeX(
  url: string,
  fetchImpl: ReaderFetch,
  signal?: AbortSignal
): Promise<ReaderResult | null> {
  const id = extractTweetId(url)
  if (!id) return null
  let data: FxResponse
  try {
    const res = await fetchImpl(`https://api.fxtwitter.com/status/${id}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return null
    data = (await res.json()) as FxResponse
  } catch {
    return null
  }

  const tweet = data?.tweet
  if (!tweet?.text) return null

  const markdown = renderTweet(tweet).trim()
  if (!markdown) return null

  const author = tweet.author
  const title = author?.name
    ? `Tweet by ${author.name}${author.screen_name ? ` (@${author.screen_name})` : ""}`
    : "Tweet"

  return { markdown, title, source: "x", url }
}
