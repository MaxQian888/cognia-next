/**
 * Cost / latency / efficiency scorer (L1 tier — no LLM).
 *
 * Reference-free: reads cost, latency, and step count straight off the
 * captured {@link EvalSample} (rolled up from `agentTraces` usage). The default
 * `costScorer` carries NO budget, so it reports `measurement` — the raw numbers
 * are surfaced, but they decide nothing. {@link makeCostScorer} turns it into a
 * real gate by attaching budgets, and only then is it `gating`.
 *
 * It used to return `passed: true` in the unbudgeted case, which handed every
 * run a free passing verdict — together with `tool-redundancy` on a toolless
 * run, that is what made plain question/answer datasets report 100%.
 *
 * When budgeted, `value` is the worst within-budget ratio (1 = comfortably
 * within all budgets; <1 means at least one dimension is over).
 */

import type { EvalSample, Score, Scorer } from "../domain/eval"

export interface CostBudget {
  maxCostUsd?: number
  maxLatencyMs?: number
  maxSteps?: number
}

/** Ratio of budget consumed (0 = free, 1 = exactly at budget, >1 = over). */
function consumed(actual: number, budget: number | undefined): number | null {
  if (budget === undefined) return null
  if (budget <= 0) return actual > 0 ? Infinity : 0
  return actual / budget
}

export function makeCostScorer(budget: CostBudget = {}): Scorer {
  const budgeted =
    budget.maxCostUsd !== undefined ||
    budget.maxLatencyMs !== undefined ||
    budget.maxSteps !== undefined
  return {
    id: "cost",
    dimension: "cost",
    requiresLlm: false,
    gating: budgeted,
    score(sample: EvalSample): Score {
      const ratios = [
        consumed(sample.costUsd, budget.maxCostUsd),
        consumed(sample.latencyMs, budget.maxLatencyMs),
        consumed(sample.stepCount, budget.maxSteps),
      ].filter((r): r is number => r !== null)

      const metadata = {
        costUsd: sample.costUsd,
        latencyMs: sample.latencyMs,
        stepCount: sample.stepCount,
        inputTokens: sample.usage.inputTokens,
        outputTokens: sample.usage.outputTokens,
      }

      if (ratios.length === 0) {
        // No budget configured — surface the numbers, decide nothing.
        return {
          scorerId: "cost",
          dimension: "cost",
          status: "measurement",
          value: 1,
          passed: false,
          metadata,
        }
      }

      const worst = Math.max(...ratios)
      const passed = worst <= 1
      // value: 1 when within budget; otherwise shrinks toward 0 as overage grows.
      const value = passed ? 1 : Math.max(0, 1 / worst)
      return { scorerId: "cost", dimension: "cost", status: "scored", value, passed, metadata }
    },
  }
}

/** Measurement-only default (no gate). */
export const costScorer: Scorer = makeCostScorer()
