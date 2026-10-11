/**
 * Panel catalog + default grid layout for the observability dashboard.
 *
 * Pure config (no JSX) so it can be unit-tested and imported by both the grid
 * and the store-default fallback. Each panel is addressed by a stable `id`
 * that doubles as its react-grid-layout key.
 */

import type { Dimension } from "@/lib/observability/breakdown"
import type { ThresholdMetric } from "@/lib/observability/thresholds"
import type { PanelLayoutItem, PanelLayouts } from "@/stores/observability/observability-store"

export type PanelKind = "stat" | "timeseries" | "donut" | "bar"

/** Which headline number a stat panel shows. */
export type StatMetric =
  | "totalCost"
  | "totalSpans"
  | "errorRate"
  | "cacheHitRate"
  | "p95Latency"
  | "reqPerMin"
  | "toolCalls"
  | "toolFailures"

/** Which derived series a time-series panel plots. */
export type SeriesKind = "cost" | "requestRate" | "errorRate" | "latency" | "tokens"

/**
 * A Dashboard → Explore jump. The grid answers "how much"; the trace list
 * answers "which ones" — every chart that can say which traces it counted
 * offers the jump, and the channel (`TraceWorkspace`) applies it to the shared
 * controls before switching sub-view, so the list shows exactly what the panel
 * summarised:
 *
 *   errors   errors-only on (the error-rate and tool-failure stats)
 *   window   the range pinned to one time-series bucket
 *   filter   one breakdown value made sure-selected (never toggled OFF)
 */
export type DashboardDrill =
  | { kind: "errors" }
  | { kind: "window"; since: number; until: number }
  | { kind: "filter"; dimension: Dimension; value: string }

export interface PanelDef {
  id: string
  kind: PanelKind
  /** i18n key under `observability.panels.*`. */
  titleKey: string
  statMetric?: StatMetric
  seriesKind?: SeriesKind
  dimension?: Dimension
  /** Threshold metric for color coding (stat + time-series). */
  threshold?: ThresholdMetric
  /** A stat whose number is a count of failing traces — clicking it drills
   * into Explore with errors-only on. */
  drillErrors?: boolean
}

export const PANELS: readonly PanelDef[] = [
  // KPI row.
  {
    id: "kpi-cost",
    kind: "stat",
    titleKey: "totalCost",
    statMetric: "totalCost",
    threshold: "cost",
  },
  { id: "kpi-spans", kind: "stat", titleKey: "totalSpans", statMetric: "totalSpans" },
  {
    id: "kpi-errors",
    kind: "stat",
    titleKey: "errorRate",
    statMetric: "errorRate",
    threshold: "errorRate",
    drillErrors: true,
  },
  {
    id: "kpi-cache",
    kind: "stat",
    titleKey: "cacheHitRate",
    statMetric: "cacheHitRate",
    threshold: "cacheHitRate",
  },
  {
    id: "kpi-latency",
    kind: "stat",
    titleKey: "p95Latency",
    statMetric: "p95Latency",
    threshold: "latencyP95",
  },
  // `reqPerMin` was resolvable by `resolveStat` and computed by `windowKpis`
  // from the start, with no panel asking for it.
  { id: "kpi-rate", kind: "stat", titleKey: "reqPerMin", statMetric: "reqPerMin" },
  // Tool volume and tool failures were the two numbers the `/logs` trace stats
  // bar carried that no panel did; the bar is gone, so they live here.
  { id: "kpi-tools", kind: "stat", titleKey: "toolCalls", statMetric: "toolCalls" },
  {
    id: "kpi-tool-failures",
    kind: "stat",
    titleKey: "toolFailures",
    statMetric: "toolFailures",
    drillErrors: true,
  },
  // Time-series group.
  { id: "ts-cost", kind: "timeseries", titleKey: "costOverTime", seriesKind: "cost" },
  { id: "ts-rate", kind: "timeseries", titleKey: "requestRate", seriesKind: "requestRate" },
  {
    id: "ts-errors",
    kind: "timeseries",
    titleKey: "errorRateOverTime",
    seriesKind: "errorRate",
    threshold: "errorRate",
  },
  {
    id: "ts-latency",
    kind: "timeseries",
    titleKey: "latencyPercentiles",
    seriesKind: "latency",
    threshold: "latencyP95",
  },
  { id: "ts-tokens", kind: "timeseries", titleKey: "tokenThroughput", seriesKind: "tokens" },
  // Breakdown.
  { id: "bd-model", kind: "donut", titleKey: "byModel", dimension: "model" },
  { id: "bd-surface", kind: "bar", titleKey: "bySurface", dimension: "surface" },
  // Cost attribution (ADR-0130). "Which vendor is this money going to?" and
  // "which workspace is spending it?" were both unanswerable from here.
  { id: "bd-provider", kind: "donut", titleKey: "byProvider", dimension: "provider" },
  { id: "bd-project", kind: "bar", titleKey: "byProject", dimension: "project" },
  // `breakdownOperation` / `breakdownTool` were folded on every render by
  // `useObservabilitySeries` and plotted by nothing.
  { id: "bd-operation", kind: "donut", titleKey: "byOperation", dimension: "operation" },
  { id: "bd-tool", kind: "bar", titleKey: "byTool", dimension: "tool" },
  // There is deliberately no "recent traces" panel: the channel this grid
  // lives in already IS the trace list (the Explore sub-view), reading the
  // same spans over the same window. The panel was a second, narrower copy of
  // it whose only drill-down was a drawer that duplicated Explore's waterfall.
] as const

