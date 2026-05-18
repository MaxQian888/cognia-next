/**
 * OneBot outbound serialiser.
 *
 * Projects OutboundRequest → array of OneBot RPC action calls.
 * Each call carries `action`, `params`, and a unique `echo` for round-trip
 * response matching.
 *
 * NOTE: OneBot v11/v12 do NOT support message editing natively.
 * Calls to serializeEdit* throw an UnsupportedError (callers should catch
 * and return an `unsupported_segment` OutboundError). Phase 1 is no-op for
 * typing since OneBot has no typing indicator API.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { toOneBotSegments } from "./segments"
import { buildOneBotA2UISegments } from "./a2ui-mapper"

export class OneBotUnsupportedError extends Error {
  constructor(action: string) {
    super(`OneBot does not support: ${action}`)
    this.name = "OneBotUnsupportedError"
  }
}

export interface SerializedOneBotCall {
  /** OneBot RPC action name */
  action: string
  /** Echo string for matching responses to requests */
  echo: string
  params: Record<string, unknown>
}

let echoCounter = 0
function nextEcho(): string {
  return `cognia_${Date.now()}_${++echoCounter}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatIdFromRef(req: OutboundRequest): {
  userId?: string | number
  groupId?: string | number
  messageType?: string
} {
  const ref = req.conversationRef as Record<string, unknown>
  const chatKey = (ref.chatKey as string | undefined) ?? ""

  if (chatKey.startsWith("p:")) {
    return { userId: chatKey.slice(2), messageType: "private" }
  }
  if (chatKey.startsWith("g:")) {
    return { groupId: chatKey.slice(2), messageType: "group" }
  }

  // Fallback: try direct userId / groupId fields
  if (ref.userId !== undefined) return { userId: ref.userId as string, messageType: "private" }
  if (ref.groupId !== undefined) return { groupId: ref.groupId as string, messageType: "group" }

  return {}
}

// ---------------------------------------------------------------------------
// v11 serialiser
// ---------------------------------------------------------------------------

/**
 * Serialise an outbound request to OneBot v11 RPC calls.
 *
 * Uses `send_private_msg` or `send_group_msg` depending on conversation type.
 */
export function serializeOutboundV11(
  req: OutboundRequest,
  _selfId: string
): SerializedOneBotCall[] {
  const { userId, groupId, messageType } = chatIdFromRef(req)

  const segments = expandA2UISegments(req.segments)
  // Prepend reply segment if replyTo is set
  const allSegments =
    req.replyTo !== undefined
      ? [{ type: "reply" as const, messageId: req.replyTo.messageId, snippet: "" }, ...segments]
      : segments

  const obSegments = toOneBotSegments(allSegments, "v11")
  if (obSegments.length === 0) return []

  if (messageType === "private" || userId !== undefined) {
    return [
      {
        action: "send_private_msg",
        echo: nextEcho(),
        params: { user_id: userId, message: obSegments },
      },
    ]
  }

  return [
    {
      action: "send_group_msg",
      echo: nextEcho(),
      params: { group_id: groupId, message: obSegments },
    },
  ]
}

// ---------------------------------------------------------------------------
// v12 serialiser
// ---------------------------------------------------------------------------

/**
 * Serialise an outbound request to OneBot v12 RPC calls.
 *
 * Uses the unified `send_message` action with `detail_type` discriminator.
 */
export function serializeOutboundV12(
  req: OutboundRequest,
  _selfId: string
): SerializedOneBotCall[] {
  const { userId, groupId, messageType } = chatIdFromRef(req)

  const segments = expandA2UISegments(req.segments)
  const allSegments =
    req.replyTo !== undefined
      ? [{ type: "reply" as const, messageId: req.replyTo.messageId, snippet: "" }, ...segments]
      : segments

  const obSegments = toOneBotSegments(allSegments, "v12")
  if (obSegments.length === 0) return []

  const detailType = messageType === "private" ? "private" : "group"
  const params: Record<string, unknown> = {
    detail_type: detailType,
    message: obSegments,
  }
  if (detailType === "private") {
    params.user_id = userId
  } else {
    params.group_id = groupId
  }

  return [{ action: "send_message", echo: nextEcho(), params }]
}

// ---------------------------------------------------------------------------
// delete (v11 + v12 share the same action name)
// ---------------------------------------------------------------------------

/**
 * Serialise a delete-message request.
 * Works for both v11 and v12 (both use `delete_msg` / `delete_message`).
 */
export function serializeDeleteV11(messageId: string, _selfId: string): SerializedOneBotCall {
  return {
    action: "delete_msg",
    echo: nextEcho(),
    params: { message_id: Number(messageId) },
  }
}

export function serializeDeleteV12(messageId: string, _selfId: string): SerializedOneBotCall {
  return {
    action: "delete_message",
    echo: nextEcho(),
    params: { message_id: messageId },
  }
}

// ---------------------------------------------------------------------------
// history fetch (v11 NapCat / go-cqhttp extension)
// ---------------------------------------------------------------------------

/**
 * Serialise a `get_group_msg_history` call.
 *
 * Per NapCat / go-cqhttp: omitting `message_seq` fetches the most recent page;
 * passing a seq returns up to `count` messages *before* that seq (older
 * messages). The response carries `messages` ordered oldest-first within the
 * page.
 */
export function serializeGetGroupMsgHistoryV11(
  groupId: string | number,
  messageSeq?: number,
  count = 20
): SerializedOneBotCall {
  const params: Record<string, unknown> = {
    group_id: typeof groupId === "string" ? Number(groupId) : groupId,
    count,
  }
  if (messageSeq !== undefined) params.message_seq = messageSeq
  return { action: "get_group_msg_history", echo: nextEcho(), params }
}

/**
 * Serialise a `get_friend_msg_history` call. Same cursor semantics as the
 * group variant.
 */
export function serializeGetFriendMsgHistoryV11(
  userId: string | number,
  messageSeq?: number,
  count = 20
): SerializedOneBotCall {
  const params: Record<string, unknown> = {
    user_id: typeof userId === "string" ? Number(userId) : userId,
    count,
  }
  if (messageSeq !== undefined) params.message_seq = messageSeq
  return { action: "get_friend_msg_history", echo: nextEcho(), params }
}

// ---------------------------------------------------------------------------
// edit — NOT SUPPORTED
// ---------------------------------------------------------------------------

/**
 * OneBot v11/v12 does not support message editing.
 * Throws OneBotUnsupportedError; callers should map this to an OutboundError.
 */
export function serializeEditV11(_messageId: string, _req: OutboundRequest): never {
  throw new OneBotUnsupportedError("edit_msg (v11)")
}

export function serializeEditV12(_messageId: string, _req: OutboundRequest): never {
  throw new OneBotUnsupportedError("edit_message (v12)")
}

// ---------------------------------------------------------------------------
// typing — NOT SUPPORTED (no-op)
// ---------------------------------------------------------------------------

/**
 * OneBot v11/v12 has no native typing indicator.
 * Returns an empty array (no-op); callers can ignore the result.
 */
export function serializeTypingV11(_conversationKey: string, _on: boolean): SerializedOneBotCall[] {
  return []
}

export function serializeTypingV12(_conversationKey: string, _on: boolean): SerializedOneBotCall[] {
  return []
}

/**
 * Walk a segment list and expand each `a2ui` segment into the OneBot
 * native projection (text + image + plainTextMirror tail for any
 * interactive components). Non-a2ui segments pass through unchanged.
 *
 * Synchronous because OneBot has no native interactive elements that
 * need callback bindings — buttons / forms always fall back to text.
 */
function expandA2UISegments(segments: MessageSegment[]): MessageSegment[] {
  const out: MessageSegment[] = []
  for (const seg of segments) {
    if (seg.type === "a2ui") {
      out.push(...buildOneBotA2UISegments(seg.content, seg.plainTextMirror))
    } else {
      out.push(seg)
    }
  }
  return out
}
