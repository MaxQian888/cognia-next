/**
 * The cost ledger of one Bot run, and the `maxRunCostUsd` ceiling on it.
 *
 * Every model invocation a run makes records what it cost as its own
 * completed step (`__host:cost:<invocation step>`), so a replayed invocation
 * never charges twice and the run's spend is a sum over its steps rather than
 * a counter something could forget to update.
 *
 * Two enforcement strengths, chosen by the installation's execution route:
 *
 *  - **gateway**: the remaining allowance becomes the gateway ticket's token
 *    ceiling, so one invocation cannot overrun it (a hard cap);
 *  - **native**: the CLI talks to its provider directly, so the cap is checked
 *    between invocations only (a soft cap): the one that crosses it finishes,
 *    every later one is refused.
 *
 * A cap with no known price is refused rather than guessed at: pricing an
 * unknown model at $0 would make any ceiling a no-op.
 */

import { completeBotRunStep, getBotRunStep, listBotRunSteps } from "@/lib/db/bot-run-steps"
import {
  costFromTokensUsd,
  resolveModelPricingUsd,
  type ResolvePricingOptions,
} from "@/lib/usage/pricing"
import type { ExternalAgentResult } from "@/types/agent/external-agent"

/** Prefix of the per-invocation cost steps. Reserved (`__host:`), plugin-unwritable. */
export const BOT_RUN_COST_STEP_PREFIX = "__host:cost:"

export interface BotRunInvocationCost {
  /** USD for this invocation; `null` when it could not be priced. */
  costUsd: number | null
  /** Where the figure came from. */
  source: "provider" | "pricing" | "unknown"
  inputTokens: number
  outputTokens: number
}

export interface BotRunCostSummary {
  spentUsd: number
  /** Invocations whose cost is unknown; their spend is not in `spentUsd`. */
  unpricedInvocations: number
  invocations: number
}

export class BotRunBudgetExceededError extends Error {
  readonly code = "budget_exceeded"
  constructor(
    readonly spentUsd: number,
    readonly maxRunCostUsd: number
  ) {
    super(
      `Bot run spent $${spentUsd.toFixed(4)} of its $${maxRunCostUsd.toFixed(2)} cost ceiling; ` +
        "no further model calls are allowed"
    )
    this.name = "BotRunBudgetExceededError"
  }
}

export class BotRunPricingUnknownError extends Error {
  readonly code = "pricing_unknown"
  constructor(readonly modelId: string) {
    super(
      `No price is known for model "${modelId}", so the installation's cost ceiling cannot be ` +
        "enforced; choose a priced model or remove the ceiling"
    )
    this.name = "BotRunPricingUnknownError"
  }
}

type TokenUsage = ExternalAgentResult["tokenUsage"]

/**
 * Price one invocation's usage. A provider-reported USD cost wins (it already
 * includes whatever the provider bills); otherwise the shared pricing table.
 */
export function priceBotInvocation(
  usage: TokenUsage,
  model: { providerId?: string; modelId: string },
  opts: ResolvePricingOptions = {}
): BotRunInvocationCost {
  const inputTokens = usage?.promptTokens ?? 0
  const outputTokens = usage?.completionTokens ?? 0
  const provider = usage?.providerCost
  // A figure with no currency has an unknown unit (OpenCode reports a bare
  // number); only an explicit USD amount stands in for pricing.
  if (
    provider &&
    Number.isFinite(provider.amount) &&
    provider.amount >= 0 &&
    provider.currency?.toUpperCase() === "USD"
  ) {
    return { costUsd: provider.amount, source: "provider", inputTokens, outputTokens }
  }
  if (!usage) return { costUsd: null, source: "unknown", inputTokens, outputTokens }
  const pricing = resolveModelPricingUsd(model.providerId, model.modelId, opts)
  if (!pricing) return { costUsd: null, source: "unknown", inputTokens, outputTokens }
  const costUsd = costFromTokensUsd(
    {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: usage.cacheReadTokens ?? 0,
      cacheCreationInputTokens: usage.cacheWriteTokens ?? 0,
    },
    pricing
  )
  return { costUsd, source: "pricing", inputTokens, outputTokens }
}

/**
 * How many tokens `remainingUsd` buys at the model's most expensive token
 * rate, or `undefined` when the model has no known price. Used as the gateway
 * ticket ceiling, so it rounds down and never exceeds the allowance.
 */
export function tokenAllowanceForUsd(
  remainingUsd: number,
  model: { providerId?: string; modelId: string },
  opts: ResolvePricingOptions = {}
): number | undefined {
  const pricing = resolveModelPricingUsd(model.providerId, model.modelId, opts)
  if (!pricing) return undefined
  const rates = [
    pricing.promptPer1M,
    pricing.completionPer1M,
    pricing.cacheCreationPer1M,
    pricing.cachedInputPer1M,
  ].filter((rate): rate is number => typeof rate === "number" && Number.isFinite(rate))
  const highest = Math.max(0, ...rates)
  // A free model: the ceiling is not a token question.
  if (highest === 0) return Number.MAX_SAFE_INTEGER
  return Math.max(0, Math.floor((remainingUsd * 1_000_000) / highest))
}

export async function recordBotInvocationCost(
  runId: string,
  invocationStep: string,
  cost: BotRunInvocationCost
): Promise<void> {
  await completeBotRunStep(runId, `${BOT_RUN_COST_STEP_PREFIX}${invocationStep}`, cost)
}

export async function getBotInvocationCost(
  runId: string,
  invocationStep: string
): Promise<BotRunInvocationCost | undefined> {
  const row = await getBotRunStep(runId, `${BOT_RUN_COST_STEP_PREFIX}${invocationStep}`)
  return row?.status === "completed" ? (row.output as BotRunInvocationCost) : undefined
}

export async function summarizeBotRunCost(runId: string): Promise<BotRunCostSummary> {
  const steps = await listBotRunSteps(runId)
  let spentUsd = 0
  let unpricedInvocations = 0
  let invocations = 0
  for (const step of steps) {
    if (step.status !== "completed" || !step.name.startsWith(BOT_RUN_COST_STEP_PREFIX)) continue
    invocations += 1
    const cost = step.output as BotRunInvocationCost
    if (typeof cost?.costUsd === "number") spentUsd += cost.costUsd
    else unpricedInvocations += 1
  }
  return { spentUsd, unpricedInvocations, invocations }
}

/**
 * Refuse a new invocation once the run has spent its ceiling, and say how much
 * is left. `undefined` ceiling means uncapped.
 */
export async function remainingBotRunBudgetUsd(
  runId: string,
  maxRunCostUsd: number | undefined
): Promise<number | undefined> {
  if (maxRunCostUsd === undefined) return undefined
  const { spentUsd } = await summarizeBotRunCost(runId)
  if (spentUsd >= maxRunCostUsd) throw new BotRunBudgetExceededError(spentUsd, maxRunCostUsd)
  return maxRunCostUsd - spentUsd
}

/** The pricing settings of this Host, when its settings store is loaded. */
export async function currentPricingSettings(): Promise<ResolvePricingOptions> {
  try {
    const { useSettingsStore } = await import("@/stores/settings")
    const settings = useSettingsStore.getState().settings
    return settings ? { settings } : {}
  } catch {
    return {}
  }
}
