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
  | {
      type: "mention"
      /** The mentioned entity's stable platform id. For role/channel mentions on platforms that distinguish those (Discord), this carries the role or channel id; for user mentions, the user id. */
      userId: string
      displayName?: string
      /**
       * Mention kind. Defaults to `"user"` when unspecified so v18-v40
       * readers continue to treat every mention as a user mention.
       * `"role"` is emitted by the Discord parser from `mention_roles`
       * (ADR-0009 v41 / A2). `"channel"` is reserved for the future
       * Discord channel-mention extension.
       */
      kind?: "user" | "role" | "channel"
    }
  | { type: "emoji"; code: string }
  | { type: "code"; language?: string; code: string }
  | { type: "card"; card: PlatformCard }
  | { type: "reply"; messageId: string; snippet: string }
  | { type: "location"; lat: number; lon: number; name?: string }
  | { type: "poll"; question: string; options: string[]; multi?: boolean }
  | A2UIMessageSegment

export type SegmentType = MessageSegment["type"]

/** Opaque platform-native card payload. Bus never inspects; adapters own. */
export interface PlatformCard {
  kind: string
  payload: unknown
}

/**
 * The unified A2UI segment carried across the bus.
 *
 * `surfaceId` is the A2UI surface this segment refers to — adapters use it
 * when routing inbound platform callbacks back through
 * `ConnectorBus.dispatchConnectorCallback`. `content` is the full A2UI
 * Surface payload (components tree + dataModel + rootId); adapters either
 * project it into native rich content (Slack Block Kit, Lark Interactive
 * Card, Telegram InlineKeyboard, Discord Embed + Components) via the
 * platform-specific A2UI mapper, or fall back to `plainTextMirror` when
 * the platform cannot render the surface.
 *
 * `plainTextMirror` is generated alongside the surface by the assistant
 * (or by `a2ui-bridge/a2ui-to-segments.ts` when extracting from an
 * assistant response) so degradation is always available without
 * re-rendering the surface.
 */
export interface A2UIMessageSegment {
  type: "a2ui"
  surfaceId: string
  /** Opaque A2UISurface payload (`{components, dataModel, rootId, ...}`). */
  content: A2UISegmentContent
  /** Pre-baked plain-text projection for capability-fallback. */
  plainTextMirror: string
}

/**
 * The portion of A2UISurfaceRow that the bus carries between processes.
 * Kept structurally compatible with `A2UISurfaceRow` so adapters can hand
 * the segment straight into the A2UI renderer without re-shaping.
 *
 * Bus does not inspect; a2ui-bridge and platform mappers own.
 */
export interface A2UISegmentContent {
  components: Record<string, unknown>
  dataModel: Record<string, unknown>
  rootId: string
  surfaceType?: "inline" | "dialog" | "panel" | "fullscreen"
  catalogId?: string
  widget?: Record<string, unknown>
  title?: string
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
export function isA2UISegment(s: MessageSegment): s is A2UIMessageSegment {
  return s.type === "a2ui"
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
      case "a2ui":
        // A2UI segments always carry a pre-baked text mirror so they remain
        // matchable by trigger keywords/slash-commands even on platforms
        // that cannot render the surface natively. Wrap with spaces for the
        // same separator behaviour as other rich segments.
        out.push(s.plainTextMirror ? ` ${s.plainTextMirror} ` : " [a2ui] ")
        break
    }
  }
  return out.join("")
}
