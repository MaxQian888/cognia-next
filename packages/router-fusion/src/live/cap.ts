/**
 * Money for the live smoke (ADR-0188 D20): a hard total of $5 across every
 * case, in integer microusd like the rest of the ledger.
 *
 * The total is not a promise the harness makes to itself. Each case's run is
 * created by the ledger against a tenant limit of "the total minus what this
 * smoke's own ledger has already booked", so a run that does not fit is
 * refused by `planRunCreation` before a byte is sent. The harness checks that
 * the refusal really happens (`ledgerRefusedOverCap`) before it runs anything,
 * and refuses to start otherwise.
 *
 * The per-case caps only have to add up to no more than the total, so every
 * case is guaranteed its hold; each is also lowered to the account's own run
 * cap for its mode, because a request may lower a cap and never raise it
 * (D22).
 */

import type { ExecutionMode } from "../contracts/schemas"
import { addMicrousd, microusdToUsd, usdToMicrousd, type Microusd } from "../money/microusd"
import type { LiveSmokeCase } from "./cases"

/** D20: the live smoke may never spend more than this, in total. */
export const LIVE_SMOKE_HARD_CAP_USD = "5.00"
export const LIVE_SMOKE_HARD_CAP_MICROUSD: Microusd = usdToMicrousd(LIVE_SMOKE_HARD_CAP_USD)

/**
 * Every case runs under a strict budget (D6): a deployment without an audited
 * price, or whose bill is only an estimate (a subscription lane), is excluded
 * by the router instead of being reserved with a placeholder. What the ledger
 * reserves is then a bound on what the call can cost.
 */
export const LIVE_SMOKE_BUDGET_MODE = "strict" as const

export interface PlannedCase {
  definition: LiveSmokeCase
  /** The case's own cap. */
  requestedCapMicrousd: Microusd
  /** The account's run cap for the case's mode. */
  modeRunCapMicrousd: Microusd
  /** The cap the case's run is created with: the lower of the two. */
  capMicrousd: Microusd
}

export interface LiveCapPlan {
  totalCapMicrousd: Microusd
  cases: PlannedCase[]
  /** Σ case caps. */
  plannedMicrousd: Microusd
}

export type LiveCapErrorCode =
  | "TOTAL_CAP_INVALID"
  | "TOTAL_CAP_ABOVE_HARD_LIMIT"
  | "CASE_CAP_INVALID"
  | "CASE_CAPS_EXCEED_TOTAL"
  | "CAP_NOT_ENFORCED_BY_LEDGER"

export class LiveCapError extends Error {
  readonly code: LiveCapErrorCode

  constructor(code: LiveCapErrorCode, message: string) {
    super(message)
    this.name = "LiveCapError"
    this.code = code
  }
}

function isMicrousd(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** Each case's cap, lowered to the account's run cap for its mode. */
export function planLiveSmokeCaps(
  cases: readonly LiveSmokeCase[],
  runCapUsdByMode: Readonly<Record<ExecutionMode, string>>,
  totalCapMicrousd: Microusd = LIVE_SMOKE_HARD_CAP_MICROUSD
): LiveCapPlan {
  const planned = cases.map((definition): PlannedCase => {
    const requestedCapMicrousd = usdToMicrousd(definition.capUsd)
    const modeRunCapMicrousd = usdToMicrousd(runCapUsdByMode[definition.mode])
    return {
      definition,
      requestedCapMicrousd,
      modeRunCapMicrousd,
      capMicrousd: Math.min(requestedCapMicrousd, modeRunCapMicrousd),
    }
  })
  return {
    totalCapMicrousd,
    cases: planned,
    plannedMicrousd: addMicrousd(...planned.map((entry) => entry.capMicrousd)),
  }
}

/**
 * Refuse a plan whose total is missing, above the $5 hard limit, or smaller
 * than the case caps it has to hold. Nothing may run on a plan that fails.
 */
export function assertLiveCapInPlace(plan: LiveCapPlan): void {
  if (!isMicrousd(plan.totalCapMicrousd) || plan.totalCapMicrousd === 0) {
    throw new LiveCapError(
      "TOTAL_CAP_INVALID",
      `the total cap must be a positive whole number of microusd, got ${plan.totalCapMicrousd}`
    )
  }
  if (plan.totalCapMicrousd > LIVE_SMOKE_HARD_CAP_MICROUSD) {
    throw new LiveCapError(
      "TOTAL_CAP_ABOVE_HARD_LIMIT",
      `the total cap ${formatUsd(plan.totalCapMicrousd)} is above the hard limit ${formatUsd(LIVE_SMOKE_HARD_CAP_MICROUSD)}`
    )
  }
  for (const entry of plan.cases) {
    if (!isMicrousd(entry.capMicrousd) || entry.capMicrousd === 0) {
      throw new LiveCapError(
        "CASE_CAP_INVALID",
        `case ${entry.definition.id} has no usable cap (${entry.capMicrousd} microusd)`
      )
    }
  }
  if (plan.plannedMicrousd > plan.totalCapMicrousd) {
    throw new LiveCapError(
      "CASE_CAPS_EXCEED_TOTAL",
      `the case caps add up to ${formatUsd(plan.plannedMicrousd)}, more than the total cap ${formatUsd(plan.totalCapMicrousd)}`
    )
  }
}

/** What the total still allows after `spentMicrousd` was booked; never below zero. */
export function remainingTotalMicrousd(
  totalCapMicrousd: Microusd,
  spentMicrousd: Microusd
): Microusd {
  return totalCapMicrousd > spentMicrousd ? totalCapMicrousd - spentMicrousd : 0
}

/**
 * The ledger's answer to a run whose cap is one microusd more than the total
 * still allows. Only a refusal for the tenant budget proves the total is
 * enforced by the ledger; anything else (a created run, another code) means
 * the cap is not in place.
 */
export function ledgerRefusedOverCap(outcome: { ok: boolean; code?: string }): boolean {
  return outcome.ok === false && outcome.code === "TENANT_BUDGET_EXHAUSTED"
}

/** `$0.400000`: microusd as the contract's decimal, with a dollar sign. */
export function formatUsd(microusd: Microusd): string {
  return `$${microusdToUsd(microusd)}`
}
