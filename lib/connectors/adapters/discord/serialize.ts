/**
 * Discord outbound serialiser.
 *
 * Projects an OutboundRequest into one or more Discord REST API calls.
 * Each call is { method, url, payload } — the adapter executes them in order.
 *
 * Discord markdown is close to CommonMark. Only escape characters that would
 * unintentionally open formatting: * _ ~ | > (and \\ itself).
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildDiscordA2UIPayload } from "./a2ui-mapper"

const DISCORD_API_BASE = "https://discord.com/api/v10"

export interface SerializedDiscordCall {
  method: "POST" | "PATCH" | "DELETE" | "PUT"
  url: string
  payload: Record<string, unknown>
}

/** Discord rejects message `content` longer than 2000 characters with a 400. */
export const DISCORD_MAX_CONTENT_LENGTH = 2000

/**
 * Split `text` into ≤`max`-char chunks, preferring to cut at the last
 * newline inside the window so markdown blocks/paragraphs stay intact.
 * The boundary newline itself is consumed (not re-emitted).
 */
export function chunkDiscordContent(text: string, max = DISCORD_MAX_CONTENT_LENGTH): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    const nl = rest.lastIndexOf("\n", max)
    // No usable newline in the window (or only a leading one) → hard cut.
    const cut = nl > 0 ? nl : max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut === nl ? cut + 1 : cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/**
 * Build one POST /messages call per ≤2000-char chunk of `content`. Only the
 * first chunk carries the `message_reference` (one reply ping, not N).
 */
function contentCalls(
  content: string,
  url: string,
  messageReference: Record<string, unknown> | undefined
): SerializedDiscordCall[] {
  return chunkDiscordContent(content).map((chunk, i) => {
    const payload: Record<string, unknown> = { content: chunk }
    if (messageReference && i === 0) payload["message_reference"] = messageReference
    return { method: "POST" as const, url, payload }
  })
}

/** Extract channel_id from the conversation reference. */
function channelIdFromRef(req: OutboundRequest): string {
  const ref = req.conversationRef as Record<string, unknown>
  return String(ref["channelId"] ?? "")
}

/** Build the message_reference field for replies. */
function buildMessageReference(
  req: OutboundRequest,
  channelId: string
): Record<string, unknown> | undefined {
  if (!req.replyTo?.messageId) return undefined
  const ref = req.conversationRef as Record<string, unknown>
  return {
    message_id: req.replyTo.messageId,
    channel_id: channelId,
    guild_id: ref["guildId"],
  }
}

// GAP: per-segment fragmentation — every text/markdown/code/mention segment
// still becomes its own Discord message (and edits consolidate lossily to the
// first text segment); merging consecutive segments into one message is a
// separate follow-up.
function serializeSegment(
  seg: MessageSegment,
  channelId: string,
  messageReference: Record<string, unknown> | undefined
): SerializedDiscordCall[] {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`

  switch (seg.type) {
    case "text":
      // Chunked at Discord's 2000-char content cap (400 otherwise).
      return contentCalls(seg.text, url, messageReference)

    case "markdown":
      return contentCalls(seg.md, url, messageReference)

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      const payload: Record<string, unknown> = { content: block }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "image": {
      // Phase 1: URL-only via attachments array embed in embeds[]
      const payload: Record<string, unknown> = {
        embeds: [{ image: { url: seg.url } }],
      }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "file": {
      // Phase 1: URL-only link in content
      const payload: Record<string, unknown> = { content: seg.url }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "mention": {
      const content = `<@${seg.userId}>`
      const payload: Record<string, unknown> = { content }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "emoji": {
      const payload: Record<string, unknown> = { content: seg.code }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    case "reply":
      // reply segments are handled via replyTo on the OutboundRequest
      return []

    case "a2ui": {
      // Sync path: emit the `plainTextMirror` as fallback. The async
      // `serializeOutboundAsync` invokes the full mapper (embeds +
      // components) and overrides this.
      const payload: Record<string, unknown> = { content: seg.plainTextMirror }
      if (messageReference) payload["message_reference"] = messageReference
      return [{ method: "POST", url, payload }]
    }

    default:
      // Unsupported segment types dropped in Phase 1
      return []
  }
}

/**
 * Project an OutboundRequest into an ordered list of Discord REST calls
 * (sync path). a2ui segments fall back to `plainTextMirror`; use
 * `serializeOutboundAsync` for the full embed + components rendering.
 */
export function serializeOutbound(req: OutboundRequest): SerializedDiscordCall[] {
  const channelId = channelIdFromRef(req)
  const messageReference = buildMessageReference(req, channelId)
  const calls: SerializedDiscordCall[] = []

  for (const seg of req.segments) {
    calls.push(...serializeSegment(seg, channelId, messageReference))
  }

  return calls
}

/**
 * Async serializer used by the production adapter `send()`. a2ui
 * segments are projected via `buildDiscordA2UIPayload` (embeds +
 * components + callback bindings); other segments delegate to the sync
 * path.
 */
export async function serializeOutboundAsync(
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedDiscordCall[]> {
  const channelId = channelIdFromRef(req)
  const messageReference = buildMessageReference(req, channelId)
  const calls: SerializedDiscordCall[] = []
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`

  for (const seg of req.segments) {
    if (seg.type === "a2ui") {
      const payload = await buildDiscordA2UIPayload({
        adapterId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: extractConversationKey(req, channelId),
      })
      const hasNative =
        (payload.embeds && payload.embeds.length > 0) ||
        (payload.components && payload.components.length > 0) ||
        (payload.content && payload.content.length > 0)
      if (!hasNative) {
        // Mapper produced nothing — fall back to plain text mirror.
        const body: Record<string, unknown> = { content: seg.plainTextMirror }
        if (messageReference) body["message_reference"] = messageReference
        calls.push({ method: "POST", url, payload: body })
        continue
      }
      const body: Record<string, unknown> = { ...payload }
      if (messageReference) body["message_reference"] = messageReference
      calls.push({ method: "POST", url, payload: body })
      continue
    }
    calls.push(...serializeSegment(seg, channelId, messageReference))
  }

  return calls
}

