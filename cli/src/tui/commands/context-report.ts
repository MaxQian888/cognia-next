/**
 * Pure builder for the `/context` command — a multi-line report of context-window
 * occupancy plus what's loaded, reusing the desktop's per-model context-window
 * math (`computeContextWindowUsage`) and the CLI's token humaniser so the report
 * always agrees with the footer gauge. Kept pure so the `/context` handler stays
 * a one-liner and the formatting is unit-tested without rendering.
 */
import { computeContextWindowUsage } from "@/lib/claude/usage"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { SdkContextUsage } from "@/lib/claude/types"

import { describeBuiltinTools } from "./builtins"
import { cacheHitRatio, contextComposition, formatTokens } from "../format/usage"
import { markedGauge, stackedBar } from "../format/charts"
import type { ResolvedConfig } from "../../config/schema"

/**
 * Build the `/context` report for the latest turn's `usage` against `config`.
 * `windowOverride` (the per-model window resolved from the catalog) pins the
 * window size so the report matches the footer gauge.
 */
export function buildContextReport(
  usage: UsageInfo | undefined,
  config: ResolvedConfig,
  windowOverride?: number
): string {
  const ctx = computeContextWindowUsage(
    usage ?? null,
    config.model,
    windowOverride && windowOverride > 0 ? windowOverride : undefined
  )
  const pct = Math.round(ctx.fraction * 100)
  const compactPct = ctx.max > 0 ? Math.round((ctx.compactThresholdTokens / ctx.max) * 100) : 0
  const model = config.model ?? "default"
  const lines = [
    `Context window — ${model} (${config.provider})`,
    // The gauge marks the auto-compact threshold (┊) so you can see how close
    // the current fill is to triggering a compaction.
    `  ${markedGauge(pct, compactPct, 10)}`,
    `  Used:            ${formatTokens(ctx.used)} / ${formatTokens(ctx.max)} (${pct}%)`,
    `  Remaining:       ${formatTokens(ctx.remaining)}`,
    `  Auto-compact at: ${formatTokens(ctx.compactThresholdTokens)} (${compactPct}%)`,
  ]
  // Once a turn has reported usage, surface the prefix-cache efficiency and the
  // prompt-side composition (reused / newly-cached / fresh) as a monochrome
  // segmented bar — the cost lever the harness-design notes highlight.
  if (usage) {
    const comp = contextComposition(usage)
    const hitPct = Math.round(cacheHitRatio(usage) * 100)
    const bar = stackedBar(
      [
        { value: comp.cacheRead, char: "█" },
        { value: comp.cacheCreation, char: "▓" },
        { value: comp.fresh, char: "░" },
      ],
      20
    )
      .map((r) => r.text)
      .join("")
    lines.push(
      `  Cache hit:       ${hitPct}%`,
      `  Composition:     ${bar}`,
      `    █ reused ${formatTokens(comp.cacheRead)}  ▓ new ${formatTokens(
        comp.cacheCreation
      )}  ░ fresh ${formatTokens(comp.fresh)}`
    )
  }
  lines.push(`  ${describeBuiltinTools(config.builtinTools)}`)
  return lines.join("\n")
}

/**
 * Append the SDK's authoritative live context breakdown to the estimated report.
 * Unlike {@link buildContextReport} (which estimates the window from a pattern
 * table), this is the real per-category occupancy the Agent SDK reports for the
 * running session: system prompt, tools, MCP tools, memory files, agents. Only
 * reachable on a live Anthropic session; callers fall back to the estimate when
 * the SDK round-trip is unavailable.
 */
export function formatSdkContextBreakdown(sdk: SdkContextUsage): string {
  const pct = Math.round(sdk.percentage)
  const lines = [
    "",
    `Live context (SDK)${sdk.model ? ` — ${sdk.model}` : ""}`,
    `  ${markedGauge(pct, 0, 10)}`,
    `  Used:            ${formatTokens(sdk.totalTokens)} / ${formatTokens(sdk.maxTokens)} (${pct}%)`,
  ]
  // The high-level categories (System prompt / Tools / Messages / Free space …),
  // largest first, with deferred (not-yet-loaded) ones flagged.
  const cats = (sdk.categories ?? [])
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  for (const c of cats.slice(0, 8)) {
    lines.push(`    ${c.name}${c.isDeferred ? " (deferred)" : ""}: ${formatTokens(c.tokens)}`)
  }
  // A one-line MCP-tools roll-up when present (often the surprise context hog).
  const mcp = sdk.mcpTools ?? []
  if (mcp.length > 0) {
    const mcpTokens = mcp.reduce((sum, t) => sum + (t.tokens ?? 0), 0)
    lines.push(`  MCP tools:       ${mcp.length} (${formatTokens(mcpTokens)})`)
  }
  return lines.join("\n")
}
