/**
 * Slack Block Kit serialiser.
 *
 * Converts MessageSegments to a blocks[] array per
 * https://api.slack.com/block-kit
 *
 * Slack mrkdwn format notes:
 *  - *bold* and _italic_ work as-is (same as Slack mrkdwn)
 *  - Escape only <, >, & characters that would confuse Slack's own parser
 *  - <@userId> is the canonical mention format
 */

import type { MessageSegment } from "@/types/connectors/segment"

// ---------------------------------------------------------------------------
// Block Kit types (minimal subset)
// ---------------------------------------------------------------------------

export interface MrkdwnTextObject {
  type: "mrkdwn"
  text: string
  verbatim?: boolean
}

export interface PlainTextObject {
  type: "plain_text"
  text: string
  emoji?: boolean
}

export interface SectionBlock {
  type: "section"
  text: MrkdwnTextObject | PlainTextObject
}

export interface ImageBlock {
  type: "image"
  image_url: string
  alt_text: string
}

export type SlackBlock = SectionBlock | ImageBlock

// ---------------------------------------------------------------------------
// Escape helper
// ---------------------------------------------------------------------------

/**
 * Escape characters that Slack's mrkdwn parser treats specially.
 * Only <, >, & need escaping — * _ ` ~ work as formatting and pass through.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ---------------------------------------------------------------------------
// Segment → blocks
// ---------------------------------------------------------------------------

function sectionBlock(mrkdwn: string): SectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: mrkdwn },
  }
}

/**
 * Convert a single MessageSegment to one Slack Block Kit block.
 * Returns null for segment types that cannot be represented.
 */
export function segmentToBlock(seg: MessageSegment): SlackBlock | null {
  switch (seg.type) {
    case "text":
      return sectionBlock(escapeSlackMrkdwn(seg.text))

    case "markdown":
      // Slack mrkdwn is close to GitHub Markdown; pass through with < > & escaping
      return sectionBlock(escapeSlackMrkdwn(seg.md))

    case "image":
      return {
        type: "image",
        image_url: seg.url,
        alt_text: seg.alt ?? "image",
      }

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      return sectionBlock(block)
    }

    case "mention":
      return sectionBlock(`<@${seg.userId}>`)

    case "card":
      // Phase 1: opaque card → inline placeholder text
      return sectionBlock("[card]")

    case "file":
      // Phase 1: link in text
      return sectionBlock(`<${seg.url}|${escapeSlackMrkdwn(seg.name)}>`)

    case "reply":
    case "emoji":
    case "video":
    case "voice":
    case "location":
    case "poll":
      // Unsupported in Phase 1 — drop
      return null

    default:
      return null
  }
}

/**
 * Convert a MessageSegment[] to a Slack blocks[] array.
 * Unsupported segment types are silently dropped.
 */
export function segmentsToBlocks(segments: MessageSegment[]): SlackBlock[] {
  const blocks: SlackBlock[] = []
  for (const seg of segments) {
    const block = segmentToBlock(seg)
    if (block !== null) {
      blocks.push(block)
    }
  }
  return blocks
}
