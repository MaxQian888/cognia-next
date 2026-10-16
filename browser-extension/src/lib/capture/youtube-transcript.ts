import type { BrowserTranscriptV1 } from "@cognia/companion-client"

export function isYouTubeWatchUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (!/^https?:$/.test(url.protocol)) return false
    if (url.hostname === "youtu.be") return /^\/[\w-]+\/?$/.test(url.pathname)
    if (
      !["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(
        url.hostname
      )
    )
      return false
    return (
      (url.pathname === "/watch" && /^[\w-]+$/.test(url.searchParams.get("v") ?? "")) ||
      /^\/(shorts|live)\/[\w-]+\/?$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

/** Serialized into MAIN by Chrome; all runtime dependencies must stay inside. */
export async function readYouTubeTranscript(
  preferredLanguage: string
): Promise<BrowserTranscriptV1> {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const videoId = (raw: string): string | null => {
    try {
      const url = new URL(raw)
      if (!/^https?:$/.test(url.protocol)) return null
      if (url.hostname === "youtu.be") return url.pathname.match(/^\/([\w-]+)\/?$/)?.[1] ?? null
      if (
        !["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(
          url.hostname
        )
      )
        return null
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v") ?? ""
        return /^[\w-]+$/.test(id) ? id : null
      }
      return url.pathname.match(/^\/(?:shorts|live)\/([\w-]+)\/?$/)?.[1] ?? null
    } catch {
      return null
    }
  }
  const currentId = videoId(window.location.href)
  if (!currentId) return { status: "unavailable", reason: "not_a_video" }
  try {
    const player = document.querySelector("#movie_player") as
      (Element & { getPlayerResponse?: () => unknown }) | null
    let response: Record<string, unknown> = {}
    try {
      response = object(player?.getPlayerResponse?.())
    } catch {
      /* Fall back to the page's initial response. */
    }
    if (object(response.videoDetails).videoId !== currentId) {
      response = object(
        (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse
      )
    }
    // SPA navigation can leave a perfectly usable response for a different video.
    if (object(response.videoDetails).videoId !== currentId)
      return { status: "unavailable", reason: "fetch_failed" }
    const renderer = object(object(response.captions).playerCaptionsTracklistRenderer)
    const tracks = array(renderer.captionTracks).map(object)
    if (!tracks.length) return { status: "unavailable", reason: "no_captions" }
    const preferred = preferredLanguage.trim().toLowerCase()
    const primary = preferred.split("-")[0]
    const language = (track: Record<string, unknown>): string =>
      typeof track.languageCode === "string" ? track.languageCode.toLowerCase() : ""
    const audioTracks = array(renderer.audioTracks)
    const audio = object(
      audioTracks[
        typeof renderer.defaultAudioTrackIndex === "number" ? renderer.defaultAudioTrackIndex : 0
      ]
    )
    const defaultIndex = audio.defaultCaptionTrackIndex ?? renderer.defaultCaptionTrackIndex
    const defaultTrack = typeof defaultIndex === "number" ? tracks[defaultIndex] : undefined
    const track =
      (preferred ? tracks.find((item) => language(item) === preferred) : undefined) ||
      (primary
        ? tracks.find((item) => language(item) === primary) ||
          tracks.find((item) => language(item).split("-")[0] === primary)
        : undefined) ||
      defaultTrack ||
      tracks.find((item) => item.isDefault === true) ||
      tracks.find((item) => item.kind !== "asr") ||
      tracks[0]
    if (!track || typeof track.baseUrl !== "string")
      return { status: "unavailable", reason: "fetch_failed" }
    const url = new URL(track.baseUrl, window.location.href)
    if (!/^https?:$/.test(url.protocol)) return { status: "unavailable", reason: "fetch_failed" }
    url.searchParams.set("fmt", "json3")
    const result = await fetch(url.href, { credentials: "same-origin" })
    if (!result.ok) return { status: "unavailable", reason: "fetch_failed" }
    const payload = object(await result.json())
    const lines = array(payload.events).flatMap((value) => {
      const event = object(value)
      const text = array(event.segs)
        .map((segment) => {
          const utf8 = object(segment).utf8
          return typeof utf8 === "string" ? utf8 : ""
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim()
      if (!text) return []
      const seconds =
        typeof event.tStartMs === "number" && Number.isFinite(event.tStartMs)
          ? Math.max(0, Math.floor(event.tStartMs / 1000))
          : 0
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const timestamp = hours
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
        : `${minutes}:${String(seconds % 60).padStart(2, "0")}`
      return [`[${timestamp}] ${text}`]
    })
    if (!lines.length || videoId(window.location.href) !== currentId)
      return { status: "unavailable", reason: "fetch_failed" }
    return {
      status: "available",
      text: lines.join("\n"),
      truncated: false,
      ...(typeof track.languageCode === "string" ? { language: track.languageCode } : {}),
      autoGenerated: track.kind === "asr",
    }
  } catch {
    return { status: "unavailable", reason: "fetch_failed" }
  }
}
