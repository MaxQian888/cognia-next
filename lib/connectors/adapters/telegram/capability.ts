import type { Capability } from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the Telegram adapter.
 *
 * Kept in alphabetical order for stable diffs.
 */
export const TELEGRAM_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "history.fetch",
  "rich-markdown.telegram",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reply",
  "send.text",
  "send.thread",
  "send.video",
  "send.voice",
  "typing",
] as const
