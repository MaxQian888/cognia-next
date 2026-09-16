/**
 * Cost and latency estimates per action (DESIGN §6.4).
 *
 * Two different numbers:
 *  - `reserve`: what must be held before the action may START. Conservative on
 *    purpose — cold cache, the highest cache-write tier on every input token,
 *    the full reserved output, escalation assumed to happen. A cache hit is
 *    never assumed.
 *  - `expected`: a planning estimate used only to compare candidates.
 *
 * An unpriced deployment contributes a configured conservative per-call
 * placeholder to the reserve (tracked budgets only; strict budgets have already
 * excluded it) and marks the estimate `priceKnown: false`.
 */

import type { ExecutionMode, RateCard } from "../contracts/schemas"
import type { ActionExtension, FusionDeployment, RoleName } from "../config/types"
import { compareDecimal, costForQuantity, type Microusd } from "../money/microusd"

export interface RoleCallEstimate {
  role: RoleName
  deployment: FusionDeployment
  calls: number
  inputTokens: number
  outputTokens: number
  /** Part of the tail that must be reserved as a stage before fan-out starts. */
  stage: boolean
}

export interface ActionEstimate {
  reserveMicrousd: Microusd
  expectedMicrousd: Microusd
  p95Ms: number
  priceKnown: boolean
  /** Money to hold as a stage before the first parallel call (panel Judge+Synthesis+verify). */
  stageReserveMicrousd: Microusd
  modelCalls: number
}

export interface EstimateContext {
  rateCardsById: Record<string, RateCard>
  unknownPriceCallReserveMicrousd: Microusd
  /** Output tokens expected (not reserved) per call. */
  expectedOutputTokens: number
}

function maxRate(card: RateCard): string {
  const rates = [
    card.ordinary_input_per_million,
    card.cache_write_5m_per_million,
    card.cache_write_1h_per_million,
  ]
  return rates.reduce((best, rate) => (compareDecimal(rate, best) > 0 ? rate : best))
}

export function reserveForCall(
  call: Pick<RoleCallEstimate, "deployment" | "inputTokens" | "outputTokens">,
  context: EstimateContext
): { microusd: Microusd; priceKnown: boolean } {
  const card = call.deployment.rateCardId
    ? context.rateCardsById[call.deployment.rateCardId]
    : undefined
  if (!card) return { microusd: context.unknownPriceCallReserveMicrousd, priceKnown: false }
  const output = Math.min(call.outputTokens, call.deployment.maxOutputTokens)
  return {
    microusd:
      costForQuantity(call.inputTokens, maxRate(card)) +
      costForQuantity(output, card.output_per_million),
    priceKnown: true,
  }
}

export function expectedForCall(
  call: Pick<RoleCallEstimate, "deployment" | "inputTokens" | "outputTokens">,
  context: EstimateContext
): Microusd | null {
  const card = call.deployment.rateCardId
    ? context.rateCardsById[call.deployment.rateCardId]
    : undefined
  if (!card) return null
  const output = Math.min(
    context.expectedOutputTokens,
    call.outputTokens,
    call.deployment.maxOutputTokens
  )
  return (
    costForQuantity(call.inputTokens, card.ordinary_input_per_million) +
    costForQuantity(output, card.output_per_million)
  )
}

export interface ActionShapeInput {
  mode: ExecutionMode
  extension: ActionExtension
  /** Resolved deployment per role (only roles the action declares). */
  roles: Partial<Record<RoleName, FusionDeployment>>
  taskInputTokens: number
  /** The action verifies with a model review call (direct once; cascade once per stage). */
  reviewCall: boolean
  webToolsEnabled: boolean
}

/**
 * The calls an action is allowed to make, derived from its mode and limits —
 * the same bounds the workflow enforces, so the reserve matches the worst case.
 */
export function plannedCalls(input: ActionShapeInput): RoleCallEstimate[] {
  const { roles, extension, taskInputTokens } = input
  const out = extension.role_output_tokens
  const calls: RoleCallEstimate[] = []
  const add = (role: RoleName, count: number, inputTokens: number, stage = false) => {
    const deployment = roles[role]
    if (deployment && count > 0)
      calls.push({ role, deployment, calls: count, inputTokens, outputTokens: out, stage })
  }
  switch (input.mode) {
    case "direct":
      add("solver", 1, taskInputTokens)
      if (input.reviewCall) add(roles.reviewer ? "reviewer" : "solver", 1, taskInputTokens + out)
      return calls
    case "cascade":
      add("cheap", 1, taskInputTokens)
      add("strong", 1, taskInputTokens + Math.ceil(out / 4))
      // A reviewed cascade checks each stage's draft: the reviewer role, or the
      // strong deployment when the action names none.
      if (input.reviewCall) add(roles.reviewer ? "reviewer" : "strong", 2, taskInputTokens + out)
      return calls
    case "panel": {
      const members: RoleName[] = ["panel_a", "panel_b", "panel_c"].slice(
        0,
        extension.limits.panel_size
      ) as RoleName[]
      const memberCalls = input.webToolsEnabled ? 2 : 1
      for (const member of members) add(member, memberCalls, taskInputTokens)
      const judgeInput = taskInputTokens + out * members.length
      const judgeCalls = 1 + extension.limits.panel_evidence_rounds
      add("judge", judgeCalls, judgeInput, true)
      add("synthesizer", 1, judgeInput + out, true)
      // Final verification of the synthesis by the judge deployment.
      add("judge", 1, taskInputTokens + out * 2, true)
      return calls
    }
    case "delegate": {
      add("lead", 1, taskInputTokens)
      add("worker", extension.limits.worker_model_turns, taskInputTokens + out)
      add("lead", 1 + extension.limits.lead_takeovers, taskInputTokens + out * 2, true)
      return calls
    }
  }
}

export function estimateAction(input: ActionShapeInput, context: EstimateContext): ActionEstimate {
  const calls = plannedCalls(input)
  let reserve = 0
  let expected = 0
  let stage = 0
  let priceKnown = true
  let modelCalls = 0
  for (const call of calls) {
    const one = reserveForCall(call, context)
    reserve += one.microusd * call.calls
    if (!one.priceKnown) priceKnown = false
    const exp = expectedForCall(call, context)
    expected += (exp ?? context.unknownPriceCallReserveMicrousd) * call.calls
    modelCalls += call.calls
    if (call.stage) stage += one.microusd * call.calls
  }
  return {
    reserveMicrousd: reserve,
    expectedMicrousd: expected,
    p95Ms: estimateP95(input.mode, calls),
    priceKnown,
    stageReserveMicrousd: stage,
    modelCalls,
  }
}

function estimateP95(mode: ExecutionMode, calls: RoleCallEstimate[]): number {
  const sum = (role: RoleName) =>
    calls
      .filter((c) => c.role === role)
      .reduce((acc, c) => acc + c.deployment.p95LatencyMs * c.calls, 0)
  switch (mode) {
    case "direct":
      return calls.reduce((acc, c) => acc + c.deployment.p95LatencyMs * c.calls, 0)
    case "cascade":
      return sum("cheap") + sum("strong") + sum("reviewer")
    case "panel":
      // Candidates run in parallel: the slowest member bounds the fan-out.
      return (
        Math.max(sum("panel_a"), sum("panel_b"), sum("panel_c")) + sum("judge") + sum("synthesizer")
      )
    case "delegate":
      return sum("lead") + sum("worker")
  }
}
