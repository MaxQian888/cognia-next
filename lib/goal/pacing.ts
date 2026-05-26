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

/**
 * Decide whether the next goal continuation may dispatch now.
 *
 * @param goal                The active goal (its `config` carries the knobs).
 * @param nowMs               Current epoch ms.
 * @param lastContinuationAt  Epoch ms of the previous auto-continuation, or
 *                            `undefined` if this is the first one (interval
 *                            gating is skipped until we have a baseline).
 */
export function gateContinuation(
  goal: Goal,
  nowMs: number,
  lastContinuationAt: number | undefined
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

  // 3) Continuation interval — defer until the minimum gap elapses.
  const interval = cfg.continuationIntervalMs ?? 0
  if (interval > 0 && lastContinuationAt !== undefined) {
    const elapsed = nowMs - lastContinuationAt
    if (elapsed < interval) {
      return { kind: "defer", untilMs: lastContinuationAt + interval, reason: "interval" }
    }
  }

  return { kind: "send" }
}
