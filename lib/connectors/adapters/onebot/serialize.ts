/**
 * OneBot outbound serialiser.
 *
 * Projects OutboundRequest → array of OneBot RPC action calls.
 * Each call carries `action`, `params`, and a unique `echo` for round-trip
 * response matching.
 *
 * NOTE: OneBot v11/v12 do NOT support message editing natively.
 * Calls to serializeEdit* throw an UnsupportedError (callers should catch
 * and return an `unsupported_segment` OutboundError). Typing is a no-op
 * since OneBot has no typing indicator API.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { ForwardMessageInput } from "@/types/connectors/adapter"
import type { MessageSegment } from "@/types/connectors/segment"
import { toOneBotSegments } from "./segments"
import { buildOneBotA2UISegments } from "./a2ui-mapper"

export class OneBotUnsupportedError extends Error {
  constructor(action: string) {
    super(`OneBot does not support: ${action}`)
    this.name = "OneBotUnsupportedError"
  }
}

/**
 * A request that can never succeed on the wire (missing chat target,
 * v12 media without upload_file, …). Callers map it to a non-retryable
 * `validation` OutboundError instead of letting the payload bounce off
 * the upstream.
 */
export class OneBotValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OneBotValidationError"
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

  // No target at all — previously this fell through to send_group_msg with
  // group_id: undefined, which the upstream rejects with an opaque error.
  throw new OneBotValidationError(
    "conversationRef has no chat target (expected chatKey 'p:<id>'/'g:<id>' or userId/groupId)"
  )
}

/**
 * OneBot v11 types `user_id` / `group_id` as number. Convert numeric strings
 * (the internal chatKey representation) to numbers, matching the
 * Number()-converting siblings (delete/history/forward); pass non-numeric ids
 * through unchanged — some implementations use non-numeric ids and mangling
 * them to NaN would be worse.
 */
