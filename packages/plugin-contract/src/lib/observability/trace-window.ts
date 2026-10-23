/**
 * The plugin contract's share of `lib/observability/trace-window.ts`, which re-exports these.
 */
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
