/**
 * Matrix timeline event → NormalizedInboundEvent parser.
 *
 * Handles the event types the adapter surfaces:
 * - `m.room.message`        → kind="create" (or "edit" when the content
 *                             carries an `m.replace` relation + `m.new_content`).
 * - `m.reaction`            → kind="system" with systemKind="reaction_added".
 * - `m.room.redaction`      → kind="delete" (`replacesMessageId` = redacted id).
 *
 * Replies to one of our own A2UI surface messages are correlated separately
 * via {@link parseMatrixReplyCorrelation} so the user's free-text reply is
 * routed onto the surface as an `input` action (mirrors Telegram ForceReply).
 *
 * Media coverage: m.image → image, m.file → file, m.audio → voice,
 * m.video → video. The `mxc://` URI is passed through verbatim as the
 * segment url (the attachment cache resolves it to a local file later),
 * matching how the Telegram parser passes `tg://file/<id>`.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import { buildMatrixMessageId } from "./ids"

// ---------------------------------------------------------------------------
// Minimal Matrix client-server API types (only the fields we consume)
// ---------------------------------------------------------------------------

export interface MatrixRelatesTo {
  rel_type?: "m.replace" | "m.annotation" | "m.thread" | string
  event_id?: string
  /** Reaction key (the emoji) for `m.annotation`. */
  key?: string
  "m.in_reply_to"?: { event_id?: string }
  /** Thread fallback flag — present on threaded replies. */
  is_falling_back?: boolean
}

export interface MatrixMentions {
  user_ids?: string[]
  room?: boolean
}

export interface MatrixEventContent {
  msgtype?: string
  body?: string
  format?: string
  formatted_body?: string
  /** mxc:// URI for media messages. */
  url?: string
  filename?: string
  info?: {
    mimetype?: string
    size?: number
    duration?: number
    w?: number
    h?: number
    thumbnail_url?: string
  }
  "m.relates_to"?: MatrixRelatesTo
  /** Replacement content for `m.replace` edits. */
  "m.new_content"?: MatrixEventContent
  "m.mentions"?: MatrixMentions
  /** Redaction target — room v11 moved it from the top level into content. */
  redacts?: string
}

export interface MatrixTimelineEvent {
  type: string
  event_id: string
  sender: string
  origin_server_ts: number
  content: MatrixEventContent
  /** Legacy redaction target (pre-v11 rooms put it at the top level). */
  redacts?: string
  unsigned?: { redacted_because?: unknown; transaction_id?: string }
}

export interface MatrixRoomTimeline {
  events?: MatrixTimelineEvent[]
  prev_batch?: string
  limited?: boolean
}

export interface MatrixJoinedRoom {
  timeline?: MatrixRoomTimeline
}

export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, MatrixJoinedRoom>
    /** Pending invites; the transport auto-joins these. */
    invite?: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `@local:server` → `local`, used as a friendly display name fallback. */
function localpart(userId: string): string {
  const m = /^@([^:]+):/.exec(userId)
  return m ? m[1] : userId
}

function buildPlatformIdentity(
  adapterId: string,
  roomId: string,
  sender: string
): PlatformIdentity {
  return {
    id: `matrix:${roomId}:${sender}`,
    platform: "matrix",
    adapterId,
    remoteUserId: sender,
    displayName: localpart(sender),
  }
}

