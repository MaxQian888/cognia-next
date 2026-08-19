/**
 * The coarse "how far back" window shared by the agent-trace surfaces.
 *
 * `AgentTraceStatsBar` owned this switch privately, which was fine while it was
 * the only consumer. The `/logs` Traces channel now drives the stats bar AND
 * the trace list from one control, and two copies of the same mapping would
 * drift the moment either grew a preset — so the mapping lives here and both
 * import it.
 *
 * Deliberately coarser than `./time-range.ts`: that module models the
 * observability dashboard's Grafana-style sliding presets (5m…30d) plus pinned
 * custom bounds and bucket sizing. This one is a four-way "today / week /
 * month / everything" picker with a calendar-aligned `today`, which the
 * dashboard has no notion of.
 *
 * Pure module — no Dexie, no React. `now` is injectable so tests are
 * deterministic.
 */

/** Coarse retention window for the agent-trace stats bar and trace list. */
export type AgentTraceStatsWindow = "today" | "week" | "month" | "all"

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
