/**
 * Aggregate `step_usage` events (emitted by LLM-backed nodes via
 * `ctx.reportUsage`) into per-step and run-level token/cost figures for the
 * Runs UI. Pure — no React, no Dexie.
 */

import type { StepUsage, WorkflowRunEventRow } from "@/types/workflow/visual"
import { estimateCostFromTotals } from "@/lib/usage/session-analytics"

export interface RunUsageSummary {
  /** Latest usage per step (retries overwrite earlier attempts). */
  perStep: Record<string, StepUsage>
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  /** Sum of the known per-step costs; undefined when NO step had pricing. */
  totalCostUsd?: number
  /** True when at least one usage-reporting step had no pricing info. */
  hasUnknownCost: boolean
}

function asUsage(payload: unknown): StepUsage | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    inputTokens: num(p.inputTokens),
    outputTokens: num(p.outputTokens),
    totalTokens: num(p.totalTokens) || num(p.inputTokens) + num(p.outputTokens),
    cacheReadTokens: num(p.cacheReadTokens),
    cacheCreationTokens: num(p.cacheCreationTokens),
    providerId: typeof p.providerId === "string" ? p.providerId : undefined,
    modelId: typeof p.modelId === "string" ? p.modelId : undefined,
    costUsd: typeof p.costUsd === "number" && Number.isFinite(p.costUsd) ? p.costUsd : undefined,
  }
}

export function aggregateRunUsage(events: WorkflowRunEventRow[]): RunUsageSummary {
  const perStep: Record<string, StepUsage> = {}
  for (const e of events) {
    if (e.type !== "step_usage" || !e.stepId) continue
    const usage = asUsage(e.payload)
    // Events arrive in ts order; the last usage for a step (latest retry) wins.
    if (usage) perStep[e.stepId] = usage
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd: number | undefined
  let hasUnknownCost = false
  for (const usage of Object.values(perStep)) {
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    if (typeof usage.costUsd === "number") {
      totalCostUsd = (totalCostUsd ?? 0) + usage.costUsd
    } else {
      // The node didn't report a cost (the ai-sdk / non-Anthropic path often
      // can't): back-fill from the model's pricing tables so runs on priced
      // models still total up. Only truly-unpriced models stay "unknown".
      const estimated = estimateCostFromTotals(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationTokens ?? 0,
        },
        usage.modelId,
        usage.providerId
      )
      if (estimated > 0) {
        totalCostUsd = (totalCostUsd ?? 0) + estimated
      } else {
        hasUnknownCost = true
      }
    }
  }

  return {
    perStep,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd,
    hasUnknownCost,
  }
}

/** Compact token figure: 950 → "950", 12_340 → "12.3k", 4_200_000 → "4.2M". */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "—"
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** "$0.0042" style estimate; sub-cent costs keep enough precision to read. */
export function formatCostUsd(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return "—"
  if (cost === 0) return "$0"
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}
