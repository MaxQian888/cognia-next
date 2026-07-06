/**
 * YouTube scraper — title + description + transcript, no yt-dlp.
 *
 * We fetch the watch page, pull the embedded `ytInitialPlayerResponse` JSON,
 * read `videoDetails` for the title/description and
 * `captions.playerCaptionsTracklistRenderer.captionTracks` for a caption track,
 * then fetch + parse the timed-text XML into a plain transcript. English tracks
 * are preferred, else the first available; auto-generated captions are fine.
 */

import type { ReaderFetch, ReaderResult } from "../types"

/** Cap transcript length so a 3-hour video can't blow up the tool result. */
const TRANSCRIPT_CHAR_CAP = 40_000

export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null
    return u.searchParams.get("v")
  } catch {
    return null
  }
}

/**
 * Extract the first balanced `{…}` JSON object that appears after `marker`,
 * respecting string literals + escapes. Robust against the trailing garbage on
 * the same line (`;var …`) that a naive greedy/lazy regex chokes on.
 */
export function extractJsonAfter(text: string, marker: string): string | null {
  const start = text.indexOf(marker)
  if (start < 0) return null
  let i = text.indexOf("{", start)
  if (i < 0) return null
  const open = i
  let depth = 0
  let inStr = false
  let escaped = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] ?? m)
}

/** Parse YouTube timed-text XML (`<text …>line</text>`) into a transcript. */
export function parseTimedText(xml: string): string {
  const lines: string[] = []
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1] ?? ""
    const decoded = decodeEntities(decodeEntities(raw)).replace(/\s+/g, " ").trim()
    if (decoded) lines.push(decoded)
  }
  return lines.join(" ")
}

interface CaptionTrack {
  baseUrl?: string
  languageCode?: string
  kind?: string
}

interface PlayerResponse {
  videoDetails?: {
    title?: string
    shortDescription?: string
    author?: string
  }
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[]
    }
  }
}

function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null
  const en = tracks.find((t) => t.languageCode?.toLowerCase().startsWith("en"))
  return en ?? tracks[0]
}

export async function scrapeYouTube(
  url: string,
  fetchImpl: ReaderFetch,
  signal?: AbortSignal
): Promise<ReaderResult | null> {
  const id = extractVideoId(url)
  if (!id) return null

  let html: string
  try {
    const res = await fetchImpl(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      method: "GET",
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) return null
    html = await res.text()
  } catch {
    return null
  }

  const jsonStr = extractJsonAfter(html, "ytInitialPlayerResponse")
  if (!jsonStr) return null
  let player: PlayerResponse
  try {
    player = JSON.parse(jsonStr) as PlayerResponse
  } catch {
    return null
  }

  const details = player.videoDetails
  const title = details?.title?.trim()
  const description = details?.shortDescription?.trim()

  let transcript = ""
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  const track = pickTrack(tracks)
  if (track?.baseUrl) {
    try {
      const capRes = await fetchImpl(track.baseUrl, {
        method: "GET",
        ...(signal ? { signal } : {}),
      })
      if (capRes.ok) {
        transcript = parseTimedText(await capRes.text())
      }
    } catch {
      // No transcript — fall back to title + description only.
    }
  }

  const parts: string[] = []
  if (title) parts.push(`# ${title}`)
  if (details?.author) parts.push(`*by ${details.author}*`)
  if (description) parts.push("## Description", description)
  if (transcript) {
    const capped =
      transcript.length > TRANSCRIPT_CHAR_CAP
        ? transcript.slice(0, TRANSCRIPT_CHAR_CAP) + " …"
        : transcript
    parts.push("## Transcript", capped)
  }

  const markdown = parts.join("\n\n").trim()
  if (!markdown) return null

  return {
    markdown,
    ...(title ? { title } : {}),
    source: "youtube",
    url,
  }
}
