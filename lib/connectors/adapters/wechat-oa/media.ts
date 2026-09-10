import { connectorsMediaUpload } from "@/lib/connectors/tauri/commands"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { clearWechatOaTokenCache } from "./auth"
import { serializeOutbound, type WechatCustomMessage } from "./serialize"

export class WechatMediaError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly code: "validation" | "auth_failed" | "platform_4xx" | "platform_5xx" = "validation"
  ) {
    super(message)
    this.name = "WechatMediaError"
  }
}

/** Upload references separately from message sends so upload failures send no partial reply. */
export async function prepareWechatMessages(
  req: OutboundRequest,
  accessToken: () => Promise<string>,
  apiBase: string
): Promise<WechatCustomMessage[]> {
  const base = serializeOutbound({ ...req, segments: [] })
  if (!base) throw new WechatMediaError("WeChat OA send: missing openId")
  for (const segment of req.segments) {
    if (segment.type === "card")
      throw new WechatMediaError("WeChat OA does not support opaque native cards")
    if (segment.type === "video" && !segment.thumbnailUrl) {
      throw new WechatMediaError("WeChat OA video requires thumbnailUrl")
    }
  }

  async function upload(source: string, kind: string, mimeType?: string): Promise<string> {
    if (source.startsWith("wxmedia://")) {
      const id = source.slice("wxmedia://".length)
      if (!id) throw new WechatMediaError("WeChat OA media ID is empty")
      return id
    }
    let url: URL
    try {
      url = new URL(source)
    } catch {
      throw new WechatMediaError("WeChat OA media requires an HTTP or file URL")
    }
    if (!["http:", "https:", "file:"].includes(url.protocol))
      throw new WechatMediaError("Unsupported WeChat OA media source")
    if (url.protocol === "file:" && url.hostname && url.hostname !== "localhost")
      throw new WechatMediaError("Remote file hosts are not supported")
    const filename = decodeURIComponent(
      url.pathname.split("/").pop() ||
        `media.${kind === "voice" ? "mp3" : kind === "video" ? "mp4" : "jpg"}`
    )
    let localPath = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:\//.test(localPath)) localPath = localPath.slice(1)
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken()
      const response = JSON.parse(
        await connectorsMediaUpload({
          uploadUrl: `${apiBase}/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${kind}`,
          ...(url.protocol === "file:" ? { localPath } : { sourceUrl: source }),
          contentType: mimeType,
          multipart: { fieldName: "media", filename, fields: {} },
          responseMode: "http",
        })
      ) as { status: number; body: string }
      let body: { media_id?: string; errcode?: number; errmsg?: string }
      try {
        body = JSON.parse(response.body)
      } catch {
        throw new WechatMediaError(
          `WeChat OA upload returned non-JSON HTTP ${response.status}`,
          true
        )
      }
      if ([40001, 40014, 42001].includes(body.errcode ?? 0) && attempt === 0) {
        clearWechatOaTokenCache()
        continue
      }
      if (
        response.status >= 400 ||
        body.errcode ||
        typeof body.media_id !== "string" ||
        !body.media_id
      ) {
        throw new WechatMediaError(
          `WeChat OA upload failed: ${body.errmsg ?? body.errcode ?? response.status}`,
          response.status === 429 ||
            response.status >= 500 ||
            body.errcode === -1 ||
            body.errcode === 45009,
          [40001, 40014, 42001].includes(body.errcode ?? 0)
            ? "auth_failed"
            : response.status >= 500
              ? "platform_5xx"
              : "platform_4xx"
        )
      }
      return body.media_id
    }
    throw new WechatMediaError("WeChat OA upload authentication failed")
  }

  const messages: WechatCustomMessage[] = []
  let text: MessageSegment[] = []
  const flush = () => {
    if (!text.length) return
    const message = serializeOutbound({ ...req, segments: text })
    if (message) messages.push(message)
    text = []
  }
  for (const segment of req.segments) {
    if (segment.type !== "image" && segment.type !== "voice" && segment.type !== "video") {
      text.push(segment)
      continue
    }
    flush()
    const media_id = await upload(segment.url, segment.type, segment.mimeType)
    if (segment.type === "video") {
      const thumb_media_id = await upload(segment.thumbnailUrl!, "thumb", "image/jpeg")
      messages.push({ touser: base.touser, msgtype: "video", video: { media_id, thumb_media_id } })
    } else if (segment.type === "voice") {
      messages.push({ touser: base.touser, msgtype: "voice", voice: { media_id } })
    } else {
      messages.push({ touser: base.touser, msgtype: "image", image: { media_id } })
    }
  }
  flush()
  if (!messages.length) throw new WechatMediaError("WeChat OA message is empty")
  return messages
}