function toWireId(id: string | number): string | number {
  if (typeof id === "number") return id
  return /^\d+$/.test(id) ? Number(id) : id
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
        params: { user_id: toWireId(userId ?? ""), message: obSegments },
      },
    ]
  }

  return [
    {
      action: "send_group_msg",
      echo: nextEcho(),
      params: { group_id: toWireId(groupId ?? ""), message: obSegments },
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

  // GAP: OneBot 12 requires an `upload_file` round-trip first — media
  // segments carry a `file_id` from that upload, never a raw URL. Every real
  // target we ship against (NapCat / Lagrange / LLOneBot) is v11, so the v12
  // upload flow is intentionally not implemented; fail honestly instead of
  // sending a URL-in-file_id payload a compliant v12 impl rejects.
  const media = segments.find(
    (s) => s.type === "image" || s.type === "voice" || s.type === "video" || s.type === "file"
  )
  if (media !== undefined) {
    throw new OneBotValidationError(
      `OneBot 12 media send ('${media.type}') requires upload_file; not supported yet`
    )
  }

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
// reaction — NapCat `set_msg_emoji_like` extension
// ---------------------------------------------------------------------------

/**
 * Serialise a `set_msg_emoji_like` call — NapCat's QQ "emoji like" reaction
 * (LLOneBot originated the action; NapCat adopted it).
 *
 * Not part of the OneBot v11/v12 standard; advertised via the
 * `set_msg_emoji_like` feature flag the upstream probe records on
 * `implMetadata` (see `index.ts:addReaction` / `removeReaction`, which gate
 * on it). `emoji_id` is the QQ face id; `set: true` (the upstream default)
 * adds the reaction, `set: false` removes it.
 */
export function serializeSetMsgEmojiLike(
  messageId: string,
  emojiId: string,
  set = true
): SerializedOneBotCall {
  return {
    action: "set_msg_emoji_like",
    echo: nextEcho(),
    params: { message_id: Number(messageId), emoji_id: emojiId, set },
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
// identity probe (get_login_info / get_self_info)
// ---------------------------------------------------------------------------

/**
 * Serialise a `get_login_info` call — the OneBot v11 self-identity action.
 * The response `data` carries `{ user_id, nickname }` (the bot's own QQ
 * number + display name). Used by the adapter's `probeIdentity` on connect
 * to populate `AdapterInstanceRow.lastWhoamiResult`, mirroring the identity
 * probes every other platform runs (Telegram getMe / Slack auth.test /
 * Lark bot/v3/info).
 */
export function serializeGetLoginInfoV11(): SerializedOneBotCall {
  return { action: "get_login_info", echo: nextEcho(), params: {} }
}

/**
 * Serialise the OneBot v12 self-identity action `get_self_info`. The response
 * `data` carries `{ user_id, user_name, user_displayname }`.
 */
export function serializeGetLoginInfoV12(): SerializedOneBotCall {
  return { action: "get_self_info", echo: nextEcho(), params: {} }
}

// ---------------------------------------------------------------------------
// single-message fetch (get_msg — OneBot v11 standard)
// ---------------------------------------------------------------------------

/**
 * Serialise a `get_msg` call. Given a v11 message id (e.g. the `id` inside an
 * inbound `reply` segment), the response `data` carries the referenced
 * message (`message` segments / CQ string + `raw_message`) so the
 * inbound-reply enrichment can fill the reply snippet.
 */
export function serializeGetMsgV11(messageId: string): SerializedOneBotCall {
  return { action: "get_msg", echo: nextEcho(), params: { message_id: toWireId(messageId) } }
}

// ---------------------------------------------------------------------------
// merged-forward fetch (get_forward_msg — NapCat / go-cqhttp extension)
// ---------------------------------------------------------------------------

/**
 * Serialise a `get_forward_msg` call. Given a merged-forward `id` (the `id`
 * inside an inbound `forward` segment), the response `data.messages`
 * carries the flattened forward nodes so the inbound enrichment step can
 * render the real body instead of a `[合并转发消息]` marker.
 */
export function serializeGetForwardMsgV11(id: string): SerializedOneBotCall {
  return { action: "get_forward_msg", echo: nextEcho(), params: { id, message_id: id } }
}

// ---------------------------------------------------------------------------
// merged-forward send (send_group_forward_msg / send_private_forward_msg)
// ---------------------------------------------------------------------------

/**
 * Resolve a {@link ForwardMessageInput.target} to a OneBot receive target.
 * Accepts the OneBot conversation key (`onebot:<adapterId>:<chatType>:<chatId>`)
 * or the short chat key (`g:<id>` / `p:<id>`). Returns null when neither
 * form is recognised.
 */
function parseForwardTarget(
  target: string
): { groupId: string } | { userId: string } | null {
  // Full conversation key: onebot:<adapterId>:<chatType>:<chatId>
  const segs = target.split(":")
  if (segs.length === 4 && segs[0] === "onebot") {
    if (segs[2] === "g" && segs[3]) return { groupId: segs[3] }
    if (segs[2] === "p" && segs[3]) return { userId: segs[3] }
    return null
  }
  // Short chat key: g:<id> / p:<id>
  if (target.startsWith("g:") && target.length > 2) return { groupId: target.slice(2) }
  if (target.startsWith("p:") && target.length > 2) return { userId: target.slice(2) }
  return null
}

/**
 * Serialise a merged-forward send (NapCat extension). Forwards the referenced
 * `messageIds` as one combined card into `input.target`, choosing
 * `send_group_forward_msg` or `send_private_forward_msg` by target type.
 * Each id becomes a `node` segment referencing the existing message.
 *
 * Returns null when the target is unrecognised or no message ids are given,
 * so the caller can surface a `validation` OutboundError (mirrors
 * {@link serializeOutboundV11} returning an empty array).
 */
export function serializeSendForwardMsgV11(input: ForwardMessageInput): SerializedOneBotCall | null {
  const ids = input.messageIds ?? (input.messageId ? [input.messageId] : [])
  if (ids.length === 0) return null

  const dest = parseForwardTarget(input.target)
  if (dest === null) return null

  const messages = ids.map((id) => ({ type: "node", data: { id } }))

  if ("groupId" in dest) {
    return {
      action: "send_group_forward_msg",
      echo: nextEcho(),
      params: { group_id: Number(dest.groupId), messages },
    }
  }
  return {
    action: "send_private_forward_msg",
    echo: nextEcho(),
    params: { user_id: Number(dest.userId), messages },
  }
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