function extractConversationKey(req: OutboundRequest, channelId: string): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const adapterId = typeof ref["adapterId"] === "string" ? ref["adapterId"] : ""
  if (!adapterId || !channelId) return undefined
  const thread = req.threadId
  return thread
    ? `discord:${adapterId}:${channelId}:${thread}`
    : `discord:${adapterId}:${channelId}`
}

/**
 * Build a DELETE call for a specific message.
 */
export function serializeDelete(channelId: string, messageId: string): SerializedDiscordCall {
  return {
    method: "DELETE",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
    payload: {},
  }
}

/**
 * Build a PATCH call for editing a message.
 */
export function serializeEdit(
  channelId: string,
  messageId: string,
  content: string
): SerializedDiscordCall {
  return {
    method: "PATCH",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
    payload: { content },
  }
}

/**
 * Build a `GET /channels/{channel.id}/messages?limit=N&before=cursor`
 * call (added at ADR-0009 v41 / A2.b). Discord's REST history endpoint
 * caps `limit` at 100 per request; the adapter pages with `before` to
 * walk older messages.
 */
export function serializeFetchHistory(
  channelId: string,
  options: { limit?: number; before?: string; after?: string }
): SerializedDiscordCall {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
  const qs = new URLSearchParams({ limit: String(limit) })
  if (options.before) qs.set("before", options.before)
  if (options.after) qs.set("after", options.after)
  // GET is not in the SerializedDiscordCall method union (the adapter's
  // doRequest handles all REST verbs through fetch directly). We model
  // history fetches as method="POST" with an empty payload so the type
  // contract stays narrow — the adapter switches to GET when the URL
  // ends in /messages?limit=...
  return {
    method: "POST",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages?${qs.toString()}`,
    payload: {},
  }
}

/**
 * Build a `PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
 * call (added at ADR-0009 v41 / A2 of the IM connector gap-closure plan).
 *
 * `emoji` may be either:
 *   - a unicode character (e.g. `"👍"`) — URL-encoded by this helper, OR
 *   - a custom-emoji identifier in Discord's `name:id` form
 *     (e.g. `"thumbsup:43623862374"`) — URL-encoded as a single segment.
 *
 * Reactions are per-emoji on Discord (no batched ReactionType[] like on
 * Telegram). To remove a reaction, use `serializeReactionRemoval` below
 * (DELETE on the same path).
 */
export function serializeReaction(
  channelId: string,
  messageId: string,
  emoji: string
): SerializedDiscordCall {
  return {
    method: "PUT",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    payload: {},
  }
}

/**
 * Build a DELETE call to remove the bot's own reaction from a message.
 * Useful for retracting an earlier `serializeReaction` call.
 */
export function serializeReactionRemoval(
  channelId: string,
  messageId: string,
  emoji: string
): SerializedDiscordCall {
  return {
    method: "DELETE",
    url: `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    payload: {},
  }
}
