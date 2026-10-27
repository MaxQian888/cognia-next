/**
 * WeCom inbound → `NormalizedInboundEvent` projection.
 *
 * Pure functions: `index.ts` calls these inside the transport loop, then runs
 * the shared at-gate before `ctx.emit`. Media segments keep their encrypted
 * `{url, aeskey}` on `event.raw` (the original body) so the adapter's media
 * resolver can download + decrypt lazily without re-parsing.
 */

import type { NormalizedInboundEvent, ConversationReference } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import type { WeComInboundMsgBody, WeComChatType } from "./protocol"

/**
 * The opaque adapter-owned conversation handle for WeCom. Persisted on
 * `ChatSession.platformBinding.conversationRef` so proactive sends
 * (`aibot_send_msg`) can target the chat after the live `reqId` expires.
 */
export interface WeComConversationRef extends ConversationReference {
  platform: "wecom"
  adapterId: string
  /** Group `chatid`, or the user's `userid` for a single chat. */
  chatId: string
  chatType: WeComChatType
  /** Sender userid (used for single-chat proactive addressing). */
  userId?: string
  /** The triggering callback's `req_id` — present only on a fresh inbound ref. */
  reqId?: string
  /** The inbound `msgid` (dedup + correlation). */
  sourceMsgId?: string
}

export function buildWeComConversationRef(
  adapterId: string,
  body: WeComInboundMsgBody,
  reqId?: string
): WeComConversationRef {
  return {
    platform: "wecom",
    adapterId,
    chatId: body.chatid || (body.chattype === "single" ? (body.from?.userid ?? "") : ""),
    chatType: body.chattype,
    userId: body.from?.userid,
    reqId,
    sourceMsgId: body.msgid,
  }
}

function guessMimeFromExt(ext?: string): string {
  switch ((typeof ext === "string" ? ext : "").toLowerCase()) {
    case "pdf":
      return "application/pdf"
    case "doc":
    case "docx":
      return "application/msword"
    case "xls":
    case "xlsx":
      return "application/vnd.ms-excel"
    case "ppt":
    case "pptx":
      return "application/vnd.ms-powerpoint"
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "zip":
      return "application/zip"
    default:
      return "application/octet-stream"
  }
}

/** Project the inbound body's payload into cross-platform message segments. */
export function wecomBodyToSegments(
  body: Pick<
    WeComInboundMsgBody,
    "msgtype" | "text" | "markdown" | "image" | "voice" | "video" | "file" | "mixed"
  >
): MessageSegment[] {
  const segs: MessageSegment[] = []
  switch (body.msgtype) {
    case "text":
      if (typeof body.text?.content === "string" && body.text.content)
        segs.push({ type: "text", text: body.text.content })
      break
    case "markdown":
      if (typeof body.markdown?.content === "string" && body.markdown.content)
        segs.push({ type: "markdown", md: body.markdown.content })
      break
    case "image":
      if (typeof body.image?.url === "string" && body.image.url)
        segs.push({ type: "image", url: body.image.url })
      break
    case "voice":
      if (typeof body.voice?.url === "string" && body.voice.url)
        segs.push({
          type: "voice",
          url: body.voice.url,
          transcript:
            typeof body.voice.content === "string"
              ? body.voice.content
              : typeof body.voice.transcript === "string"
                ? body.voice.transcript
                : undefined,
        })
      else {
        const text =
          typeof body.voice?.content === "string"
            ? body.voice.content
            : typeof body.voice?.transcript === "string"
              ? body.voice.transcript
              : ""
        if (text) segs.push({ type: "text", text })
      }
      break
    case "video":
      if (typeof body.video?.url === "string" && body.video.url)
        segs.push({ type: "video", url: body.video.url })
      break
    case "file":
      if (typeof body.file?.url === "string" && body.file.url)
        segs.push({
          type: "file",
          url: body.file.url,
          name: typeof body.file.filename === "string" ? body.file.filename : "file",
          mimeType: guessMimeFromExt(body.file.fileext),
          sizeBytes: 0,
        })
      break
    case "mixed":
      for (const item of Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : []) {
        if (!item || typeof item !== "object") continue
        if (
          (!item.msgtype || item.msgtype === "text") &&
          typeof item.text?.content === "string" &&
          item.text.content
        )
          segs.push({ type: "text", text: item.text.content })
        else if (
          (!item.msgtype || item.msgtype === "image") &&
          typeof item.image?.url === "string" &&
          item.image.url
        )
          segs.push({ type: "image", url: item.image.url })
      }
      break
  }
  return segs
}

/**
 * Normalise an `aibot_msg_callback` body into a `NormalizedInboundEvent`.
 * Returns `null` when the body carries no renderable content.
 *
 * Group messages only reach the bot when it is @-mentioned (WeCom only pushes
 * group callbacks on mention), so `mentions.selfMentioned` is `true` for
 * group chats. Single chats are private DMs.
 */
export function parseWeComMessage(
  adapterId: string,
  selfId: string,
  body: WeComInboundMsgBody,
  reqId?: string,
  now: number = Date.now()
): NormalizedInboundEvent | null {
  const conversationRef = buildWeComConversationRef(adapterId, body, reqId)
  const chatId = conversationRef.chatId
  if (!chatId || !body.msgid) return null
  const quoted = body.quote
    ? wecomBodyToSegments(body.quote).map((segment): MessageSegment =>
        segment.type === "text"
          ? {
              type: "markdown",
              md: segment.text
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n"),
            }
          : segment
      )
    : []
  const segments = [...quoted, ...wecomBodyToSegments(body)]
  if (segments.length === 0) return null

  const isGroup = body.chattype === "group"
  const userId = body.from?.userid ?? "unknown"
  const conversationKey = buildConversationKey("wecom", adapterId, chatId)
  const plainText = segmentsToPlainText(segments).trim()

  return {
    platform: "wecom",
    adapterId,
    selfId,
    messageId: body.msgid,
    conversationRef,
    conversationKey,
    sender: {
      id: userId,
      platform: "wecom",
      adapterId,
      remoteUserId: userId,
      displayName: body.from?.name,
    },
    channel: {
      id: chatId,
      kind: isGroup ? "group" : "private",
      platformChannelId: chatId,
    },
    segments,
    plainText: plainText.length > 0 ? plainText : `[${body.msgtype}]`,
    mentions: { selfMentioned: isGroup, users: [] },
    timestamp: now,
    raw: body,
    kind: "create",
  }
}
