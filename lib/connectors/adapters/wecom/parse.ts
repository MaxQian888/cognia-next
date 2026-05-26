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
    chatId: body.chatid,
    chatType: body.chattype,
    userId: body.from?.userid,
    reqId,
    sourceMsgId: body.msgid,
  }
}

function guessMimeFromExt(ext?: string): string {
  switch ((ext ?? "").toLowerCase()) {
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
function bodyToSegments(body: WeComInboundMsgBody): MessageSegment[] {
  const segs: MessageSegment[] = []
  switch (body.msgtype) {
    case "text":
      if (body.text?.content) segs.push({ type: "text", text: body.text.content })
      break
    case "markdown":
      if (body.markdown?.content) segs.push({ type: "markdown", md: body.markdown.content })
      break
    case "image":
      if (body.image?.url) segs.push({ type: "image", url: body.image.url })
      break
    case "voice":
      if (body.voice?.url)
        segs.push({ type: "voice", url: body.voice.url, transcript: body.voice.transcript })
      break
    case "video":
      if (body.video?.url) segs.push({ type: "video", url: body.video.url })
      break
    case "file":
      if (body.file?.url)
        segs.push({
          type: "file",
          url: body.file.url,
          name: body.file.filename ?? "file",
          mimeType: guessMimeFromExt(body.file.fileext),
          sizeBytes: 0,
        })
      break
    case "mixed":
      for (const item of body.mixed?.msg_item ?? []) {
        if (item.text?.content) segs.push({ type: "text", text: item.text.content })
        else if (item.image?.url) segs.push({ type: "image", url: item.image.url })
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
  if (!body.chatid || !body.msgid) return null
  const segments = bodyToSegments(body)
  if (segments.length === 0) return null

  const isGroup = body.chattype === "group"
  const userId = body.from?.userid ?? "unknown"
  const conversationRef = buildWeComConversationRef(adapterId, body, reqId)
  const conversationKey = buildConversationKey("wecom", adapterId, body.chatid)
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
      id: body.chatid,
      kind: isGroup ? "group" : "private",
      platformChannelId: body.chatid,
    },
    segments,
    plainText: plainText.length > 0 ? plainText : `[${body.msgtype}]`,
    mentions: { selfMentioned: isGroup, users: [] },
    timestamp: now,
    raw: body,
    kind: "create",
  }
}
