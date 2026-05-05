/**
 * The cross-platform message payload. A NormalizedInboundEvent carries a
 * MessageSegment[]; an OutboundRequest carries one too. Adapter parsers
 * project platform-native messages into this shape; adapter serialisers
 * project this shape back out, applying capability-aware degradation.
 *
 * Discriminator is `type`; renderer code switches on it.
 */
export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "markdown"; md: string }
  | { type: "image"; url: string; alt?: string; width?: number; height?: number }
  | { type: "video"; url: string; thumbnailUrl?: string; durationSec?: number }
  | { type: "voice"; url: string; durationSec?: number; transcript?: string }
  | { type: "file"; url: string; name: string; mimeType: string; sizeBytes: number }
  | { type: "mention"; userId: string; displayName?: string }
  | { type: "emoji"; code: string }
  | { type: "code"; language?: string; code: string }
  | { type: "card"; card: PlatformCard }
  | { type: "reply"; messageId: string; snippet: string }
  | { type: "location"; lat: number; lon: number; name?: string }
  | { type: "poll"; question: string; options: string[]; multi?: boolean }

export type SegmentType = MessageSegment["type"]

/** Opaque platform-native card payload. Bus never inspects; adapters own. */
export interface PlatformCard {
  kind: string
  payload: unknown
}

export function isTextSegment(s: MessageSegment): s is Extract<MessageSegment, { type: "text" }> {
  return s.type === "text"
}
export function isImageSegment(s: MessageSegment): s is Extract<MessageSegment, { type: "image" }> {
  return s.type === "image"
}
export function isMarkdownSegment(
  s: MessageSegment
): s is Extract<MessageSegment, { type: "markdown" }> {
  return s.type === "markdown"
}

/**
 * Flatten a segment list into a plain-text projection used by trigger
 * matchers (TriggerPolicy.rules `keyword` / `slash-command`) and search.
 * Non-text segments project to a stable placeholder so a regex match on
 * the projection never accidentally fires on raw URLs or code.
 */
export function segmentsToPlainText(segments: MessageSegment[]): string {
  const out: string[] = []
  for (const s of segments) {
    switch (s.type) {
      case "text":
      case "markdown":
        out.push(s.type === "text" ? s.text : s.md)
        break
      case "mention":
        out.push(`@${s.displayName ?? s.userId}`)
        break
      case "image":
        out.push(" [image] ")
        break
      case "video":
        out.push(" [video] ")
        break
      case "voice":
        out.push(s.transcript ? ` ${s.transcript} ` : " [voice] ")
        break
      case "file":
        out.push(` [file:${s.name}] `)
        break
      case "emoji":
        out.push(`[:${s.code}:]`)
        break
      case "code":
        out.push(s.code)
        break
      case "card":
        out.push(" [card] ")
        break
      case "reply":
        out.push(` [reply:${s.snippet}] `)
        break
      case "location":
        out.push(` [location:${s.name ?? `${s.lat},${s.lon}`}] `)
        break
      case "poll":
        out.push(` [poll:${s.question}] `)
        break
    }
  }
  return out.join("")
}
