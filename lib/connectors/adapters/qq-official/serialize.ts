/**
 * OutboundRequest → QQ Official Bot REST call.
 *
 * QQ addresses each scene with a different endpoint:
 *   - group   → POST /v2/groups/{group_openid}/messages
 *   - c2c     → POST /v2/users/{user_openid}/messages
 *   - channel → POST /channels/{channel_id}/messages
 *   - direct  → POST /dms/{guild_id}/messages
 *
 * Passing `msg_id` makes the send a (free) passive reply inside the reply
 * window. We use the request's explicit `replyTo` when present, else the
 * inbound `msgId` captured on the conversationRef.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import type { QQScene } from "./parse"

export interface QQSendCall {
  path: string
  payload: Record<string, unknown>
}

/** Flatten segments into the plain text QQ `msg_type: 0` accepts. */
export function buildQQContent(segments: MessageSegment[]): string {
  const parts: string[] = []
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        parts.push(seg.text)
        break
      case "markdown":
        parts.push(seg.md)
        break
      case "code":
        parts.push(seg.code)
        break
      case "image":
      case "video":
      case "voice":
      case "file":
        parts.push(`[${seg.type}] ${seg.url}`)
        break
      case "a2ui":
        parts.push(seg.plainTextMirror || "[interactive message]")
        break
      case "emoji":
        parts.push(seg.code)
        break
      case "location":
        parts.push(`[location ${seg.lat},${seg.lon}]`)
        break
      default:
        break
    }
  }
  return parts.join("\n")
}

export function serializeOutbound(req: OutboundRequest): QQSendCall | null {
  const ref = req.conversationRef as {
    scene?: QQScene
    sceneId?: string
    msgId?: string
  }
  const scene = ref.scene
  const sceneId = ref.sceneId
  if (!scene || !sceneId) return null

  const content = buildQQContent(req.segments)
  const msgId = req.replyTo?.messageId ?? ref.msgId

  switch (scene) {
    case "group":
      return {
        path: `/v2/groups/${encodeURIComponent(sceneId)}/messages`,
        payload: { content, msg_type: 0, ...(msgId ? { msg_id: msgId } : {}) },
      }
    case "c2c":
      return {
        path: `/v2/users/${encodeURIComponent(sceneId)}/messages`,
        payload: { content, msg_type: 0, ...(msgId ? { msg_id: msgId } : {}) },
      }
    case "channel":
      return {
        path: `/channels/${encodeURIComponent(sceneId)}/messages`,
        payload: { content, ...(msgId ? { msg_id: msgId } : {}) },
      }
    case "direct":
      return {
        path: `/dms/${encodeURIComponent(sceneId)}/messages`,
        payload: { content, ...(msgId ? { msg_id: msgId } : {}) },
      }
  }
}
