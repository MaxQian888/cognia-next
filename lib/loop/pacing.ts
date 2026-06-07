/**
 * Continuation pacing for self-paced `/loop` iterations.
 *
 * Unlike the goal gate (manual / quiet-hours / interval), a self-paced loop
 * is ALWAYS delay-driven: the next iteration fires `delay` ms after the
 * last one completed, where `delay` is the model's clamped suggestion (or
 * the configured floor when no suggestion landed). Pure function — clock
 * injected, no IO.
 */

import type { Loop } from "@/types/loop"

export type LoopGate = { kind: "send" } | { kind: "defer"; untilMs: number }

/** Clamp a model-suggested delay into the loop's configured bounds. */
export function clampLoopDelay(loop: Loop, delayMs: number | undefined): number {
  const { minDelayMs, maxDelayMs } = loop.config
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs)) return minDelayMs
  return Math.min(maxDelayMs, Math.max(minDelayMs, delayMs))
}

/**
 * Decide whether the next iteration may dispatch now. The baseline is
 * `lastIterationAt`; a loop that has never iterated (or lost its baseline)
 * sends immediately.
 */
export function gateLoopContinuation(loop: Loop, nowMs: number): LoopGate {
  const baseline = loop.lastIterationAt
  if (baseline === undefined) return { kind: "send" }
  const untilMs = baseline + clampLoopDelay(loop, loop.nextDelayMs)
  if (untilMs > nowMs) return { kind: "defer", untilMs }
  return { kind: "send" }
}
