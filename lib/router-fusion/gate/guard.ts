/**
 * The two failure policies of ADR-0188 D38, as wrappers around a fusion step.
 *
 * `runOrdinaryWithFallback` — ordinary traffic (direct chat, direct Agent and
 * workflow calls, utilities, gateway passthrough). The fusion step covers only
 * work that happens BEFORE anything reaches a provider (routing, run creation,
 * reservations). If it hits an infrastructure fault, the original path runs
 * instead, the user is told the work was not ledgered, and the breaker counts
 * the fault. A refusal is rethrown untouched: it is an answer, not a fault.
 *
 * `runExplicitFusion` — work the user or caller explicitly asked Router + Fusion
 * for (cascade/panel/delegate, the Run API, `cognia/*` models). A fault is
 * counted and surfaced as `RouterFusionUnavailableError`. It is never replaced
 * by an ordinary answer.
 *
 * Wiring: `runOrdinaryWithFallback` runs every direct chat send and reroute
 * (`chat-send.ts`, B1). `runExplicitFusion` runs a chat cascade or panel turn
 * (`chat-fusion-run.ts`, B3), and `trippedSurfaceError` refuses one — and the
 * Run API calls behind it — while the surface is paused (`build-options.ts`,
 * `run-api-bridge.ts`). The contract is pinned by `guard.test.ts`
 * ([ACC:ISO-03]).
 */

import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import { recordFusionFault, recordFusionSuccess } from "./breaker"
import {
  RouterFusionInfrastructureError,
  RouterFusionUnavailableError,
  toInfrastructureFault,
} from "./faults"

export interface BypassNotice {
  surface: RouterFusionSurface
  fault: RouterFusionInfrastructureError
  /** True when this fault opened the surface breaker. */
  justTripped: boolean
  consecutiveFaults: number
}

export interface OrdinaryGuardInput<T> {
  surface: RouterFusionSurface
  threshold: number
  fusion: () => Promise<T>
  original: () => Promise<T>
  onBypass: (notice: BypassNotice) => void
  now?: () => number
}

export async function runOrdinaryWithFallback<T>(input: OrdinaryGuardInput<T>): Promise<T> {
  let result: T
  try {
    result = await input.fusion()
  } catch (error) {
    const fault = toInfrastructureFault(error)
    if (!fault) throw error
    const record = recordFusionFault(
      input.surface,
      fault.code,
      input.threshold,
      input.now?.() ?? Date.now()
    )
    try {
      input.onBypass({
        surface: input.surface,
        fault,
        justTripped: record.justTripped,
        consecutiveFaults: record.consecutiveFaults,
      })
    } catch (noticeError) {
      console.error("[router-fusion] bypass notice failed", noticeError)
    }
    return input.original()
  }
  recordFusionSuccess(input.surface)
  return result
}

export interface ExplicitGuardInput<T> {
  surface: RouterFusionSurface
  threshold: number
  fusion: () => Promise<T>
  now?: () => number
}

export async function runExplicitFusion<T>(input: ExplicitGuardInput<T>): Promise<T> {
  try {
    const result = await input.fusion()
    recordFusionSuccess(input.surface)
    return result
  } catch (error) {
    const fault = toInfrastructureFault(error)
    if (!fault) throw error
    recordFusionFault(input.surface, fault.code, input.threshold, input.now?.() ?? Date.now())
    throw new RouterFusionUnavailableError(fault)
  }
}

/** Explicit work on a tripped surface: report it, do not run it. */
export function trippedSurfaceError(surface: RouterFusionSurface): RouterFusionUnavailableError {
  return new RouterFusionUnavailableError(
    new RouterFusionInfrastructureError(
      "breaker_tripped",
      `Router + Fusion for ${surface} is paused after repeated failures; re-arm it in Settings.`
    )
  )
}
