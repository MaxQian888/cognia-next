"use client"

/**
 * Shared steer-queue runtime state for the chat send hooks.
 *
 * A steer is a follow-up the user typed while a turn was still running. There
 * are two delivery lanes, and this module owns the bookkeeping for both:
 *
 *  • **live** — the Anthropic sidecar accepts a message into the running
 *    query's streaming input (`lib/claude/ipc.ts` `steerSession`). The turn is
 *    never restarted and nothing is discarded.
 *  • **queued** — every other provider/phase (and Anthropic once that query
 *    closed its input) holds the message here and replays it as a fresh,
 *    framed turn when the running turn settles. A same-session send during a
 *    live turn would otherwise make the sidecar close-and-restart it
 *    (host `restartReason`), silently dropping its context.
 *
 * `useClaudeChat` (direct sessions) and `useTeamChat` (team sessions) enforce
 * the same rule, so the module-scope pieces — the arm-set, the drain, and the
 * message-state transitions — live here and are shared by both.
 */

import { useChatStore, type ChatStatus } from "@/stores/chat"
import { buildSteerPayload, steerMetaOf, type SteerState } from "@/lib/claude/steer"
import { persistMessages } from "@/lib/db/messages"
import type { SendContent } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"

/** Sessions whose imminent settle must drain the steer queue even if the turn
 * ended via interrupt/error (set by `interruptAndSteer`). A natural clean end
 * always drains regardless of this set. */
export const steerArmed = new Set<string>()

/** Live status for a session (its slice, falling back to the active mirror). */
export function sessionStatusOf(sessionId: string): ChatStatus {
  const s = useChatStore.getState()
  return s.sessions[sessionId]?.status ?? (sessionId === s.activeSessionId ? s.status : "idle")
}

/** A session is "open" when it has a visible pane (tab / split). Its events
 * stream into the store slice; closed (background) sessions only touch Dexie. */
export function isSessionOpen(sessionId: string): boolean {
  return useChatStore.getState().openSessionIds.includes(sessionId)
}

/**
 * Rewrite the `metadata.steer` of every message the predicate selects, then
 * persist. The persist matters: a steer's delivery state is the only record
 * distinguishing "the model saw this" from "this was shown optimistically and
 * never arrived", and the turn's own `persistMessages` may already have run by
 * the time a state flips. Best-effort — a persist failure leaves the store
 * correct for this session and is re-derived as `failed` on the next load.
 */
function patchSteerMessages(
  sessionId: string,
  select: (meta: NonNullable<ReturnType<typeof steerMetaOf>>) => boolean,
  patch: { state: SteerState; reason?: string }
): void {
  const store = useChatStore.getState()
  const messages = store.sessions[sessionId]?.messages
  if (!messages || messages.length === 0) return

  let changed = false
  const next = messages.map((message) => {
    const meta = steerMetaOf(message.metadata)
    if (!meta || !select(meta) || meta.state === patch.state) return message
    changed = true
    return {
      ...message,
      metadata: {
        ...((message.metadata as Record<string, unknown> | undefined) ?? {}),
        steer: { ...meta, state: patch.state, ...(patch.reason ? { reason: patch.reason } : {}) },
      },
    } as UIMessage
  })
  if (!changed) return

  store.replaceSessionMessages(sessionId, next)
  void persistMessages(sessionId, next).catch((err) =>
    console.error("steer state persist failed", err)
  )
}

/** Move one steer message to a new delivery state (by its queue entry id). */
export function setSteerMessageState(
  sessionId: string,
  entryId: string,
  state: SteerState,
  reason?: string
): void {
  patchSteerMessages(sessionId, (meta) => meta.entryId === entryId, { state, reason })
}

/**
 * A turn settled: everything the sidecar had *accepted* into that turn's live
 * input is now genuinely part of the conversation. Promotes only `accepted` —
 * a message still `queued` was never handed over and must keep waiting.
 */
export function promoteAcceptedSteers(sessionId: string): void {
  patchSteerMessages(sessionId, (meta) => meta.state === "accepted", { state: "applied" })
}

/**
 * The run ended without draining and no settle is coming (errored / interrupted
 * / the app restarted). Anything still pending will never arrive on its own, so
 * mark it `failed` — the bubble then offers retry / discard.
 */
export function markPendingSteersFailed(sessionId: string, reason?: string): void {
  patchSteerMessages(sessionId, (meta) => meta.state === "queued" || meta.state === "accepted", {
    state: "failed",
    ...(reason ? { reason } : {}),
  })
}

/** Replace the first text part of a message, leaving every other part alone. */
function withText(message: UIMessage, text: string): UIMessage {
  let replaced = false
  const parts = message.parts.map((part) => {
    if (replaced || part.type !== "text") return part
    replaced = true
    return { ...part, text }
  })
  return { ...message, parts: replaced ? parts : [...parts, { type: "text", text }] } as UIMessage
}

/**
 * Rewrite a still-undelivered steer. The queue entry is what will actually be
 * sent and the bubble is what the user reads, so both move together or the
 * transcript starts lying about what was requested.
 */
export function editPendingSteer(sessionId: string, entryId: string, text: string): void {
  const store = useChatStore.getState()
  store.updateSteerEntry(sessionId, entryId, text)
  const messages = store.sessions[sessionId]?.messages
  if (!messages) return
  const next = messages.map((message) =>
    steerMetaOf(message.metadata)?.entryId === entryId ? withText(message, text) : message
  )
  store.replaceSessionMessages(sessionId, next)
  void persistMessages(sessionId, next).catch((err) =>
    console.error("steer edit persist failed", err)
  )
}

/**
 * Drop a still-undelivered steer entirely — queue entry and bubble. Used by the
 * bubble's remove control and by discarding a run's stuck queue.
 */
export function discardPendingSteer(sessionId: string, entryId: string): void {
  const store = useChatStore.getState()
  store.removeSteerEntry(sessionId, entryId)
  const messages = store.sessions[sessionId]?.messages
  if (!messages) return
  const next = messages.filter((message) => steerMetaOf(message.metadata)?.entryId !== entryId)
  if (next.length === messages.length) return
  store.replaceSessionMessages(sessionId, next)
  void persistMessages(sessionId, next).catch((err) =>
    console.error("steer discard persist failed", err)
  )
}

/**
 * Replay a session's queued steer messages as one fresh, framed turn. No-op
 * when the queue is empty. Called only once the turn has settled (idle/error),
 * so `send`'s busy-gate sees a non-streaming session and won't re-enqueue it.
 *
 * The payload is built by `buildSteerPayload` — texts joined into one framed
 * steer, attachments of all entries aggregated ahead of them so they survive.
 * `replay` is the hook-specific re-send (direct or team) bound to the session,
 * and MUST pass `steerDrain` so it does not append the user message a second
 * time: each entry is already on screen from its optimistic append.
 */
export function maybeDrainSteer(sessionId: string, replay: (content: SendContent) => void): void {
  steerArmed.delete(sessionId)
  // A live-accepted steer rode along inside the turn that just ended.
  promoteAcceptedSteers(sessionId)
  const queue = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
  if (queue.length === 0) return
  useChatStore.getState().clearSteerQueue(sessionId)
  // The replay turn carries these entries to the model, so they are applied as
  // of now. Flip before dispatching: `replay` is synchronous into `send`, which
  // persists the transcript, and a later flip would race that write.
  const drained = new Set(queue.map((entry) => entry.id))
  patchSteerMessages(sessionId, (meta) => drained.has(meta.entryId), { state: "applied" })
  replay(buildSteerPayload(queue))
}
