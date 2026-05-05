import type { Capability } from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the Discord adapter.
 *
 * Kept in alphabetical order for stable diffs.
 * Note: no send.voice — Discord voice messages require multipart upload
 * which is deferred to Phase 2.
 */
export const DISCORD_CAPS: readonly Capability[] = [
  "delete",
  "edit",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reply",
  "send.text",
  "send.thread",
  "typing",
] as const
