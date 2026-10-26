import type { AgentTraceStatsWindow } from "@cognia/plugin-contract/lib/observability/trace-window"
export type { AgentTraceStatsWindow } from "@cognia/plugin-contract/lib/observability/trace-window"

/** Ordered list for rendering the picker. */
export const AGENT_TRACE_WINDOWS: readonly AgentTraceStatsWindow[] = [
  "today",
  "week",
  "month",
  "all",
] as const

/**
 * Lower bound (epoch ms) for a window, or `undefined` for "all" — the
 * aggregate helpers in `lib/db/agent-traces.ts` treat a missing `since` as
 * "no lower bound", so `undefined` must survive rather than becoming `0`.
 *
 * `today` is calendar-aligned to local midnight, not "24h ago": the stats bar
 * answers "what have I spent today", which rolls over at midnight.
 */
export function agentTraceWindowSince(
  window: AgentTraceStatsWindow,
  now: number = Date.now()
): number | undefined {
  switch (window) {
    case "today": {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    case "week":
      return now - 7 * 24 * 60 * 60 * 1000
    case "month":
      return now - 30 * 24 * 60 * 60 * 1000
    case "all":
      return undefined
  }
}

/** Same bound, floored to `0` for callers that need a concrete number. */
export function agentTraceWindowSinceOrZero(
  window: AgentTraceStatsWindow,
  now: number = Date.now()
): number {
  return agentTraceWindowSince(window, now) ?? 0
}

/** Narrow an untrusted value (deep link, persisted state) to a valid window. */
export function resolveAgentTraceWindow(
  raw: string | null | undefined,
  fallback: AgentTraceStatsWindow = "today"
): AgentTraceStatsWindow {
  return raw !== null &&
    raw !== undefined &&
    (AGENT_TRACE_WINDOWS as readonly string[]).includes(raw)
    ? (raw as AgentTraceStatsWindow)
    : fallback
}