/**
 * Strip the quoted-reply fallback Matrix clients prepend to the plain `body`
 * of a reply ("> <@user> original\n\nactual reply"). The mx-reply lines are a
 * legacy compatibility affordance; we only want the user's actual text.
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split("\n")
  let i = 0
  while (i < lines.length && lines[i].startsWith("> ")) i += 1
  // A single blank separator line follows the quote block.
  if (i < lines.length && lines[i].trim() === "") i += 1
  return lines.slice(i).join("\n").trim() || body.trim()
}

function resolveMediaUrl(
  url: string,
  homeserver: string | undefined
): { url: string; rawUrl?: string } {
  if (!url.startsWith("mxc://")) return { url }
  const resolved = homeserver ? matrixMediaDownloadUrl(homeserver, url) : null
  return { url: resolved ?? url, rawUrl: url }
}

function buildSegments(
  content: MatrixEventContent,
  options: { homeserver?: string } = {}
): MessageSegment[] {
  const segments: MessageSegment[] = []
  const msgtype = content.msgtype ?? "m.text"

  switch (msgtype) {
    case "m.image":
      if (content.url) {
        const media = resolveMediaUrl(content.url, options.homeserver)
        segments.push({
          type: "image",
          url: media.url,
          rawUrl: media.rawUrl,
          alt: content.body,
          width: content.info?.w,
          height: content.info?.h,
          mimeType: content.info?.mimetype,
        })
        return segments
      }
      break
    case "m.video":
      if (content.url) {
        const media = resolveMediaUrl(content.url, options.homeserver)
        segments.push({
          type: "video",
          url: media.url,
          rawUrl: media.rawUrl,
          thumbnailUrl: content.info?.thumbnail_url,
          durationSec:
            content.info?.duration !== undefined
              ? Math.round(content.info.duration / 1000)
              : undefined,
          mimeType: content.info?.mimetype,
        })
        return segments
      }
      break
    case "m.audio":
      if (content.url) {
        const media = resolveMediaUrl(content.url, options.homeserver)
        segments.push({
          type: "voice",
          url: media.url,
          rawUrl: media.rawUrl,
          durationSec:
            content.info?.duration !== undefined
              ? Math.round(content.info.duration / 1000)
              : undefined,
          mimeType: content.info?.mimetype,
        })
        return segments
      }
      break
    case "m.file":
      if (content.url) {
        const media = resolveMediaUrl(content.url, options.homeserver)
        segments.push({
          type: "file",
          url: media.url,
          rawUrl: media.rawUrl,
          name: content.filename ?? content.body ?? "file",
          mimeType: content.info?.mimetype ?? "application/octet-stream",
          sizeBytes: content.info?.size ?? 0,
        })
        return segments
      }
      break
    default:
      break
  }

  // m.text / m.notice / m.emote (and any media event missing its url) →
  // text from the body, with the reply fallback quote stripped.
  const raw = content.body ?? ""
  const text = content["m.relates_to"]?.["m.in_reply_to"]?.event_id ? stripReplyFallback(raw) : raw
  if (text) segments.push({ type: "text", text })
  return segments
}

/**
 * Detect whether the bot was addressed. Sources, in order of authority:
 * - `m.mentions.user_ids` containing the bot (the spec's intentional-mention
 *   signal),
 * - `m.mentions.room` — an @room ping addresses everyone, the bot included
 *   (encoded as `selfMentioned: true`, which is what the at-gate consumes),
 * - a reply whose target is one of the bot's own messages (`replyToSelf`),
 * - legacy clients that omit `m.mentions` but link the user via a
 *   `matrix.to` permalink pill in `formatted_body`.
 */
