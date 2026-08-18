/**
 * Panel catalog + default grid layout for the observability dashboard.
 *
 * Pure config (no JSX) so it can be unit-tested and imported by both the grid
 * and the store-default fallback. Each panel is addressed by a stable `id`
 * that doubles as its react-grid-layout key.
 */

import type { Dimension } from "@/lib/observability/breakdown"
import type { ThresholdMetric } from "@/lib/observability/thresholds"
import type { PanelLayouts } from "@/stores/observability/observability-store"

export type PanelKind = "stat" | "timeseries" | "donut" | "bar" | "traces"

/** Which headline number a stat panel shows. */
export type StatMetric =
  "totalCost" | "totalSpans" | "errorRate" | "cacheHitRate" | "p95Latency" | "reqPerMin"

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
  // Recent traces.
  { id: "traces", kind: "traces", titleKey: "recentTraces" },
] as const

export function panelById(id: string): PanelDef | undefined {
  return PANELS.find((p) => p.id === id)
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
      { i: "ts-cost", x: 0, y: 2, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-rate", x: 6, y: 2, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-errors", x: 0, y: 8, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-latency", x: 6, y: 8, w: 6, h: 6, minW: 3, minH: 4 },
      { i: "ts-tokens", x: 0, y: 14, w: 12, h: 6, minW: 4, minH: 4 },
      { i: "bd-model", x: 0, y: 20, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-surface", x: 6, y: 20, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-provider", x: 0, y: 27, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "bd-project", x: 6, y: 27, w: 6, h: 7, minW: 3, minH: 5 },
      { i: "traces", x: 0, y: 34, w: 12, h: 8, minW: 4, minH: 5 },
    ],
    md: [
      { i: "kpi-cost", x: 0, y: 0, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-spans", x: 4, y: 0, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-errors", x: 0, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-cache", x: 4, y: 2, w: 4, h: 2, minW: 2, minH: 2 },
      { i: "kpi-latency", x: 0, y: 4, w: 8, h: 2, minW: 2, minH: 2 },
      { i: "ts-cost", x: 0, y: 6, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-rate", x: 0, y: 12, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-errors", x: 0, y: 18, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-latency", x: 0, y: 24, w: 8, h: 6, minW: 3, minH: 4 },
      { i: "ts-tokens", x: 0, y: 30, w: 8, h: 6, minW: 4, minH: 4 },
      { i: "bd-model", x: 0, y: 36, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-surface", x: 4, y: 36, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-provider", x: 0, y: 43, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "bd-project", x: 4, y: 43, w: 4, h: 7, minW: 3, minH: 5 },
      { i: "traces", x: 0, y: 50, w: 8, h: 8, minW: 4, minH: 5 },
    ],
    sm: PANELS.map((p, i) => ({
      i: p.id,
      x: 0,
      y: i * 4,
      w: 2,
      h: p.kind === "stat" ? 2 : p.kind === "traces" ? 8 : 6,
      minW: 1,
      minH: 2,
    })),
  }
}
