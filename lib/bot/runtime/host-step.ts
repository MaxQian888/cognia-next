/**
 * The step machinery, addressable by `runId` for out-of-process handlers.
 *
 * An in-process handler receives `ctx.step` bound to the run's own
 * `AbortSignal`. A Python handler only has the run id it was handed in the
 * snapshot, so `ctx.bots.*` host calls rebuild an equivalent step API from the
 * run's LIVE signal — the same one `runBotDelivery` aborts on cancellation,
 * which is the only place a cross-process handler could safely notice
 * cancellation anyway.
 *
 * ## Park intent
 *
 * `BotRunParkedError` cannot cross stdio intact — `wrapFailure` preserves only
 * `message` and `stack`. So when a `ctx.bots.waitForApproval` /
 * `ctx.bots.waitForEvent` host call parks, the host records the error here by
 * `runId`, and the bridge's synthesized handler rethrows it once
 * `proxy.run` settles. `runBotDelivery` clears the entry in its `finally`, so
 * a crashed Python process cannot leak a stale park into a later run.
 */

import type { BotStepApiV1 } from "@/types/bot/run"

import { getLiveBotRunSignal } from "./run"
import { BotRunParkedError, createBotStepApi, type BotStepDeps } from "./step"

/** Parked waits recorded by host calls, keyed by run id. Prefer the functions below. */
export const pendingParks = new Map<string, BotRunParkedError>()

export function recordPendingPark(error: BotRunParkedError): void {
  pendingParks.set(error.runId, error)
}

export function takePendingPark(runId: string): BotRunParkedError | undefined {
  const error = pendingParks.get(runId)
  pendingParks.delete(runId)
  return error
}

export function clearPendingPark(runId: string): void {
  pendingParks.delete(runId)
}

/**
 * The run's live signal, or a refusal.
 *
 * A run that is not executing on this host — settled, or mirrored from a
 * companion — cannot be stepped from here. That is the fence ADR-0174 already
 * sets: mirrored state is read-only.
 */
export function requireLiveBotRunSignal(runId: string): AbortSignal {
  const signal = getLiveBotRunSignal(runId)
  if (!signal) throw new Error("Bot run is not executing on this host")
  return signal
}

/**
 * Build the step API for one run over its live signal.
 *
 * Waits always run in `park` mode: a cross-process handler has no runner pass
 * to hold open, and park-instead-of-block is what lets the queue serve other
 * Bots while this one waits.
 */
export function createHostStepApi(input: {
  runId: string
  projectId?: string
  deps?: BotStepDeps
}): BotStepApiV1 {
  return createBotStepApi({
    runId: input.runId,
    signal: requireLiveBotRunSignal(input.runId),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    deps: { ...input.deps, waitMode: "park" },
  })
}
