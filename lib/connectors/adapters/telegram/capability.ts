import type { Capability } from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the Telegram adapter.
 *
 * Kept in alphabetical order for stable diffs.
 */
/**
 * Note on `history.fetch`: Telegram's Bot API does not expose any endpoint
 * for fetching arbitrary message history from a chat. `getUpdates` only
 * returns pending updates, and `getChat`/`getChatHistory` are not available
 * to bots. Declaring `history.fetch` would be dishonest, so it is omitted.
 */
export const TELEGRAM_CAPS: readonly Capability[] = [
  "delete",
  "edit",
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