function detectMentions(
  selfId: string,
  content: MatrixEventContent,
  replyToSelf: boolean
): { selfMentioned: boolean; users: string[] } {
  const users = content["m.mentions"]?.user_ids ?? []
  const roomPing = content["m.mentions"]?.room === true
  let selfMentioned = replyToSelf || roomPing || (selfId !== "" && users.includes(selfId))
  if (!selfMentioned && selfId !== "" && typeof content.formatted_body === "string") {
    // Legacy fallback: mention pills are `matrix.to/#/@user:server` anchors,
    // with the user id either raw or percent-encoded.
    const html = content.formatted_body
    selfMentioned =
      html.includes(`matrix.to/#/${selfId}`) ||
      html.includes(`matrix.to/#/${encodeURIComponent(selfId)}`)
  }
  return { selfMentioned, users }
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

export interface ParseMatrixEventOptions {
  homeserver?: string
  /**
   * Event ids the adapter itself recently sent (bare, no room prefix). Used
   * to flag replies to the bot's own messages as `selfMentioned` — a reply
   * to the bot addresses it just as much as an explicit mention does.
   * Best-effort: only covers messages sent during this process lifetime.
   */
  ownEventIds?: ReadonlySet<string>
}

/**
 * Project a Matrix timeline event into a NormalizedInboundEvent.
 *
 * `messageId` / `replacesMessageId` are stamped with the adapter-public
 * `"<roomId>|<eventId>"` composite (see ids.ts) so they match the
 * `platformMessageId` that `send()`/`edit()` return — the bus stored-message
 * index correlates edits/redactions across both directions. `replyTo` and
 * `conversationRef.eventId` stay BARE (wire-level references).
 *
 * Returns `null` for:
 * - events authored by the bot itself (echoed back through `/sync`),
 * - membership / state events and other types we don't surface,
 * - already-redacted events (`unsigned.redacted_because`).
 */
export function parseMatrixEvent(
  adapterId: string,
  selfId: string,
  roomId: string,
  ev: MatrixTimelineEvent,
  options: ParseMatrixEventOptions = {}
): NormalizedInboundEvent | null {
  // Never echo our own sends back into the bus.
  if (selfId !== "" && ev.sender === selfId) return null

  const sender = buildPlatformIdentity(adapterId, roomId, ev.sender)
  const timestamp = ev.origin_server_ts

  // ── Redaction → delete ────────────────────────────────────────────────
  if (ev.type === "m.room.redaction") {
    // Room v11 moved the target from the top-level `redacts` into
    // `content.redacts`; check both (m.relates_to is NOT where it lives).
    const redacts =
      ev.redacts ?? (typeof ev.content?.redacts === "string" ? ev.content.redacts : undefined)
    if (!redacts) return null
    const conversationKey = buildConversationKey("matrix", adapterId, roomId)
    return {
      platform: "matrix",
      adapterId,
      selfId,
      messageId: buildMatrixMessageId(roomId, ev.event_id),
      conversationRef: { platform: "matrix", adapterId, roomId, eventId: ev.event_id },
      conversationKey,
      sender,
      channel: { id: conversationKey, kind: "group", platformChannelId: roomId },
      segments: [],
      plainText: "",
      mentions: { selfMentioned: false, users: [] },
      timestamp,
      raw: ev,
      kind: "delete",
      replacesMessageId: buildMatrixMessageId(roomId, redacts),
    }
  }

  // ── Reaction → system event ───────────────────────────────────────────
  if (ev.type === "m.reaction") {
    const rel = ev.content?.["m.relates_to"]
    if (!rel || rel.rel_type !== "m.annotation" || !rel.event_id) return null
    const conversationKey = buildConversationKey("matrix", adapterId, roomId)
    return {
      platform: "matrix",
      adapterId,
      selfId,
      messageId: buildMatrixMessageId(roomId, ev.event_id),
      conversationRef: { platform: "matrix", adapterId, roomId, eventId: ev.event_id },
      conversationKey,
      sender,
      channel: { id: conversationKey, kind: "group", platformChannelId: roomId },
      segments: [{ type: "emoji", code: rel.key ?? "?" }],
      plainText: rel.key ?? "[reaction]",
      mentions: { selfMentioned: false, users: [] },
      timestamp,
      raw: ev,
      kind: "system",
      systemKind: "reaction_added",
      replacesMessageId: buildMatrixMessageId(roomId, rel.event_id),
    }
  }

  // ── Messages (create / edit) ──────────────────────────────────────────
  if (ev.type !== "m.room.message") return null
  if (ev.unsigned?.redacted_because !== undefined) return null

  // A spec-conformant `m.room.message` always carries `content`, but a
  // malformed / non-standard event may omit it; default to `{}` so a single bad
  // event yields an empty message instead of throwing out of the sync loop.
  const msgContent = ev.content ?? {}
  const rel = msgContent["m.relates_to"]
  const isEdit = rel?.rel_type === "m.replace" && rel.event_id !== undefined
  // For edits the renderable content lives in `m.new_content`.
  const renderContent = isEdit ? (msgContent["m.new_content"] ?? msgContent) : msgContent

  // Thread root → conversation thread key. A threaded reply carries
  // rel_type === "m.thread"; the `event_id` is the thread root.
  const threadId =
    rel?.rel_type === "m.thread" && rel.event_id !== undefined ? rel.event_id : undefined

  const conversationKey = buildConversationKey("matrix", adapterId, roomId, threadId)

  const inReplyTo = rel?.["m.in_reply_to"]?.event_id
  // replyTo stays a BARE event id — it is echoed back onto the wire as an
  // `m.in_reply_to` target by the serializer.
  const replyTo = inReplyTo
    ? { messageId: inReplyTo, snippet: (renderContent.body ?? "").slice(0, 100) }
    : undefined

  const segments = buildSegments(renderContent, options)
  const plainText = segmentsToPlainText(segments)
  // A reply whose target is one of the bot's own recent messages addresses
  // the bot (mention-gated rooms would otherwise drop it).
  const replyToSelf = inReplyTo !== undefined && (options.ownEventIds?.has(inReplyTo) ?? false)
  const { selfMentioned, users } = detectMentions(selfId, renderContent, replyToSelf)

  // NOTE: inbound `m.notice` (bot-convention messages) parses like a normal
  // message; `raw.content.msgtype` keeps the distinction available to any
  // future bot-to-bot policy without a schema change.
  return {
    platform: "matrix",
    adapterId,
    selfId,
    messageId: buildMatrixMessageId(roomId, ev.event_id),
    conversationRef: { platform: "matrix", adapterId, roomId, eventId: ev.event_id },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: threadId !== undefined ? "thread" : "group",
      platformChannelId: roomId,
    },
    segments,
    plainText,
    replyTo,
    mentions: { selfMentioned, users },
    timestamp,
    raw: ev,
    kind: isEdit ? "edit" : "create",
    replacesMessageId:
      isEdit && rel?.event_id ? buildMatrixMessageId(roomId, rel.event_id) : undefined,
  }
}

