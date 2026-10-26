/**
 * The plugin contract's share of `lib/db/agent-traces.ts`, which re-exports these.
 */
import type { AgentTraceSessionAnalyticsSummary } from "../../types/agent/agent-trace"

/** Richer per-window stats consumed by the agent-trace stats bar — adds
 * token / cache / cost breakdowns + per-model histogram on top of the
 * legacy `AgentTraceSessionAnalyticsSummary`. */
export interface AgentTraceStatsSummary extends AgentTraceSessionAnalyticsSummary {
  totalSpans: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  /** `cacheReadTokens / (inputTokens + cacheReadTokens)` ∈ [0, 1]. 0 when no input tokens recorded. */
  cacheHitRate: number
  errorCount: number
  byModel: Record<
    string,
    { spans: number; inputTokens: number; outputTokens: number; costUsd: number }
  >
  bySurface: Record<string, number>
}
