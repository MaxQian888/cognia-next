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

/** Characters that open Discord markdown formatting. */
const DISCORD_MD_SPECIALS = /([*_~|>\\])/g

export function escapeDiscordMd(text: string): string {
  return text.replace(DISCORD_MD_SPECIALS, "\\$1")
}

export interface SerializedDiscordCall {
  method: "POST" | "PATCH" | "DELETE"
  url: string
  payload: Record<string, unknown>
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

function serializeSegment(
  seg: MessageSegment,
  channelId: string,
  messageReference: Record<string, unknown> | undefined
): SerializedDiscordCall | null {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages`

  switch (seg.type) {
    case "text": {
      const payload: Record<string, unknown> = { content: seg.text }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "markdown": {
      const payload: Record<string, unknown> = { content: seg.md }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      const payload: Record<string, unknown> = { content: block }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "image": {
      // Phase 1: URL-only via attachments array embed in embeds[]
      const payload: Record<string, unknown> = {
        embeds: [{ image: { url: seg.url } }],
      }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "file": {
      // Phase 1: URL-only link in content
      const payload: Record<string, unknown> = { content: seg.url }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "mention": {
      const content = `<@${seg.userId}>`
      const payload: Record<string, unknown> = { content }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "emoji": {
      const payload: Record<string, unknown> = { content: seg.code }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    case "reply":
      // reply segments are handled via replyTo on the OutboundRequest
      return null

    case "a2ui": {
      // Sync path: emit the `plainTextMirror` as fallback. The async
      // `serializeOutboundAsync` invokes the full mapper (embeds +
      // components) and overrides this.
      const payload: Record<string, unknown> = { content: seg.plainTextMirror }
      if (messageReference) payload["message_reference"] = messageReference
      return { method: "POST", url, payload }
    }

    default:
      // Unsupported segment types dropped in Phase 1
      return null
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
    const call = serializeSegment(seg, channelId, messageReference)
    if (call) calls.push(call)
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
    const call = serializeSegment(seg, channelId, messageReference)
    if (call) calls.push(call)
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
