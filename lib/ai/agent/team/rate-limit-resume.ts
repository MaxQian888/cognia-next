/**
 * Rate-limit cooldown auto-resume (ADR — compaction/nudge). When a teammate
 * turn fails on a provider rate limit, `dispatchTeammate` reports it here; the
 * controller schedules a single guarded "continue" nudge for once the cooldown
 * elapses (instead of the run silently stalling on a still-alive lead). Guards
 * (hourly cap, agenda-fingerprint de-dup, busy-signal, exponential backoff) come
 * from {@link import("./nudge-guard")}.
 *
 * The controller owns no I/O itself: the actual delivery (notifier info + a
 * structured nudge message) is an injected `deliver` callback so the runtime
 * wires it to the live team, and the scheduler/clock are injected so it is fully
 * deterministic under fake timers. Disposed in the run's `finally` — a scheduled
 * resume never fires after the run ends.
 */

import { canNudge, computeNextRetryAt, type NudgeRecord } from "@/lib/ai/agent/team/nudge-guard"

/**
 * Model-facing "continue" prompt posted into the team mailbox when a cooldown
 * elapses. English constant (the runtime is non-React, like the compaction
 * snippets) — not a UI string.
 */
export const NUDGE_CONTINUE_PROMPT =
  "A provider rate limit paused your last turn and its cooldown has now passed. " +
  "Resume where you left off — re-check the task board, pick up your assigned " +
  "task or pending review, and continue without waiting for further input."

/** What the runtime needs to deliver one resume nudge. */
export interface ResumeDelivery {
  memberId: string
  fingerprint: string
  generation: number
}

/** A scheduled-but-not-yet-fired resume, kept so dispose() can cancel it. */
type Handle = { cancelled: boolean }

export interface RateLimitResumeDeps {
  now: () => number
  /** Schedule `fn` after `ms`; returns a handle the controller can cancel. */
  setTimer: (fn: () => void, ms: number) => Handle
  clearTimer: (handle: Handle) => void
  /** Deliver one resume nudge (notifier + structured message). */
  deliver: (delivery: ResumeDelivery) => void
  maxPerHour?: number
  busyWindowMs?: number
}

export interface OnRateLimitArgs {
  memberId: string
  /** Fingerprint of the member's current agenda (for de-dup). */
  fingerprint: string
  /** Provider cooldown (ms) before the resume should be attempted. */
  retryAfterMs: number
  /** Last tool-activity timestamp for the busy-signal guard. */
  lastToolActivityAt?: number
}

/** Hard ceiling on a scheduled cooldown so a bogus huge Retry-After can't pin a timer. */
const MAX_COOLDOWN_MS = 60 * 60_000

export class RateLimitResumeController {
  private readonly ledger = new Map<string, NudgeRecord[]>()
  private readonly timers = new Set<Handle>()
  private disposed = false

  constructor(private readonly deps: RateLimitResumeDeps) {}

  /** Records for one member (creating the slot on demand). */
  private records(memberId: string): NudgeRecord[] {
    return this.ledger.get(memberId) ?? []
  }

  private allRecords(): NudgeRecord[] {
    return [...this.ledger.values()].flat()
  }

  /**
   * Schedule a guarded resume for a member that just hit a rate limit. No-op if
   * disposed or if the member already has a pending (uncancelled) resume for the
   * same agenda fingerprint.
   */
  onRateLimit(args: OnRateLimitArgs): void {
    if (this.disposed) return
    const { memberId, fingerprint, retryAfterMs, lastToolActivityAt } = args
    const generation =
      this.records(memberId).filter((r) => r.type === "rate_limit_resume").length + 1
    const delay = Math.min(Math.max(0, retryAfterMs), MAX_COOLDOWN_MS)

    const handle = this.deps.setTimer(() => {
      this.timers.delete(handle)
      if (this.disposed) return
      const now = this.deps.now()
      const decision = canNudge({
        memberId,
        type: "rate_limit_resume",
        fingerprint,
        now,
        history: this.allRecords(),
        maxPerHour: this.deps.maxPerHour,
        lastToolActivityAt,
        busyWindowMs: this.deps.busyWindowMs,
      })
      if (!decision.allow) return // suppressed (dup / rate-limited / busy)

      const record: NudgeRecord = {
        memberId,
        type: "rate_limit_resume",
        fingerprint,
        generation,
        sentAt: now,
        nextRetryAt: computeNextRetryAt(generation, now, memberId),
      }
      this.ledger.set(memberId, [...this.records(memberId), record])
      this.deps.deliver({ memberId, fingerprint, generation })
    }, delay)

    this.timers.add(handle)
  }

  /** Test/diagnostic visibility into delivered records for a member. */
  deliveredCount(memberId: string): number {
    return this.records(memberId).length
  }

  /** Cancel every pending timer. Idempotent. Called in the run's `finally`. */
  dispose(): void {
    this.disposed = true
    for (const handle of this.timers) this.deps.clearTimer(handle)
    this.timers.clear()
  }
}

/** Default deps backed by real timers + wall clock (production wiring). */
export function createRealResumeDeps(
  deliver: (delivery: ResumeDelivery) => void,
  opts: { maxPerHour?: number; busyWindowMs?: number } = {}
): RateLimitResumeDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const handle: Handle = { cancelled: false }
      const id = setTimeout(() => {
        if (!handle.cancelled) fn()
      }, ms)
      // Store the native id on the handle for clearTimer.
      ;(handle as Handle & { id: ReturnType<typeof setTimeout> }).id = id
      return handle
    },
    clearTimer: (handle) => {
      handle.cancelled = true
      const id = (handle as Handle & { id?: ReturnType<typeof setTimeout> }).id
      if (id) clearTimeout(id)
    },
    deliver,
    maxPerHour: opts.maxPerHour,
    busyWindowMs: opts.busyWindowMs,
  }
}
