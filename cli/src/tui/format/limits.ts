/**
 * Pure markdown builder for the `/limits` report — the CLI analog of Claude
 * Code's `/usage` screen. Two sections:
 *
 *  1. **Subscription limits** — the Anthropic unified rate-limit windows
 *     (5-hour session + 7-day week) parsed from a live probe, rendered as
 *     gauges with "% used" and a reset countdown. Reuses the desktop's
 *     `summarizeCurrentWindow` / `splitCountdown` so the numbers match the app.
 *  2. **This session** — local contributing-factors analysis (see
 *     `usage-analysis.ts`), clearly scoped to the current machine/session.
 *
 * Rendered through the existing `document` overlay (markdown), so no new overlay
 * kind or App wiring is needed. Pure given the injected `now`.
 */
import type { UsageSnapshot } from "@/types/subscription"
import {
  summarizeCurrentWindow,
  splitCountdown,
} from "@/lib/subscription/anthropic/usage-analytics"

import { contextGauge } from "./status-bar"
import { formatTokens } from "./usage"
import type { SessionAnalysis } from "./usage-analysis"

/** Bar width (columns) for the limit gauges. */
const GAUGE_WIDTH = 24

function resetText(msUntilReset: number | null): string | null {
  if (msUntilReset == null) return null
  const c = splitCountdown(msUntilReset)
  if (c.expired) return "  Resets shortly"
  if (c.hours > 0) return `  Resets in ${c.hours}h ${c.minutes}m`
  return `  Resets in ${c.minutes}m`
}

function windowLines(
  label: string,
  window: { utilization: number; msUntilReset: number | null } | null
): string[] {
  if (!window) return []
  const pct = Math.round(window.utilization)
  const lines = [`**${label}**`, `  ${contextGauge(pct, GAUGE_WIDTH)} used`]
  const reset = resetText(window.msUntilReset)
  if (reset) lines.push(reset)
  return lines
}

/**
 * Build the `/limits` report. `snapshot` is the probed Anthropic usage (or null
 * when unavailable — non-subscription provider, no token, or a failed probe).
 */
export function buildLimitsReport(
  snapshot: UsageSnapshot | null,
  analysis: SessionAnalysis,
  now: number
): string {
  const out: string[] = ["# Usage & limits", ""]

  // ── Subscription limits ─────────────────────────────────────────────────
  out.push("## Subscription limits")
  const summary = snapshot ? summarizeCurrentWindow(snapshot, { now }) : null
  if (summary && (summary.fiveHour || summary.sevenDay)) {
    out.push(...windowLines("Current session (5h)", summary.fiveHour))
    if (summary.fiveHour && summary.sevenDay) out.push("")
    out.push(...windowLines("Current week (all models)", summary.sevenDay))
    if (summary.fallbackPercentage != null && summary.fallbackPercentage > 0) {
      out.push("", `Fallback in use: ${Math.round(summary.fallbackPercentage)}%`)
    }
  } else {
    out.push(
      "_No subscription limit data — these windows are only reported on an Anthropic Pro/Max session. Switch the active provider to `anthropic` with a subscription token to see them. (A probe costs ~10 tokens of your quota.)_"
    )
  }

  // ── This session (local) ────────────────────────────────────────────────
  out.push("", "## This session", "")
  out.push("_Based on this local session only — not a subscription-wide breakdown._", "")
  out.push(`- Turns this session: ${analysis.turns}`)
  if (analysis.turns > 0) {
    out.push(
      `- ${analysis.highContextPct}% of turns ran at >${formatTokens(analysis.highContextThreshold)} context` +
        (analysis.highContextPct > 0
          ? " — longer sessions cost more even when cached; `/compact` mid-task or `/clear` when switching tasks."
          : ".")
    )
  }
  if (analysis.dispatchCalls > 0) {
    out.push(
      `- ${analysis.dispatchCalls} subagent dispatch${analysis.dispatchCalls === 1 ? "" : "es"} — each subagent runs its own requests against the same limit.`
    )
  }
  if (analysis.topTools.length > 0) {
    out.push("", "Top tools:")
    for (const tool of analysis.topTools) {
      out.push(`- ${tool.name} — ${tool.calls} call${tool.calls === 1 ? "" : "s"} (${tool.pct}%)`)
    }
  } else if (analysis.turns === 0) {
    out.push("- No activity recorded yet.")
  }

  return out.join("\n")
}
