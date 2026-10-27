/**
 * QQ Official Bot gateway dispatch → NormalizedInboundEvent.
 *
 * Four message scenes are surfaced:
 *   - GROUP_AT_MESSAGE_CREATE  → group chat, bot @-mentioned (group_openid).
 *   - C2C_MESSAGE_CREATE       → 1:1 private chat (user_openid).
 *   - AT_MESSAGE_CREATE        → guild channel, bot @-mentioned (channel_id).
 *   - DIRECT_MESSAGE_CREATE    → guild direct message (dms guild_id).
 *
 * QQ only delivers group/channel events when the bot is @-mentioned, and C2C /
 * direct are inherently private, so `selfMentioned` is always true — the
 * at-gate's mention strategy passes for every inbound message.
 *
 * The `conversationRef` carries a `scene` discriminator plus the id the
 * serializer needs to address the reply, and the inbound `msgId` so the reply
 * lands in the (free) passive-reply window.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

export type QQScene = "group" | "c2c" | "channel" | "direct"

export interface QQAuthor {
  id?: string
  username?: string
  avatar?: string
  member_openid?: string
  user_openid?: string
}

export interface QQAttachmentData {
  url?: string
  content_type?: string
  filename?: string
  size?: number
  width?: number
  height?: number
}

export interface QQMessageData {
  /** Recall notifications wrap the original message and acting user. */
  message?: QQMessageData
  op_user?: QQAuthor
  id?: string
  content?: string
  timestamp?: string
  author?: QQAuthor
  group_openid?: string
  channel_id?: string
  guild_id?: string
  attachments?: QQAttachmentData[]
  message_reference?: { message_id?: string }
}

export interface QQDispatch {
  t: string
  s?: number
  op: number
  d?: QQMessageData
}

const SCENE_BY_EVENT: Record<string, QQScene> = {
  GROUP_AT_MESSAGE_CREATE: "group",
  C2C_MESSAGE_CREATE: "c2c",
  AT_MESSAGE_CREATE: "channel",
  DIRECT_MESSAGE_CREATE: "direct",
}

const DELETE_SCENE_BY_EVENT: Record<string, QQScene> = {
  PUBLIC_MESSAGE_DELETE: "channel",
  MESSAGE_DELETE: "channel",
  DIRECT_MESSAGE_DELETE: "direct",
}
export const QQ_MESSAGE_EVENTS = [
  ...Object.keys(SCENE_BY_EVENT),
  ...Object.keys(DELETE_SCENE_BY_EVENT),
]

/** Strip a leading `<@!12345>` channel mention QQ prefixes to AT messages. */
export function stripChannelMention(content: string): string {
  return content.replace(/^\s*<@!?\d+>\s*/, "").trim()
}

function tsToMillis(ts: string | undefined): number {
  if (typeof ts !== "string" || !ts) return Date.now()
  const parsed = Date.parse(ts)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** Normalize legacy bare hosts and protocol-relative attachment URLs once. */
export function qqAttachmentSegments(attachments: unknown): MessageSegment[] {
  if (!Array.isArray(attachments)) return []
  const segments: MessageSegment[] = []
  for (const att of attachments) {
    if (!att || typeof att.url !== "string" || !att.url.trim()) continue
    const raw = att.url.trim()
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) continue
    let url: string
    try {
      const parsed = new URL(
        raw.startsWith("//") ? `https:${raw}` : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      )
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) continue
      url = parsed.href
    } catch {
      continue
    }
    const contentType = typeof att.content_type === "string" ? att.content_type.toLowerCase() : ""
    const name = typeof att.filename === "string" ? att.filename : undefined
    if (contentType.startsWith("image/")) {
      segments.push({
        type: "image",
        url,
        alt: name,
        mimeType: contentType,
        width: typeof att.width === "number" ? att.width : undefined,
        height: typeof att.height === "number" ? att.height : undefined,
      })
    } else if (contentType === "voice" || contentType.startsWith("audio/")) {
      segments.push({
        type: "voice",
        url,
        mimeType: contentType === "voice" ? undefined : contentType,
      })
    } else if (contentType.startsWith("video/")) {
      segments.push({ type: "video", url, mimeType: contentType })
    } else {
      segments.push({
        type: "file",
        url,
        name: name || "attachment",
        mimeType: contentType || "application/octet-stream",
        sizeBytes: typeof att.size === "number" ? att.size : 0,
      })
    }
  }
  return segments
}

