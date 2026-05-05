import type { Capability } from "@/types/connectors/capability"

/**
 * Phase-1 capability flags declared by the OneBot adapter.
 *
 * OneBot v11/v12 supports: send.text, send.image, send.voice, send.video,
 * send.file, send.reply, send.mention (at), send.emoji (face), delete,
 * history.fetch (get_msg_history). No native edit or typing.
 *
 * Kept in alphabetical order for stable diffs.
 *
 * NOTE: send.markdown is listed because the adapter falls back to plain text
 * when rendering markdown (capability is declared but degraded at send-time).
 */
export const ONEBOT_CAPS: readonly Capability[] = [
  "delete",
  "history.fetch",
  "send.emoji",
  "send.file",
  "send.image",
  "send.markdown",
  "send.mention",
  "send.reply",
  "send.text",
  "send.video",
  "send.voice",
] as const
