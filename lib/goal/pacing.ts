/**
 * Continuation pacing gate for the `/goal` subsystem (ADR-0019 Phase 2).
 *
 * After the turn driver yields `{ kind: "continue" }`, the chat hook asks
 * this pure function whether — and when — to dispatch the next turn. Three
 * controls, in priority order:
 *
 *   1. `manualContinue` → HOLD: the user advances one turn via the pill.
 *   2. `quietHours`     → DEFER until the window ends (reuses the connector
 *                          outbound-runner's quiet-hours math).
 *   3. `continuationIntervalMs` → DEFER until the minimum gap elapses.
 *
 * No IO, no clock reads of its own — `nowMs` and `lastContinuationAt` are
 * passed in so the gate is deterministic and unit-testable.
 */

import type { ContinuationGate, Goal } from "@/types/goal"
import { isInQuietHours, msUntilQuietEnd } from "@/lib/connectors/outbound-runner"

/** Bounds for the model-suggested delay (adaptive pacing). */
export const MIN_SUGGESTED_DELAY_MS = 60_000
export const MAX_SUGGESTED_DELAY_MS = 3_600_000

/**
 * Decide whether the next goal continuation may dispatch now.
 *
 * @param goal                The active goal (its `config` carries the knobs).
 * @param nowMs               Current epoch ms.
 * @param lastContinuationAt  Epoch ms of the previous auto-continuation, or
 *                            `undefined` if this is the first one (interval
 *                            gating is skipped until we have a baseline).
 * @param suggestedDelayMs    Model-suggested delay parsed from the last
 *                            response (adaptive pacing). Honored only when
 *                            `config.adaptivePacing` is on, measured from the
 *                            same baseline as the interval, and combined via
 *                            **max()** — the model can only SLOW the loop,
 *                            never speed it below the configured interval.
 */
export function gateContinuation(
  goal: Goal,
  nowMs: number,
  lastContinuationAt: number | undefined,
  suggestedDelayMs?: number
): ContinuationGate {
  const cfg = goal.config

  // 1) Manual continue — hold for the user's explicit advance.
  if (cfg.manualContinue) return { kind: "hold", reason: "manual" }

  // 2) Quiet hours — defer until the window's end.
  const qh = cfg.quietHours
  if (qh?.from && qh.to && qh.tz && isInQuietHours(nowMs, qh.from, qh.to, qh.tz)) {
    const untilMs = nowMs + Math.max(0, msUntilQuietEnd(nowMs, qh.to, qh.tz))
    return { kind: "defer", untilMs, reason: "quiet_hours" }
  }

  // 3) Minimum-gap requests — the configured interval and (opt-in) the
  // model-suggested delay both measure from the last continuation; the
  // gate honors the LATER of the two. No baseline → send (suggestions take
  // effect from the second continuation, same as the interval).
  if (lastContinuationAt !== undefined) {
    const interval = cfg.continuationIntervalMs ?? 0
    const intervalUntil = interval > 0 ? lastContinuationAt + interval : null
    let suggestedUntil: number | null = null
    if (cfg.adaptivePacing && typeof suggestedDelayMs === "number" && suggestedDelayMs > 0) {
      // Defensive re-clamp — the parser already clamps, but the gate is the
      // last line of defense against an out-of-band caller.
      const clamped = Math.min(
        MAX_SUGGESTED_DELAY_MS,
        Math.max(MIN_SUGGESTED_DELAY_MS, suggestedDelayMs)
      )
      suggestedUntil = lastContinuationAt + clamped
    }
    const untilMs = Math.max(intervalUntil ?? 0, suggestedUntil ?? 0)
    if (untilMs > nowMs) {
      // Ties go to "interval" — the user-configured knob explains the wait.
      const reason =
        suggestedUntil !== null && suggestedUntil > (intervalUntil ?? 0)
          ? "model_suggested"
          : "interval"
      return { kind: "defer", untilMs, reason }
    }
  }

  return { kind: "send" }
}