export function panelById(id: string): PanelDef | undefined {
  return PANELS.find((p) => p.id === id)
}

/** Two-column phone layout: stat tiles half-width and paired, the rest full. */
/**
 * The KPI stats. They render as the `KpiStrip` above the grid, not as grid
 * tiles: the strip is one flat row of numbers that reflows by its own width,
 * so a stat has no layout to persist, drag or resize.
 */
export const KPI_PANELS: readonly PanelDef[] = PANELS.filter((p) => p.kind === "stat")

/** Everything with an axis or a breakdown — the tiles the draggable grid lays out. */
export const GRID_PANELS: readonly PanelDef[] = PANELS.filter((p) => p.kind !== "stat")

/** Phone layout: 2 columns, and every chart takes both — a ~170px chart is
 * unreadable. */
function packSmall(): PanelLayoutItem[] {
  let y = 0
  return GRID_PANELS.map((panel) => {
    const item = { i: panel.id, x: 0, y, w: 2, h: 6, minW: 1, minH: 4 }
    y += 6
    return item
  })
}

/**
 * The grid's default layouts. Only `GRID_PANELS` appear: a stored layout that
 * still carries a `kpi-*` tile from before the strip existed loses it in
 * `normalizePanelLayouts` (which keeps only ids the defaults know), and RGL's
 * vertical compaction closes the rows it leaves.
 */
export function defaultLayouts(): PanelLayouts {
  return {
    lg: [
      { i: "ts-cost", x: 0, y: 0, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-rate", x: 6, y: 0, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-errors", x: 0, y: 6, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-latency", x: 6, y: 6, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-tokens", x: 0, y: 12, w: 12, h: 6, minW: 4, minH: 4 },
      { i: "bd-model", x: 0, y: 18, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-surface", x: 6, y: 18, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-provider", x: 0, y: 25, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-project", x: 6, y: 25, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-operation", x: 0, y: 32, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-tool", x: 6, y: 32, w: 6, h: 7, minW: 3, minH: 5 },
    ],
    md: [
      { i: "ts-cost", x: 0, y: 0, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-rate", x: 0, y: 6, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-errors", x: 0, y: 12, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-latency", x: 0, y: 18, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-tokens", x: 0, y: 24, w: 8, h: 6, minW: 4, minH: 4 },
      { i: "bd-model", x: 0, y: 30, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-surface", x: 4, y: 30, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-provider", x: 0, y: 37, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-project", x: 4, y: 37, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-operation", x: 0, y: 44, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-tool", x: 4, y: 44, w: 4, h: 7, minW: 3, minH: 5 },
    ],
    sm: packSmall(),
  }
}
