/**
 * Lark outbound serialiser — Task 83.
 *
 * Wraps card.ts to produce SerializedLarkCall objects that map to
 * Lark im/v1 API calls (send, edit, delete, reactions).
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import { segmentsToPlainText } from "@/types/connectors/segment"
import { segmentsToLarkBody, segmentsToLarkBodyAsync, type LarkMessageBody } from "./card"

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

export interface SerializedLarkCall {
  method: "POST" | "PUT" | "PATCH" | "DELETE"
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
 *   - open_id: a specific user (for p2p / DMs), prefix `ou_` / `on_`
 *   - chat_id: a group chat (for group messages), prefix `oc_`
 *   - user_id: enterprise-specific user id (no prefix; numeric or
 *     custom). Carried verbatim on `conversationRef.userId` so the caller
 *     can target a Feishu user without an open_id.
 *   - email: enterprise account email — useful when the assistant
 *     wants to ping a colleague by mail address without having resolved
 *     them to an open_id first.
 *
 * Closes the v18 Phase 2 marker (ADR-0009 v41 / A4) by honouring an
 * explicit `receiveIdType` on the conversation ref when present, falling
 * back to the prefix-sniff for legacy bindings that only carry the chat
 * id.
 */
function buildReceiveIdParams(
  chatId: string,
  explicitType?: string,
  explicitReceiveId?: string
): { receiveIdType: string; receiveId: string } {
  if (explicitType && explicitReceiveId) {
    // Trust the caller — adapter-registry / inbound parsers know best.
    return { receiveIdType: explicitType, receiveId: explicitReceiveId }
  }
  // If the id starts with oc_ it's a chat_id; ou_/on_ would be an open_id.
  if (chatId.startsWith("ou_") || chatId.startsWith("on_")) {
    return { receiveIdType: "open_id", receiveId: chatId }
  }
  // Default: treat as chat_id
  return { receiveIdType: "chat_id", receiveId: chatId }
}

/**
 * Resolve the Lark `receive_id_type` + `receive_id` for an outbound request.
 *
 * A4 — honours an explicit `receiveIdType` + `receiveId` (or the convenience
 * `openId` / `userId` / `email`) carried on the conversation ref, falling back
 * to the prefix-sniff on the chat id for legacy bindings. Shared by BOTH the
 * sync `serializeSend` and the async `serializeOutboundAsync` (the one the
 * production `send()` actually calls) so the async path no longer silently
 * collapses user_id / email targets down to chat_id.
 */
function resolveReceiveId(
  req: OutboundRequest,
  chatId: string
): { receiveIdType: string; receiveId: string } {
  const ref = req.conversationRef as Record<string, unknown>
  const explicitType =
    typeof ref["receiveIdType"] === "string" ? (ref["receiveIdType"] as string) : undefined
  const explicitReceiveId =
    typeof ref["receiveId"] === "string"
      ? (ref["receiveId"] as string)
      : typeof ref["openId"] === "string"
        ? (ref["openId"] as string)
        : typeof ref["userId"] === "string"
          ? (ref["userId"] as string)
          : typeof ref["email"] === "string"
            ? (ref["email"] as string)
            : undefined
  const inferredType =
    explicitType ??
    (typeof ref["openId"] === "string"
      ? "open_id"
      : typeof ref["userId"] === "string"
        ? "user_id"
        : typeof ref["email"] === "string"
          ? "email"
          : undefined)
  return buildReceiveIdParams(chatId, inferredType, explicitReceiveId)
}

/**
 * Build a POST /im/v1/messages?receive_id_type=<type> call.
 */
