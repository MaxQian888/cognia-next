"use client"

/**
 * Shared steer-queue runtime state for the chat send hooks.
 *
 * Both `useClaudeChat` (direct sessions) and `useTeamChat` (team sessions)
 * enforce the same "steer instead of restart" rule: a fresh user message
 * while the session is still streaming is queued and replayed once the turn
 * settles (the sidecar cannot inject mid-turn — a same-session send would
 * silently restart the live turn). The module-scope pieces of that mechanism
 * live here so the two hooks share one arm-set and one drain implementation.
 */

import { useChatStore, type ChatStatus } from "@/stores/chat"
import { buildSteerPayload } from "@/lib/claude/steer"
import type { SendContent } from "@/lib/claude/types"

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
 * Replay a session's queued steer messages as one fresh, framed turn. No-op
 * when the queue is empty. Called only once the turn has settled (idle/error),
 * so `send`'s busy-gate sees a non-streaming session and won't re-enqueue it.
 *
 * The payload is built by `buildSteerPayload` — texts joined into one framed
 * steer, attachments of all entries aggregated ahead of it so they survive.
 * `replay` is the hook-specific re-send (direct or team) bound to the session.
 */
export function maybeDrainSteer(sessionId: string, replay: (content: SendContent) => void): void {
  steerArmed.delete(sessionId)
  const queue = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
  if (queue.length === 0) return
  useChatStore.getState().clearSteerQueue(sessionId)
  replay(buildSteerPayload(queue))
}
