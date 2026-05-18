import type { Capability } from "@/types/connectors/capability"

/**
 * Capability flags declared by the Lark adapter.
 *
 * Kept in alphabetical order for stable diffs.
 *
 * Notes:
 *  - send.typing: Lark has no native typing indicator for bots.
 *  - rich-card.lark: Lark interactive card (im v1 cards 2.0).
 *  - history.fetch: /im/v1/messages list with cursor pagination.
 *  - send.voice / send.video / send.file / send.image: handled by
 *    `lark/upload.ts` which runs an async upload pre-pass on outbound,
 *    resolving remote URLs to Lark `file_key` / `image_key` via
 *    `connectors_lark_upload_file` / `connectors_lark_upload_image` Tauri
 *    commands. Already-resolved keys (no `://` in the URL) skip the
 *    upload.
 */
export const LARK_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "history.fetch",
  "rich-card.lark",
  "send.card",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reaction",
  "send.reply",
  "send.text",
  "send.thread",
  "send.video",
  "send.voice",
] as const
