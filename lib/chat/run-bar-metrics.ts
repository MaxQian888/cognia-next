/**
 * Pure helpers for the chat run-status bar's configurable metric strip
 * (`components/chat/run-panel.tsx`). Resolves the user's
 * {@link RunStatusBarSettings} toggles to concrete defaults and aggregates the
 * bound session's live `metadata.usage` into the token / cost / speed / context
 * figures the bar renders. No React, no I/O — unit tested in isolation.
 */

import type { UIMessage } from "ai"

import type { UsageInfo } from "@/lib/claude/adapter"
import type { RunStatusBarSettings } from "@/lib/claude/types"
import { computeContextWindowUsage, getLatestUsage } from "@/lib/claude/usage"

/**
 * Default metric visibility. Elapsed + output-tokens + speed + tools are on
 * (informative without $ clutter); cost + context% are opt-in — the composer's
 * `ContextUsageIndicator` already carries the exact model-sized context figure
 * right below the bar, so context% here is a redundant convenience.
 */
export const DEFAULT_RUN_STATUS_BAR: Required<RunStatusBarSettings> = {
  showElapsed: true,
  showOutputTokens: true,
  showSpeed: true,
  showCost: false,
  showContextPct: false,
  showTools: true,
}

/**
 * Resolve a stored (possibly absent / partial) {@link RunStatusBarSettings} to
 * a complete flag set. Per-field `?? default` — spreading would let an explicit
 * `undefined` clobber a default.
 */
export function resolveRunStatusBarSettings(
  s: RunStatusBarSettings | null | undefined
): Required<RunStatusBarSettings> {
  return {
    showElapsed: s?.showElapsed ?? DEFAULT_RUN_STATUS_BAR.showElapsed,
    showOutputTokens: s?.showOutputTokens ?? DEFAULT_RUN_STATUS_BAR.showOutputTokens,
    showSpeed: s?.showSpeed ?? DEFAULT_RUN_STATUS_BAR.showSpeed,
    showCost: s?.showCost ?? DEFAULT_RUN_STATUS_BAR.showCost,
    showContextPct: s?.showContextPct ?? DEFAULT_RUN_STATUS_BAR.showContextPct,
    showTools: s?.showTools ?? DEFAULT_RUN_STATUS_BAR.showTools,
  }
}

/** Whether any enabled metric needs the live per-session usage aggregate. */
export function needsLiveUsage(r: Required<RunStatusBarSettings>): boolean {
  return r.showOutputTokens || r.showSpeed || r.showCost || r.showContextPct
}

export interface RunBarUsageTotals {
  /** Assistant turns that carried usage metadata. 0 ⇒ hide usage-derived chips. */
  turns: number
  /** Summed output tokens across the session's billed turns. */
  outputTokens: number
  /** Summed SDK-reported cost (USD). 0 when the channel reported none. */
  costUsd: number
  /** Summed active generation time (ms). 0 when no turn reported a duration. */
  durationMs: number
  /**
   * Latest-turn context-window fill fraction in [0, 1]. The bar has no model id,
   * so the window falls back to the default size — a best-effort figure; the
   * composer's `ContextUsageIndicator` carries the exact model-sized number.
   */
  contextFraction: number
}

export const EMPTY_RUN_BAR_USAGE: RunBarUsageTotals = {
  turns: 0,
  outputTokens: 0,
  costUsd: 0,
  durationMs: 0,
  contextFraction: 0,
}

/**
 * Sum the bound session's per-turn `metadata.usage` into the figures the run
 * bar needs. Mirrors `sumSessionUsage` but also carries `durationMs` (for the
 * speed derivation) and the latest-turn context fill.
 */
export function aggregateRunBarUsage(messages: readonly UIMessage[]): RunBarUsageTotals {
  let turns = 0
  let outputTokens = 0
  let costUsd = 0
  let durationMs = 0
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const meta = (msg as { metadata?: Record<string, unknown> }).metadata
    const usage = meta?.usage as UsageInfo | undefined
    if (!usage) continue
    turns += 1
    outputTokens += usage.outputTokens ?? 0
    costUsd += usage.totalCostUsd ?? 0
    durationMs += usage.durationMs ?? 0
  }
  const latest = getLatestUsage(messages as UIMessage[])
  const contextFraction = latest ? computeContextWindowUsage(latest, undefined).fraction : 0
  return { turns, outputTokens, costUsd, durationMs, contextFraction }
}