export function parseQQDispatch(
  adapterId: string,
  selfId: string,
  dispatch: QQDispatch
): NormalizedInboundEvent | null {
  if (!dispatch || typeof dispatch !== "object") return null
  const deletion = DELETE_SCENE_BY_EVENT[dispatch.t]
  const scene = SCENE_BY_EVENT[dispatch.t] ?? deletion
  const d = deletion ? dispatch.d?.message : dispatch.d
  if (!scene || !d || typeof d.id !== "string" || !d.id) return null

  // Resolve the scene-specific addressing id + remote user id.
  let sceneId: string
  let remoteUserId: string
  let channelKind: "private" | "group"
  switch (scene) {
    case "group":
      if (typeof d.group_openid !== "string" || !d.group_openid) return null
      sceneId = d.group_openid
      remoteUserId = d.author?.member_openid ?? d.group_openid
      channelKind = "group"
      break
    case "c2c":
      remoteUserId = typeof d.author?.user_openid === "string" ? d.author.user_openid : ""
      if (!remoteUserId) return null
      sceneId = remoteUserId
      channelKind = "private"
      break
    case "channel":
      if (typeof d.channel_id !== "string" || !d.channel_id) return null
      sceneId = d.channel_id
      remoteUserId = d.author?.id ?? d.channel_id
      channelKind = "group"
      break
    case "direct":
      if (typeof d.guild_id !== "string" || !d.guild_id) return null
      sceneId = d.guild_id
      remoteUserId = d.author?.id ?? d.guild_id
      channelKind = "private"
      break
  }

  // Recall notifications distinguish the operator from the message author.
  const actor = deletion ? dispatch.d?.op_user : d.author
  if (deletion && typeof actor?.id === "string" && actor.id) remoteUserId = actor.id
  const conversationKey = buildConversationKey("qq-official", adapterId, sceneId)
  const sender: PlatformIdentity = {
    id: `qq:${sceneId}:${remoteUserId}`,
    platform: "qq-official",
    adapterId,
    remoteUserId,
    remoteIdType: scene === "channel" || scene === "direct" ? "channel_user" : `${scene}_openid`,
    displayName: typeof actor?.username === "string" ? actor.username : undefined,
    avatarUrl:
      (scene === "channel" || scene === "direct") && typeof actor?.avatar === "string"
        ? actor.avatar
        : undefined,
  }

  const rawText = typeof d.content === "string" ? d.content : ""
  const text = scene === "channel" ? stripChannelMention(rawText) : rawText.trim()
  const segments: MessageSegment[] = []
  if (typeof d.message_reference?.message_id === "string" && d.message_reference.message_id)
    segments.push({ type: "reply", messageId: d.message_reference.message_id, snippet: "" })
  if (text) segments.push({ type: "text", text })

  // User-sent attachments (images / files). Without this an image-only
  // message reaches the AI loop as empty text. Group/C2C attachment URLs
  // arrive scheme-less (`gchat.qpic.cn/...`) — normalise to https.
  segments.push(...qqAttachmentSegments(d.attachments))

  return {
    platform: "qq-official",
    adapterId,
    selfId,
    messageId: d.id,
    conversationRef: {
      platform: "qq-official",
      adapterId,
      scene,
      sceneId,
      msgId: d.id,
      // Local receipt time — the serializer compares this against the
      // scene's passive-reply window to decide whether msg_id is still
      // usable (see QQ_PASSIVE_WINDOW_MS in serialize.ts).
      receivedAt: Date.now(),
    },
    conversationKey,
    sender,
    channel: { id: conversationKey, kind: channelKind, platformChannelId: sceneId },
    segments: deletion ? [] : segments,
    replyTo:
      typeof d.message_reference?.message_id === "string" && d.message_reference.message_id
        ? { messageId: d.message_reference.message_id, snippet: "" }
        : undefined,
    plainText: deletion ? "" : segmentsToPlainText(segments),
    // QQ only pushes these events when the bot is addressed (group/channel @)
    // or in a private scene, so every inbound message targets the bot.
    mentions: { selfMentioned: true, users: [] },
    timestamp: tsToMillis(d.timestamp),
    raw: dispatch,
    kind: deletion ? "delete" : "create",
    ...(deletion ? { replacesMessageId: d.id } : {}),
  }
}
