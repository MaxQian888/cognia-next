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

    default:
      // Unsupported segment types dropped in Phase 1
      return null
  }
}

/**
 * Project an OutboundRequest into an ordered list of Discord REST calls.
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
