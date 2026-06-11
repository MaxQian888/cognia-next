/**
 * Pure "what's contributing to your usage" analysis for the `/limits` report.
 *
 * Unlike Claude Code's cross-session/cross-device 24h telemetry (which this app
 * does not collect), this derives characteristics from THIS session's local
 * data only — the per-turn token history and the per-tool call tally the
 * reducer already accumulates. The report labels it as such so the numbers are
 * never mistaken for a subscription-wide breakdown.
 */
import { DISPATCH_AGENT_TOOL_NAME } from "@/lib/claude/agents/dispatch-agent-tool"

import type { ToolStat } from "../state/types"

/** Default context size (tokens) above which a turn is "long-context". */
export const HIGH_CONTEXT_THRESHOLD = 150_000

/** One tool's share of the session's tool activity. */
export interface ToolCallShare {
  name: string
  calls: number
  /** Percent of all tool calls this session (0–100, rounded). */
  pct: number
}

export interface SessionAnalysis {
  /** Turns that carried usage this session. */
  turns: number
  /** Turns whose context exceeded {@link SessionAnalysis.highContextThreshold}. */
  highContextTurns: number
  /** `highContextTurns / turns` as a 0–100 percent. */
  highContextPct: number
  /** The threshold used (tokens). */
  highContextThreshold: number
  /** `dispatch_agent` (subagent) calls this session. */
  dispatchCalls: number
  /** Total tool calls this session. */
  totalToolCalls: number
  /** Busiest tools, descending, capped. */
  topTools: ToolCallShare[]
}

export interface AnalyzeSessionInput {
  /** Per-turn total tokens (prompt incl. cache + output), oldest → newest. */
  usageHistory?: number[]
  /** Per-tool call/error tallies. */
  toolStats?: Record<string, ToolStat>
  /** Long-context threshold in tokens (default {@link HIGH_CONTEXT_THRESHOLD}). */
  highContextThreshold?: number
  /** Max tools to surface in `topTools` (default 5). */
  topToolLimit?: number
}

/** Analyze this session's local telemetry into a contributing-factors summary. */
export function analyzeSession(input: AnalyzeSessionInput = {}): SessionAnalysis {
  const history = input.usageHistory ?? []
  const threshold = input.highContextThreshold ?? HIGH_CONTEXT_THRESHOLD
  const limit = input.topToolLimit ?? 5
  const stats = input.toolStats ?? {}

  const turns = history.length
  const highContextTurns = history.filter((t) => t > threshold).length
  const highContextPct = turns > 0 ? Math.round((highContextTurns / turns) * 100) : 0

  let totalToolCalls = 0
  for (const s of Object.values(stats)) totalToolCalls += s.calls
  const dispatchCalls = stats[DISPATCH_AGENT_TOOL_NAME]?.calls ?? 0

  const topTools: ToolCallShare[] = Object.entries(stats)
    .map(([name, s]) => ({
      name,
      calls: s.calls,
      pct: totalToolCalls > 0 ? Math.round((s.calls / totalToolCalls) * 100) : 0,
    }))
    .filter((t) => t.calls > 0)
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, limit)

  return {
    turns,
    highContextTurns,
    highContextPct,
    highContextThreshold: threshold,
    dispatchCalls,
    totalToolCalls,
    topTools,
  }
}
