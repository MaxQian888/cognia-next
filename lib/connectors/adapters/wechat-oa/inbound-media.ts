import {
  enrichInboundMedia,
  onceAsync,
  isPublicHttpUrl,
  sniffImageMediaType,
  type InboundMediaDeps,
} from "@/lib/connectors/adapters/_shared/inbound-media"
import {
  connectorsAttachmentFetch,
  connectorsAttachmentRead,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/tauri"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface WechatInboundMediaDeps extends InboundMediaDeps {
  accessToken: () => Promise<string>
  apiBase: string
  httpRequest?: typeof connectorsHttpRequest
}

function mediaId(url: string | undefined): string | undefined {
  return url?.startsWith("wxmedia://") ? url.slice("wxmedia://".length) || undefined : undefined
}

/** Resolve temporary media through the encrypted cache before the event enters the bus. */
export async function enrichWechatInboundMedia(
  event: NormalizedInboundEvent,
  deps: WechatInboundMediaDeps
): Promise<void> {
  if (!(deps.enabled ?? isTauri())) return
  const read = deps.readAttachment ?? connectorsAttachmentRead
  const boundedRead: typeof connectorsAttachmentRead = async (adapterId, ref, cap) => {
    const bytes = await read(adapterId, ref, cap)
    if (
      !bytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes) ||
      (bytes.length * 3) / 4 - (bytes.endsWith("==") ? 2 : bytes.endsWith("=") ? 1 : 0) > cap
    )
      return null
    // The media API returns a JSON error envelope on HTTP 200. A cache hit
    // still needs validation before those bytes become a display data URL.
    const prefix = atob(bytes.slice(0, 256)).trimStart()
    if (/^[{[<]/.test(prefix)) return null
    return bytes
  }
  const token = onceAsync(deps.accessToken)
  const source = async (id: string) =>
    `${deps.apiBase}/cgi-bin/media/get?access_token=${encodeURIComponent(await token())}&media_id=${encodeURIComponent(id)}`
  await enrichInboundMedia(
    event,
    {
      ref: (segment) => {
        const id = mediaId(segment.rawUrl ?? segment.url)
        return id ? `wechat-oa:media:${id}` : undefined
      },
      source: async (segment) => {
        const id = mediaId(segment.rawUrl ?? segment.url)
        return id ? { url: await source(id) } : undefined
      },
      extractLabel: "wechat-oa-inbound",
    },
    {
      ...deps,
      readAttachment: async (adapterId, ref, cap) => {
        const bytes = await boundedRead(adapterId, ref, cap)
        return bytes && sniffImageMediaType(bytes) ? bytes : null
      },
    }
  )

  const fetchAttachment = deps.fetchAttachment ?? connectorsAttachmentFetch
  const http = deps.httpRequest ?? connectorsHttpRequest
  for (const segment of event.segments) {
    if (segment.type !== "voice" && segment.type !== "video") continue
    const id = mediaId(segment.rawUrl ?? segment.url)
    if (!id) continue
    const ref = `wechat-oa:media:${id}`
    try {
      const cap = deps.maxInlineBytes ?? 10 * 1024 * 1024
      let bytes = await boundedRead(event.adapterId, ref, cap)
      if (!bytes) {
        let url = await source(id)
        if (segment.type === "video") {
          const response = await http({ url, method: "GET", timeoutMs: 15_000 })
          const payload = JSON.parse(response.body) as { video_url?: string; errcode?: number }
          if (response.status >= 400 || payload.errcode || !payload.video_url) continue
          url = payload.video_url
        }
        // The token only goes to the configured API host. Video downloads
        // carry no credentials and must pass the shared public-URL guard.
        if (!isPublicHttpUrl(url)) continue
        const stored = await fetchAttachment(event.adapterId, ref, url)
        if (stored && stored.sizeBytes > cap) continue
        bytes = await boundedRead(event.adapterId, ref, cap)
      }
      if (!bytes) continue
      segment.rawUrl ??= segment.url
      segment.url = `data:${segment.mimeType ?? (segment.type === "video" ? "video/mp4" : "audio/amr")};base64,${bytes}`
    } catch {
      // An unavailable/expired media item must not discard the text/transcript.
    }
  }
}
