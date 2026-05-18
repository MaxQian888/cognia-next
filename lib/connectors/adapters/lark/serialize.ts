/**
 * Lark outbound serialiser — Task 83.
 *
 * Wraps card.ts to produce SerializedLarkCall objects that map to
 * Lark im/v1 API calls (send, edit, delete, reactions).
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import { segmentsToLarkBody, segmentsToLarkBodyAsync } from "./card"

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

export interface SerializedLarkCall {
  method: "POST" | "PATCH" | "DELETE"
  url: string
  payload: Record<string, unknown>
}

/** Extract chat_id from the conversation reference. */
function chatIdFromRef(req: OutboundRequest): string {
  const ref = req.conversationRef as Record<string, unknown>
  return String(ref["channelId"] ?? "")
}

/** Extract optional thread_id from the conversation reference. */
function threadIdFromRef(req: OutboundRequest): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const ts = ref["threadTs"]
  return typeof ts === "string" ? ts : undefined
}

/**
 * Determine the receive_id_type and receive_id for an outbound send.
 *
 * Lark messages are sent to:
 *   - open_id: a specific user (for p2p / DMs)
 *   - chat_id: a group chat (for group messages)
 *
 * We use chat_id universally in Phase 1 since we always have the chat_id from
 * incoming events. Caller can pass a specific open_id via conversationRef if
 * needed (Phase 2).
 */
function buildReceiveIdParams(chatId: string): { receiveIdType: string; receiveId: string } {
  // If the id starts with oc_ it's a chat_id; ou_ would be an open_id.
  if (chatId.startsWith("ou_") || chatId.startsWith("on_")) {
    return { receiveIdType: "open_id", receiveId: chatId }
  }
  // Default: treat as chat_id
  return { receiveIdType: "chat_id", receiveId: chatId }
}

/**
 * Build a POST /im/v1/messages?receive_id_type=<type> call.
 */
export function serializeSend(req: OutboundRequest): SerializedLarkCall {
  const chatId = chatIdFromRef(req)
  const threadId = threadIdFromRef(req)
  const { receiveIdType, receiveId } = buildReceiveIdParams(chatId)

  const body = segmentsToLarkBody(req.segments)

  const payload: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: body.msg_type,
    content: body.content,
  }

  // Reply inside a thread: set reply_in_thread flag and parent_id
  if (threadId) {
    payload["reply_in_thread"] = true
    payload["parent_id"] = threadId
  }

  return {
    method: "POST",
    url: `${LARK_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    payload,
  }
}

/**
 * Build a PATCH /im/v1/messages/<message_id> call to edit a message.
 */
export function serializeEdit(messageId: string, req: OutboundRequest): SerializedLarkCall {
  const body = segmentsToLarkBody(req.segments)
  return {
    method: "PATCH",
    url: `${LARK_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`,
    payload: {
      msg_type: body.msg_type,
      content: body.content,
    },
  }
}

/**
 * Build a DELETE /im/v1/messages/<message_id> call.
 */
export function serializeDelete(messageId: string): SerializedLarkCall {
  return {
    method: "DELETE",
    url: `${LARK_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`,
    payload: {},
  }
}

/**
 * Build a POST /im/v1/messages/<message_id>/reactions call.
 *
 * Lark emoji type format: {"emoji_type": "THUMBSUP"} (internal key).
 */
export function serializeReaction(messageId: string, emojiType: string): SerializedLarkCall {
  return {
    method: "POST",
    url: `${LARK_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
    payload: {
      reaction_type: { emoji_type: emojiType },
    },
  }
}

/**
 * Project an OutboundRequest into a send SerializedLarkCall (primary entry point).
 */
export function serializeOutbound(req: OutboundRequest): SerializedLarkCall {
  return serializeSend(req)
}

/**
 * Async outbound serializer used by the production adapter `send()`.
 * Routes a2ui segments through `segmentsToLarkBodyAsync` so the body
 * becomes a single Lark Interactive Card with `connectorCallbackBindings`
 * persisted for every interactive element.
 */
export async function serializeOutboundAsync(
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedLarkCall> {
  const chatId = chatIdFromRef(req)
  const threadId = threadIdFromRef(req)
  const { receiveIdType, receiveId } = buildReceiveIdParams(chatId)

  const body = await segmentsToLarkBodyAsync(req.segments, {
    adapterId,
    conversationKey: buildConversationKeyFromRef(req, chatId, threadId),
  })

  const payload: Record<string, unknown> = {
    receive_id: receiveId,
    msg_type: body.msg_type,
    content: body.content,
  }
  if (threadId) {
    payload["reply_in_thread"] = true
    payload["parent_id"] = threadId
  }

  return {
    method: "POST",
    url: `${LARK_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
    payload,
  }
}

function buildConversationKeyFromRef(
  req: OutboundRequest,
  chatId: string,
  threadId: string | undefined
): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const adapterId = typeof ref["adapterId"] === "string" ? ref["adapterId"] : ""
  if (!adapterId || !chatId) return undefined
  return threadId ? `lark:${adapterId}:${chatId}:${threadId}` : `lark:${adapterId}:${chatId}`
}