export function serializeSend(req: OutboundRequest): SerializedLarkCall {
  const chatId = chatIdFromRef(req)
  const threadId = threadIdFromRef(req)
  const { receiveIdType, receiveId } = resolveReceiveId(req, chatId)

  const body = segmentsToLarkBody(req.segments)

  // Reply anchor: Lark replies go through a dedicated endpoint keyed by the
  // quoted message id (no receive_id). Every other adapter already honours
  // `req.replyTo`; without this branch the workflow send node's
  // `replyToMessageId` silently degraded to a plain send on Lark.
  const replyTargetId = req.replyTo?.messageId
  if (replyTargetId) {
    const payload: Record<string, unknown> = {
      msg_type: body.msg_type,
      content: body.content,
    }
    if (threadId) payload["reply_in_thread"] = true
    return {
      method: "POST",
      url: `${LARK_API_BASE}/im/v1/messages/${replyTargetId}/reply`,
      payload,
    }
  }

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
 * Route an edit to the correct Lark endpoint by rendered body type.
 *
 * Lark splits message editing across two APIs:
 *   - PUT   /im/v1/messages/:id — edits text / post messages only
 *     (payload `{msg_type, content}`).
 *   - PATCH /im/v1/messages/:id — updates an interactive card sent by
 *     the app (payload `{content}` — the new card JSON, no msg_type).
 *
 * Media bodies (image / file / audio / media) cannot be edited in place;
 * they degrade to a PUT text edit carrying the plain-text projection so
 * the edit is visible rather than a guaranteed 400.
 */
function buildEditCall(
  messageId: string,
  req: OutboundRequest,
  body: LarkMessageBody
): SerializedLarkCall {
  const url = `${LARK_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`
  if (body.msg_type === "interactive") {
    return { method: "PATCH", url, payload: { content: body.content } }
  }
  if (body.msg_type === "text" || body.msg_type === "post") {
    return { method: "PUT", url, payload: { msg_type: body.msg_type, content: body.content } }
  }
  const text = segmentsToPlainText(req.segments)
  return {
    method: "PUT",
    url,
    payload: { msg_type: "text", content: JSON.stringify({ text: text || "[updated]" }) },
  }
}

/**
 * Build the edit call for a message (sync path — a2ui segments collapse
 * to their plain-text mirror; the production adapter uses
 * `serializeEditAsync` instead so edited cards keep their interactivity).
 */
export function serializeEdit(messageId: string, req: OutboundRequest): SerializedLarkCall {
  const body = segmentsToLarkBody(req.segments)
  return buildEditCall(messageId, req, body)
}

/**
 * Async edit serializer used by the production adapter `edit()`.
 *
 * Routes a2ui segments through `segmentsToLarkBodyAsync` so an edited
 * card is re-projected as a full Lark Interactive Card (with fresh
 * `connectorCallbackBindings` for every interactive element) and shipped
 * via the card-update PATCH endpoint instead of collapsing to its
 * plain-text mirror on the text-edit PUT endpoint.
 */
export async function serializeEditAsync(
  messageId: string,
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedLarkCall> {
  const chatId = chatIdFromRef(req)
  const threadId = threadIdFromRef(req)
  const body = await segmentsToLarkBodyAsync(req.segments, {
    adapterId,
    conversationKey: buildConversationKeyFromRef(req, chatId, threadId),
  })
  return buildEditCall(messageId, req, body)
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
  // A4 — honour explicit open_id / user_id / email routing on the async path
  // too (the production `send()` uses this serialiser). Previously this passed
  // only the chat id, so a reply targeted at a user by user_id / email was
  // silently delivered to a chat_id instead.
  const { receiveIdType, receiveId } = resolveReceiveId(req, chatId)

  const body = await segmentsToLarkBodyAsync(req.segments, {
    adapterId,
    conversationKey: buildConversationKeyFromRef(req, chatId, threadId),
  })

  // Reply anchor — same dedicated endpoint as the sync path (see
  // `serializeSend`); the production `send()` uses THIS serialiser, so
  // without the branch here `replyTo` never reached Lark at all.
  const replyTargetId = req.replyTo?.messageId
  if (replyTargetId) {
    const payload: Record<string, unknown> = {
      msg_type: body.msg_type,
      content: body.content,
    }
    if (threadId) payload["reply_in_thread"] = true
    return {
      method: "POST",
      url: `${LARK_API_BASE}/im/v1/messages/${replyTargetId}/reply`,
      payload,
    }
  }

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
