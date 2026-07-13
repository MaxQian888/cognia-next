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
 *
 * Passive-reply constraints enforced here (per the v2 send docs):
 *   - `msg_seq` pairs with `msg_id` on group/C2C sends; it defaults to 1 when
 *     omitted and the same msg_id+msg_seq combo is rejected as a duplicate,
 *     so any second reply to the same inbound message needs a monotonic seq.
 *   - Each msg_id accepts at most 5 passive replies.
 *   - msg_id expires: group / channel / direct after 5 minutes, C2C after
 *     60 minutes. An expired msg_id fails the whole send.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import type { QQScene } from "./parse"

export interface QQSendCall {
  path: string
  payload: Record<string, unknown>
}

/**
 * Passive-reply validity window per scene (docs: 群聊/文字子频道/频道私信
 * 5 分钟, 单聊 60 分钟).
 */
export const QQ_PASSIVE_WINDOW_MS: Record<QQScene, number> = {
  group: 5 * 60_000,
  c2c: 60 * 60_000,
  channel: 5 * 60_000,
  direct: 5 * 60_000,
}

/** QQ accepts at most 5 passive replies per inbound msg_id. */
const MAX_PASSIVE_REPLIES = 5

/** Bound on the per-msg_id seq map — old inbound msg_ids age out anyway. */
const MSG_SEQ_MAP_CAP = 300

/**
 * Per-msg_id monotonic `msg_seq` counter. Module-level so consecutive
 * `send()` calls correlated to the same inbound message get 1, 2, 3, … —
 * without it every reply defaults to seq 1 and the platform rejects the
 * second one as a duplicate. Bounded: entries are kept in insertion order
 * and the oldest is evicted past `MSG_SEQ_MAP_CAP` (an evicted msg_id is by
 * then far outside its passive window, so a reset counter is harmless).
 */
const msgSeqByMsgId = new Map<string, number>()

function nextMsgSeq(msgId: string): number {
  const next = (msgSeqByMsgId.get(msgId) ?? 0) + 1
  // Re-insert to refresh recency in the insertion-ordered eviction queue.
  msgSeqByMsgId.delete(msgId)
  msgSeqByMsgId.set(msgId, next)
  while (msgSeqByMsgId.size > MSG_SEQ_MAP_CAP) {
    const oldest = msgSeqByMsgId.keys().next().value
    if (oldest === undefined) break
    msgSeqByMsgId.delete(oldest)
  }
  return next
}

/** Test-only: reset the module-level msg_seq state. */
export function __resetQQMsgSeqForTesting(): void {
  msgSeqByMsgId.clear()
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

/**
 * Passive `msg_id` + `msg_seq` fields for group/C2C payloads.
 *
 * Past the 5-reply limit the msg_id is dropped so the message goes out as a
 * proactive send instead of a guaranteed duplicate/limit rejection — this
 * keeps the reply deliverable, at the cost of the (strict, ~4/month)
 * proactive quota. `send()` in index.ts cannot retry a 5-reply rejection any
 * better, so degrading here is the design that still delivers.
 */
function passiveReplyFields(msgId: string | undefined): Record<string, unknown> {
  if (!msgId) return {}
  const seq = nextMsgSeq(msgId)
  if (seq > MAX_PASSIVE_REPLIES) return {}
  return { msg_id: msgId, msg_seq: seq }
}

export function serializeOutbound(req: OutboundRequest): QQSendCall | null {
  const ref = req.conversationRef as {
    scene?: QQScene
    sceneId?: string
    msgId?: string
    receivedAt?: number
  }
  const scene = ref.scene
  const sceneId = ref.sceneId
  if (!scene || !sceneId) return null

  const content = buildQQContent(req.segments)
  let msgId = req.replyTo?.messageId ?? ref.msgId

  // Drop an expired msg_id so the send degrades to proactive instead of
  // failing with the platform's msg-limit error. Only drop when the window
  // has actually elapsed — a proactive send burns the ~4/month quota, so we
  // never drop preemptively. Refs without `receivedAt` (pre-existing rows)
  // are treated as fresh and left for the platform to arbitrate.
  if (
    msgId &&
    typeof ref.receivedAt === "number" &&
    Date.now() - ref.receivedAt > QQ_PASSIVE_WINDOW_MS[scene]
  ) {
    msgId = undefined
  }

  switch (scene) {
    case "group":
      return {
        path: `/v2/groups/${encodeURIComponent(sceneId)}/messages`,
        payload: { content, msg_type: 0, ...passiveReplyFields(msgId) },
      }
    case "c2c":
      return {
        path: `/v2/users/${encodeURIComponent(sceneId)}/messages`,
        payload: { content, msg_type: 0, ...passiveReplyFields(msgId) },
      }
    // The guild (channel/direct) v1 endpoints take msg_id only — no msg_seq.
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
