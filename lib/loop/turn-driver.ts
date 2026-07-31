/**
 * Turn driver for self-paced `/loop` iterations.
 *
 * Pure orchestrator mirroring `lib/goal/turn-driver.ts` — no IPC, no store
 * mutations. Given a snapshot of the just-completed iteration it:
 *
 *   1. Persists the iteration delta (iterations + tokensUsed) and appends
 *      an `iteration_completed` event.
 *   2. Evaluates exits: iteration cap, token budget, hard expiry.
 *   3. Parses the trailer (`delay-extractor.ts`):
 *      - `continue: false`  → exit `completed`.
 *      - parse failure      → fail-OPEN: bump `parseFailureCount`, continue
 *                             at the minimum delay; at `maxParseFailures`
 *                             exit `parse_failed_too_many` (`error`).
 *      - `continue: true`   → reset failure count, persist the clamped
 *                             delay + reason, return `continue`.
 *
 * The decision is returned, not enacted — the chat hook owns dispatch.
 * **generationId guard:** identical to the goal driver; every mutation
 * re-reads the row and bails `stale` when the generation rotated (user
 * pause/stop mid-iteration).
 */

import type { LoopExitReason, LoopStatus } from "@/types/loop"
import { statusForLoopExit } from "@/types/loop"
import { appendLoopEvent, getLoop, updateLoop } from "@/lib/db/loops"
import { parseLoopTrailer } from "./delay-extractor"
import { clampLoopDelay } from "./pacing"
import { renderLoopIterationMessage } from "./prompts"

export interface LoopTurnCompleteInput {
  loopId: string
  /** Latest assistant message text (carries the trailer). */
  lastResponse: string
  /** Tokens consumed by this iteration (input + output). 0 when unknown. */
  tokensDelta: number
  /** Abort signal — fired by the runtime on external status mutations. */
  signal?: AbortSignal
  /** Generation captured at iteration start (see module docstring). */
  capturedGenerationId: string
  /** Clock injection for tests. Defaults to `Date.now()`. */
  nowMs?: number
}

export type LoopTurnCompleteOutcome =
  | { kind: "no_loop" }
  | { kind: "stale"; reason: string }
  | { kind: "aborted" }
  | { kind: "exit"; exit: LoopExitReason; resultingStatus: LoopStatus; reason: string }
  | { kind: "continue"; userMessage: string; delayMs: number; reason?: string }

export async function handleLoopTurnComplete(
  input: LoopTurnCompleteInput
): Promise<LoopTurnCompleteOutcome> {
  const { loopId, lastResponse, tokensDelta, signal } = input
  const nowMs = input.nowMs ?? Date.now()

  // Step 0 — load + sanity check.
  let loop = await getLoop(loopId)
  if (!loop) return { kind: "no_loop" }
  if (loop.generationId !== input.capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated since iteration start" }
  }
  if (loop.status !== "active") {
    return { kind: "stale", reason: `loop status is ${loop.status}` }
  }
  if (signal?.aborted) return { kind: "aborted" }

  // Step 1 — persist the iteration delta + audit trail.
  const newIterations = loop.iterations + 1
  const newTokensUsed = loop.tokensUsed + Math.max(0, tokensDelta)
  await updateLoop(loopId, {
    iterations: newIterations,
    tokensUsed: newTokensUsed,
    lastIterationAt: nowMs,
  })
  await appendLoopEvent({
    loopId,
    kind: "iteration_completed",
    payload: {
      kind: "iteration_completed",
      iteration: newIterations,
      tokensDelta: Math.max(0, tokensDelta),
    },
  })

  loop = await getLoop(loopId)
  if (!loop || loop.generationId !== input.capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated after persist" }
  }

  // Step 2 — hard exits, in priority order.
  if (loop.iterations >= loop.config.maxIterations) {
    return commitLoopExit(
      loopId,
      {
        exit: "iteration_limited",
        reason: `iteration cap of ${loop.config.maxIterations} reached`,
      },
      input.capturedGenerationId
    )
  }
  if (loop.tokensUsed >= loop.config.maxTokens) {
    return commitLoopExit(
      loopId,
      { exit: "budget_limited", reason: `token budget of ${loop.config.maxTokens} reached` },
      input.capturedGenerationId
    )
  }
  if (loop.expiresAt !== undefined && nowMs >= loop.expiresAt) {
    return commitLoopExit(
      loopId,
      { exit: "expired", reason: "loop passed its 7-day expiry" },
      input.capturedGenerationId
    )
  }

  if (signal?.aborted) return { kind: "aborted" }

  // Step 3 — trailer.
  const trailer = parseLoopTrailer(lastResponse)
  if (trailer === null) {
    // Fail-OPEN: keep looping at the floor delay unless failures piled up.
    const failureCount = loop.parseFailureCount + 1
    await updateLoop(loopId, { parseFailureCount: failureCount })
    await appendLoopEvent({
      loopId,
      kind: "delay_parse_failed",
      payload: { kind: "delay_parse_failed", failureCount },
    })
    if (failureCount >= loop.config.maxParseFailures) {
      return commitLoopExit(
        loopId,
        {
          exit: "parse_failed_too_many",
          reason: `${failureCount} consecutive trailer parse failures`,
        },
        input.capturedGenerationId
      )
    }
    const delayMs = loop.config.minDelayMs
    await updateLoop(loopId, { nextDelayMs: delayMs, nextDelayReason: undefined })
    return { kind: "continue", userMessage: renderLoopIterationMessage(loop), delayMs }
  }

  if (!trailer.continue) {
    return commitLoopExit(
      loopId,
      { exit: "completed", reason: trailer.reason ?? "model declared the task complete" },
      input.capturedGenerationId
    )
  }

  const delayMs = clampLoopDelay(loop, trailer.delayMs)
  await updateLoop(loopId, {
    parseFailureCount: 0,
    nextDelayMs: delayMs,
    nextDelayReason: trailer.reason,
  })
  await appendLoopEvent({
    loopId,
    kind: "delay_decided",
    payload: { kind: "delay_decided", delayMs, reason: trailer.reason },
  })
  return {
    kind: "continue",
    userMessage: renderLoopIterationMessage(loop),
    delayMs,
    ...(trailer.reason ? { reason: trailer.reason } : {}),
  }
}

/** Apply an exit: mutate status + endedAt, log `exit_triggered`. */
async function commitLoopExit(
  loopId: string,
  decision: { exit: LoopExitReason; reason: string },
  capturedGenerationId: string
): Promise<LoopTurnCompleteOutcome> {
  const fresh = await getLoop(loopId)
  if (!fresh || fresh.generationId !== capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated before exit commit" }
  }
  const resultingStatus = statusForLoopExit(decision.exit)
  await updateLoop(loopId, { status: resultingStatus })
  await appendLoopEvent({
    loopId,
    kind: "exit_triggered",
    payload: { kind: "exit_triggered", exit: decision.exit, reason: decision.reason },
  })
  return { kind: "exit", exit: decision.exit, resultingStatus, reason: decision.reason }
}
