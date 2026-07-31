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
 * Drop the model-facing framing from a steer payload for display. The prefix
 * exists so the *model* reads a follow-up as a course-correction; showing it
 * back to the user means their own transcript reads "By the way (steering):
 * …" in English regardless of locale. Rendering goes through here; the model
 * still receives the framed text.
 */
export function stripSteerPrefix(text: string): string {
  return text.startsWith(STEER_PREFIX) ? text.slice(STEER_PREFIX.length) : text
}

/**
 * Delivery state of a steer, as shown on its transcript bubble.
 *
 *  • `queued`   — held renderer-side; the model has not seen it. Either the
 *                 provider has no live-input lane, or this session's query had
 *                 already closed its input (see `scheduleSteerInputClose`).
 *  • `accepted` — the sidecar took it into the live streaming input. NOT the
 *                 same as "the model acted on it": the Agent SDK applies the
 *                 message at its next supported boundary and cannot mutate an
 *                 HTTP request already in flight (see `ipc.steerSession`).
 *  • `applied`  — the turn carrying it has settled, so it is now part of the
 *                 conversation the model reasons over.
 *  • `failed`   — never delivered and never will be by itself (the run ended
 *                 without draining, or the app restarted). Offers retry/discard.
 */
export type SteerState = "queued" | "accepted" | "applied" | "failed"

/**
 * `metadata.steer` on a user message that entered as a steer. Persisted with
 * the message, so a restart can tell a delivered follow-up from one that was
 * optimistically shown and never reached the model.
 */
export interface SteerMessageMeta {
  /** Matches the `SteerEntry.id` in the store's queue while still pending. */
  entryId: string
  state: SteerState
  /** Why delivery failed / fell back — surfaced in the bubble's tooltip. */
  reason?: string
}

/**
 * The state a steer bubble should actually render, reconciling its persisted
 * `metadata.steer.state` against live session facts.
 *
 * This is a derivation rather than a load-time rewrite because the queue itself
 * is memory-only: after a restart every pending entry is gone, so a message
 * persisted as `queued` would otherwise sit on "waiting" forever with nothing
 * left to deliver it. Deriving keeps that self-correcting and keeps the reload
 * path free of a mutation pass.
 *
 *  • `applied` / `failed` are terminal and pass through.
 *  • `accepted` while idle means the turn it rode in has ended (including via a
 *    restart) — the sidecar had taken it, so the model saw it.
 *  • `queued` only survives while the session is still busy AND the entry is
 *    still in the live queue; anything else means no settle is coming.
 */
export function resolveSteerDisplayState(
  meta: SteerMessageMeta,
  ctx: { sessionBusy: boolean; stillQueued: boolean }
): SteerState {
  if (meta.state === "applied" || meta.state === "failed") return meta.state
  if (meta.state === "accepted") return ctx.sessionBusy ? "accepted" : "applied"
  return ctx.sessionBusy && ctx.stillQueued ? "queued" : "failed"
}

/** Read `metadata.steer` off a message's metadata bag, if it carries one. */
export function steerMetaOf(metadata: unknown): SteerMessageMeta | null {
  if (!metadata || typeof metadata !== "object") return null
  const steer = (metadata as { steer?: unknown }).steer
  if (!steer || typeof steer !== "object") return null
  const { entryId, state } = steer as Partial<SteerMessageMeta>
  if (typeof entryId !== "string" || typeof state !== "string") return null
  return steer as SteerMessageMeta
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
