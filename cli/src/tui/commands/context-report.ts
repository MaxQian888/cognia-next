/**
 * Pure builder for the `/context` command — a multi-line report of context-window
 * occupancy plus what's loaded, reusing the desktop's per-model context-window
 * math (`computeContextWindowUsage`) and the CLI's token humaniser so the report
 * always agrees with the footer gauge. Kept pure so the `/context` handler stays
 * a one-liner and the formatting is unit-tested without rendering.
 */
import { computeContextWindowUsage } from "@/lib/claude/usage"
import type { UsageInfo } from "@/lib/claude/adapter"

import { describeBuiltinTools } from "./builtins"
import { formatTokens } from "../format/usage"
import type { ResolvedConfig } from "../../config/schema"

/** Build the `/context` report for the latest turn's `usage` against `config`. */
export function buildContextReport(usage: UsageInfo | undefined, config: ResolvedConfig): string {
  const ctx = computeContextWindowUsage(usage ?? null, config.model)
  const pct = Math.round(ctx.fraction * 100)
  const compactPct = ctx.max > 0 ? Math.round((ctx.compactThresholdTokens / ctx.max) * 100) : 0
  const model = config.model ?? "default"
  return [
    `Context window — ${model} (${config.provider})`,
    `  Used:            ${formatTokens(ctx.used)} / ${formatTokens(ctx.max)} (${pct}%)`,
    `  Remaining:       ${formatTokens(ctx.remaining)}`,
    `  Auto-compact at: ${formatTokens(ctx.compactThresholdTokens)} (${compactPct}%)`,
    `  ${describeBuiltinTools(config.builtinTools)}`,
  ].join("\n")
}
