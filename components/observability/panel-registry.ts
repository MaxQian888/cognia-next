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
function packSmall(): PanelLayoutItem[] {
  const out: PanelLayoutItem[] = []
  let y = 0
  let column = 0
  for (const panel of PANELS) {
    if (panel.kind === "stat") {
      out.push({ i: panel.id, x: column, y, w: 1, h: 2, minW: 1, minH: 2 })
      column = column === 0 ? 1 : 0
      if (column === 0) y += 2
      continue
    }
    // A wide panel always starts its own row.
    if (column === 1) {
      y += 2
      column = 0
    }
    out.push({ i: panel.id, x: 0, y, w: 2, h: 6, minW: 1, minH: 2 })
    y += 6
  }
  return out
}

/**
 * Default grid layout. `lg` (12 col) is the curated Grafana-style arrangement;
 * `md` (8 col) and `sm` (2 col) stack progressively for narrow viewports.
 */
export function defaultLayouts(): PanelLayouts {
  return {
    lg: [
      { i: "kpi-cost", x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2 },
      { i: "kpi-spans", x: 2, y: 0, w: 2, h: 2, minW: 2, minH: 2 },
      { i: "kpi-errors", x: 4, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: "kpi-cache", x: 7, y: 0, w: 2, h: 2, minW: 2, minH: 2 },
      { i: "kpi-latency", x: 9, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: "kpi-rate", x: 0, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-tools", x: 4, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-tool-failures", x: 8, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "ts-cost", x: 0, y: 4, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-rate", x: 6, y: 4, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-errors", x: 0, y: 10, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-latency", x: 6, y: 10, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-tokens", x: 0, y: 16, w: 12, h: 6, minW: 4, minH: 4 },
      { i: "bd-model", x: 0, y: 22, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-surface", x: 6, y: 22, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-provider", x: 0, y: 29, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-project", x: 6, y: 29, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-operation", x: 0, y: 36, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-tool", x: 6, y: 36, w: 6, h: 7, minW: 3, minH: 5 },
    ],
    md: [
      { i: "kpi-cost", x: 0, y: 0, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-spans", x: 4, y: 0, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-errors", x: 0, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-cache", x: 4, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-latency", x: 0, y: 4, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-rate", x: 4, y: 4, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-tools", x: 0, y: 6, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-tool-failures", x: 4, y: 6, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "ts-cost", x: 0, y: 8, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-rate", x: 0, y: 14, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-errors", x: 0, y: 20, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-latency", x: 0, y: 26, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-tokens", x: 0, y: 32, w: 8, h: 6, minW: 4, minH: 4 },
      { i: "bd-model", x: 0, y: 38, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-surface", x: 4, y: 38, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-provider", x: 0, y: 45, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-project", x: 4, y: 45, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-operation", x: 0, y: 52, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-tool", x: 4, y: 52, w: 4, h: 7, minW: 3, minH: 5 },
    ],
    // 2 columns. KPI tiles pair up (a phone showing eight full-width numbers
    // before the first chart is three screens of scrolling); everything with an
    // axis takes the full width, because a ~170px chart is unreadable.
    sm: packSmall(),
  }
}