export function matrixMediaDownloadUrl(homeserver: string, mxcUrl: string): string | null {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUrl)
  if (!match) return null
  const base = normalizeMediaHomeserver(homeserver)
  if (!base) return null
  const serverName = encodeURIComponent(match[1])
  const mediaId = encodeURIComponent(match[2])
  return `${base}/_matrix/client/v1/media/download/${serverName}/${mediaId}`
}

function normalizeMediaHomeserver(homeserver: string): string {
  const trimmed = homeserver.trim()
  if (!trimmed) return ""
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, "")
}

// ---------------------------------------------------------------------------
// A2UI reply-correlation (simulated interaction channel)
// ---------------------------------------------------------------------------

/**
 * Correlate an inbound reply against an outstanding A2UI surface binding.
 *
 * When the adapter sends an A2UI surface it records a `force_reply` binding
 * keyed by the sent event id (see serialize.ts). If a user replies to that
 * surface message, this synthesises a `ConnectorCallbackEvent{actionType:
 * "input"}` so the bus routes the free-text reply onto the surface — the same
 * pattern Telegram uses for ForceReply.
 *
 * Returns `null` when there's no reply relation, no matching binding, or the
 * binding expired; the transport then falls back to the normal message path.
 */
export async function parseMatrixReplyCorrelation(
  adapterId: string,
  selfId: string,
  roomId: string,
  ev: MatrixTimelineEvent
): Promise<ConnectorCallbackEvent | null> {
  if (ev.type !== "m.room.message") return null
  if (selfId !== "" && ev.sender === selfId) return null
  const inReplyTo = ev.content["m.relates_to"]?.["m.in_reply_to"]?.event_id
  if (!inReplyTo) return null

  const { resolveCallbackBinding } = await import("@/lib/connectors/adapters/_shared/a2ui-mapper")
  const binding = await resolveCallbackBinding(adapterId, inReplyTo)
  if (!binding || binding.kind !== "force_reply") return null
  if (binding.expiresAt !== undefined && binding.expiresAt < Date.now()) return null

  const conversationKey = buildConversationKey("matrix", adapterId, roomId)
  const text = stripReplyFallback(ev.content.body ?? "")

  return {
    platform: "matrix",
    adapterId,
    selfId,
    triggerId: `mxreply:${ev.event_id}:${inReplyTo}`,
    surfaceId: binding.surfaceId,
    componentId: binding.componentId,
    actionType: "input",
    value: text,
    payload: undefined,
    originatingMessageId: ev.event_id,
    conversationKey: binding.conversationKey ?? conversationKey,
    user: buildPlatformIdentity(adapterId, roomId, ev.sender),
    timestamp: Date.now(),
    raw: ev,
  }
}
