import type { Capability } from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the Slack adapter.
 *
 * Kept in alphabetical order for stable diffs.
 *
 * Notes:
 *  - send.typing: no native typing on bot APIs in Phase 1
 *    (assistant.threads.setStatus requires the assistants beta)
 *  - rich-card.slack: Block Kit opaque payload passthrough
 *  - rich-markdown.slack: Slack mrkdwn dialect
 */
export const SLACK_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "history.fetch",
  "rich-card.slack",
  "rich-markdown.slack",
  "send.card",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reaction",
  "send.reply",
  "send.text",
  "send.thread",
] as const
