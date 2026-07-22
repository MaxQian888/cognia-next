/**
 * Steer-queue helpers.
 *
 * A "steer" is a follow-up the user typed *while a turn was still running*.
 * The pinned Anthropic sidecar supports acknowledged streaming-input steer.
 * This module handles the REQUIRED fallback: providers/phases that cannot
 * acknowledge live acceptance preserve the message and replay it as a fresh
 * turn once the running turn settles, framed as a course correction. This
 * mirrors the CLI's `frameSteer` (`cli/src/tui/runtime/driven-turns.ts`).
 */

import type { SendContent, SendContentBlock } from "@cognia/agent-config-types"

/** A queued steer's payload shape — framing text plus any non-text content
 * blocks (attachments) that must survive the replay. Structurally matches the
 * store's `SteerEntry` without importing it (keeps lib free of a store dep). */
export interface SteerPayload {
  text: string
  blocks?: SendContentBlock[]
}

/** Prefix that marks a replayed message as a course-correction to the model. */
export const STEER_PREFIX = "By the way (steering): "

/** Wrap one steer message so the model reads it as a course-correction. */
export function frameSteer(text: string): string {
  return STEER_PREFIX + text.trim()
}

/**
 * Join queued steer entries (most-recent last) into one framed prompt. Blank
 * entries are dropped; an all-blank queue collapses to the bare prefix (callers
 * guard against draining an empty queue).
 */
export function frameSteerQueue(entries: readonly string[]): string {
  const joined = entries
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .join("\n\n")
  return frameSteer(joined)
}

/** Framing text of a send payload — the first text block (or the whole string). */
export function steerTextOf(content: SendContent): string {
  if (typeof content === "string") return content.trim()
  const block = content.find((b) => b.type === "text") as { text?: string } | undefined
  return (block?.text ?? "").trim()
}

/** Non-text content blocks of a send (images/documents) — preserved on a queued
 * steer so its attachments survive the replay. Empty for a plain-string send. */
export function steerBlocksOf(content: SendContent): SendContentBlock[] {
  if (typeof content === "string") return []
  return content.filter((b) => b.type !== "text")
}

/**
 * Build the replay payload for a queued steer. Text from every entry is joined
 * into one framed steer; the non-text blocks of all entries (attachments) are
 * aggregated ahead of that text so the replayed turn keeps them. With no
 * attachments the payload stays a plain framed string (pre-attachment behavior).
 */
export function buildSteerPayload(entries: readonly SteerPayload[]): SendContent {
  const framed = frameSteerQueue(entries.map((e) => e.text))
  const allBlocks = entries.flatMap((e) => e.blocks ?? [])
  return allBlocks.length === 0 ? framed : [...allBlocks, { type: "text", text: framed }]
}
