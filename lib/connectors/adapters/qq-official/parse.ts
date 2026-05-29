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
  member_openid?: string
  user_openid?: string
}

export interface QQMessageData {
  id?: string
  content?: string
  timestamp?: string
  author?: QQAuthor
  group_openid?: string
  channel_id?: string
  guild_id?: string
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

export const QQ_MESSAGE_EVENTS = Object.keys(SCENE_BY_EVENT)

/** Strip a leading `<@!12345>` channel mention QQ prefixes to AT messages. */
export function stripChannelMention(content: string): string {
  return content.replace(/^\s*<@!?\d+>\s*/, "").trim()
}

function tsToMillis(ts: string | undefined): number {
  if (!ts) return Date.now()
  const parsed = Date.parse(ts)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export function parseQQDispatch(
  adapterId: string,
  selfId: string,
  dispatch: QQDispatch
): NormalizedInboundEvent | null {
  const scene = SCENE_BY_EVENT[dispatch.t]
  const d = dispatch.d
  if (!scene || !d || !d.id) return null

  // Resolve the scene-specific addressing id + remote user id.
  let sceneId: string
  let remoteUserId: string
  let channelKind: "private" | "group"
  switch (scene) {
    case "group":
      if (!d.group_openid) return null
      sceneId = d.group_openid
      remoteUserId = d.author?.member_openid ?? d.group_openid
      channelKind = "group"
      break
    case "c2c":
      remoteUserId = d.author?.user_openid ?? ""
      if (!remoteUserId) return null
      sceneId = remoteUserId
      channelKind = "private"
      break
    case "channel":
      if (!d.channel_id) return null
      sceneId = d.channel_id
      remoteUserId = d.author?.id ?? d.channel_id
      channelKind = "group"
      break
    case "direct":
      if (!d.guild_id) return null
      sceneId = d.guild_id
      remoteUserId = d.author?.id ?? d.guild_id
      channelKind = "private"
      break
  }

  const conversationKey = buildConversationKey("qq-official", adapterId, sceneId)
  const sender: PlatformIdentity = {
    id: `qq:${sceneId}:${remoteUserId}`,
    platform: "qq-official",
    adapterId,
    remoteUserId,
    displayName: d.author?.username,
  }

  const text = scene === "channel" ? stripChannelMention(d.content ?? "") : (d.content ?? "").trim()
  const segments: MessageSegment[] = text ? [{ type: "text", text }] : []

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
    },
    conversationKey,
    sender,
    channel: { id: conversationKey, kind: channelKind, platformChannelId: sceneId },
    segments,
    plainText: segmentsToPlainText(segments),
    // QQ only pushes these events when the bot is addressed (group/channel @)
    // or in a private scene, so every inbound message targets the bot.
    mentions: { selfMentioned: true, users: [] },
    timestamp: tsToMillis(d.timestamp),
    raw: dispatch,
    kind: "create",
  }
}
