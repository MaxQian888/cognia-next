/**
 * Turns whose usage row a headless caller books itself.
 *
 * A headless capture (`runAndCaptureAssistantReply`) shares the sidecar event
 * stream with the desktop chat runtime, which ingests every session's
 * transcript and books a `chat` row for each `result` it sees
 * (`hooks/chat/claude-chat-events.ts`). For a headless turn that row knows
 * neither the provider (only an interactive send records it) nor the run the
 * turn belonged to, so it never reaches the provider rollup or the cost-budget
 * gate. On the always-on host the chat runtime is not mounted at all and the
 * turn books nothing.
 *
 * A caller that does know the attribution (a Bot turn, a best-of-N candidate)
 * claims the turn here before sending and records its own row through
 * `recordSurfaceUsage`. The chat runtime skips its write for a claimed turn, so
 * the spend is counted exactly once on either host.
 *
 * Keyed by session AND turn id: the same session can later carry an
 * interactive turn, which the chat runtime must still book. Claims are not
 * released when the capture settles, because the chat runtime drains its
 * per-session queue after the capture has already resolved; the set is bounded
 * instead, oldest claim first out.
 */

import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { UsageInfo } from "@/lib/claude/adapter"

/** Far more turns than can be in flight or queued at once. */
export const MAX_CLAIMED_TURNS = 1024

const claims = new Set<string>()

const claimKey = (sessionId: string, turnId: string) => `${sessionId}\u0000${turnId}`

/** Claim one turn's usage for the caller. Call before the prompt is sent. */
export function claimTurnUsage(sessionId: string, turnId: string): void {
  if (!sessionId || !turnId) return
  const key = claimKey(sessionId, turnId)
  claims.delete(key)
  claims.add(key)
  while (claims.size > MAX_CLAIMED_TURNS) {
    const oldest = claims.values().next().value
    if (oldest === undefined) break
    claims.delete(oldest)
  }
}

/** True when a headless caller books this turn's usage itself. */
export function isTurnUsageClaimed(sessionId: string, turnId: string | undefined): boolean {
  if (!sessionId || !turnId) return false
  return claims.has(claimKey(sessionId, turnId))
}

export function __resetClaimedTurnUsageForTesting(): void {
  claims.clear()
}

/**
 * Remembers the authoritative end-of-turn usage a capture streamed.
 *
 * `RunAndCaptureResult.usage` is absent when the native sidecar ends a turn
 * without a `result` payload, and a capture that rejects (abort, timeout,
 * error result) returns no result at all, although the model calls it made
 * were billed. The streamed non-partial `usage` event is the same figure the
 * chat runtime would have booked, so a caller that claimed the turn falls back
 * to it. Mid-run partial snapshots are ignored, as the chat runtime ignores
 * them.
 */
export function trackCaptureUsage(): {
  observe(event: CaptureStreamEvent): void
  /** The resolved usage when there is one, else the last streamed figure. */
  resolve(resultUsage?: UsageInfo): UsageInfo | undefined
} {
  let streamed: UsageInfo | undefined
  return {
    observe(event) {
      if (event.type === "usage" && !event.partial) streamed = event.usage
    },
    resolve(resultUsage) {
      return resultUsage ?? streamed
    },
  }
}
