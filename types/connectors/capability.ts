import type { SegmentType } from "./segment"

export const ALL_CAPABILITIES = [
  // send.*
  "send.text",
  "send.markdown",
  "send.html",
  "send.image",
  "send.voice",
  "send.video",
  "send.file",
  "send.card",
  "send.poll",
  "send.location",
  "send.reply",
  "send.mention",
  "send.thread",
  "send.reaction",
  // mutations
  "edit",
  "delete",
  "typing",
  "history.fetch",
  // platform-specific rich content (escape hatches)
  "rich-markdown.telegram",
  "rich-markdown.slack",
  "rich-card.lark",
  "rich-card.slack",
] as const

export type Capability = (typeof ALL_CAPABILITIES)[number]

export function hasCapability(flags: readonly Capability[], cap: Capability): boolean {
  return flags.includes(cap)
}

/**
 * Default per-segment-type degradation order. Each adapter MAY override via
 * its own degrade table; this is the conservative default. The bus walks
 * the chain from index 0 onward, picking the first segment type whose
 * `send.<type>` capability the adapter declares.
 */
export function defaultDegradeChain(from: SegmentType): SegmentType[] {
  switch (from) {
    case "card":
      return ["card", "markdown", "text"]
    case "markdown":
      return ["markdown", "text"]
    case "image":
    case "video":
    case "voice":
    case "file":
      return [from, "text"]
    case "emoji":
    case "mention":
    case "reply":
    case "location":
    case "poll":
    case "code":
      return [from, "text"]
    case "text":
    default:
      return ["text"]
  }
}
