/**
 * The one list of metrics `/performance` can chart, compare and budget.
 *
 * Every source advertises the capabilities it actually measures
 * (`PerfSourceDescriptor.capabilities`). A metric is shown only when its
 * source advertises the capability behind it, so a missing measurement is an
 * absent tile rather than a flat zero line (ADR-0035, "unsupported metrics are
 * absent, not zero"). Before this catalog the overview read five Tokio /
 * process fields off whichever history it was handed: on web and mobile, and
 * on the Node host, every one of them was a structural zero the frame builder
 * fills in, and the panel charted them as if they were measured.
 *
 * The same entries drive capture comparison and budgets, so a budget's
 * `metricId` / `metricDefinitionVersion` / `unit` mean exactly what the
 * overview tile with that id shows.
 */

import type { PerfFrame, PerfSourceDescriptor, PerfSourceKind } from "./backend/types"
import type { MetricInterval } from "./comparison"
import {
  formatBytes,
  formatBytesPerSec,
  formatCount,
  formatMs,
  formatPercent,
} from "./backend/format"

export type PerfMetricUnit = "percent" | "bytes" | "bytes-per-second" | "count" | "ms" | "fps"

export type PerfMetricId =
  | "host.main.cpu-pct"
  | "host.main.memory-bytes"
  | "host.disk.bytes-per-second"
  | "host.runtime.busy-pct"
  | "host.runtime.alive-tasks"
  | "node.event-loop.utilization-pct"
  | "node.event-loop.delay-p95-ms"
  | "node.heap.used-bytes"
  | "renderer.fps"
  | "renderer.main-thread-blocked-pct"
  | "renderer.long-task.count"
  | "renderer.js-heap.used-bytes"
  | "renderer.long-task.max-ms"
  | "renderer.long-task.blocking-ms"
  | "renderer.js-heap.utilization-pct"
  | "renderer.frame-gap-p95-ms"
  | "renderer.slow-frame.count"
  | "renderer.resource.count"
  | "renderer.resource.duration-p95-ms"
  | "renderer.resource.transfer-bytes"
  | "renderer.event.count"
  | "renderer.event.input-delay-p95-ms"
  | "renderer.event.processing-p95-ms"
  | "renderer.operation.count"
  | "renderer.operation.duration-p95-ms"
  | "renderer.operation.error.count"
  | "renderer.operation.cancelled.count"
  | "renderer.operation.inflight.count"

export interface PerfMetricDefinition {
  id: PerfMetricId
  /** `performance.metrics.<labelKey>` / `performance.metricDescriptions.<labelKey>`. */
  labelKey: string
  /** Bumped whenever {@link extract} changes meaning; budgets pin it. */
  definitionVersion: number
  sourceKind: PerfSourceKind
  unit: PerfMetricUnit
  /** Which way is better — budgets and comparison verdicts read it. */
  direction: "lower" | "higher"
  /** Fixed chart ceiling (percentages); omitted for an auto axis. */
  max?: number
  /** Warning line drawn on the chart. */
  threshold?: number
  /** Every capability listed must be advertised by the source. */
  requires: readonly string[]
  /** Runtime kinds that measure it, when a capability alone is not enough. */
  runtimeKinds?: readonly PerfSourceDescriptor["runtimeKind"][]
  /** `null` = not measured in this frame (a gap in the series, not a zero). */
  extract: (frame: PerfFrame) => number | null
}

function mainProcess(frame: PerfFrame) {
  return frame.processes.find((process) => process.role === "main") ?? null
}

function observation(frame: PerfFrame, key: string): number | null {
  const value = frame.observations?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export const PERF_METRICS: readonly PerfMetricDefinition[] = [
  {
    id: "host.main.cpu-pct",
    labelKey: "cpu",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "percent",
    direction: "lower",
    max: 100,
    threshold: 80,
    requires: ["host.processes"],
    extract: (frame) => mainProcess(frame)?.cpuPct ?? null,
  },
  {
    id: "host.main.memory-bytes",
    labelKey: "memory",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "bytes",
    direction: "lower",
    requires: ["host.processes"],
    extract: (frame) => mainProcess(frame)?.memBytes ?? null,
  },
  {
    id: "host.disk.bytes-per-second",
    labelKey: "diskIo",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "bytes-per-second",
    direction: "lower",
    requires: ["host.processes"],
    // The Node host reports a single process with hard-coded zero disk rates;
    // only the Rust sampler derives disk throughput from the OS.
    runtimeKinds: ["tauri-rust"],
    extract: (frame) =>
      frame.processes.length === 0
        ? null
        : frame.processes.reduce((sum, p) => sum + p.diskReadBps + p.diskWriteBps, 0),
  },
  {
    id: "host.runtime.busy-pct",
    labelKey: "runtimeBusy",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "percent",
    direction: "lower",
    max: 100,
    threshold: 80,
    requires: ["runtime.tokio"],
    extract: (frame) => frame.runtime.busyPct,
  },
  {
    id: "host.runtime.alive-tasks",
    labelKey: "tasks",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "count",
    direction: "lower",
    requires: ["runtime.tokio"],
    extract: (frame) => frame.runtime.aliveTasks,
  },
  {
    id: "node.event-loop.utilization-pct",
    labelKey: "eventLoopUtilization",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "percent",
    direction: "lower",
    max: 100,
    threshold: 80,
    requires: ["runtime.node-event-loop"],
    extract: (frame) => observation(frame, "node.event-loop.utilization.pct"),
  },
  {
    id: "node.event-loop.delay-p95-ms",
    labelKey: "eventLoopDelay",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "ms",
    direction: "lower",
    requires: ["runtime.node-event-loop"],
    extract: (frame) => observation(frame, "node.event-loop.delay.p95.ms"),
  },
  {
    id: "node.heap.used-bytes",
    labelKey: "nodeHeap",
    definitionVersion: 1,
    sourceKind: "host",
    unit: "bytes",
    direction: "lower",
    requires: ["runtime.node-heap"],
    extract: (frame) => observation(frame, "node.heap.used.bytes"),
  },
  {
    id: "renderer.fps",
    labelKey: "fps",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "fps",
    direction: "higher",
    requires: ["renderer.fps"],
    extract: (frame) => observation(frame, "renderer.fps"),
  },
  {
    id: "renderer.main-thread-blocked-pct",
    labelKey: "mainThreadBlocked",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "percent",
    direction: "lower",
    max: 100,
    threshold: 50,
    requires: ["renderer.long-task"],
    extract: (frame) => observation(frame, "renderer.main-thread-blocked.pct"),
  },
  {
    id: "renderer.long-task.count",
    labelKey: "longTasks",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.long-task"],
    extract: (frame) => observation(frame, "renderer.long-task.count"),
  },
  {
    id: "renderer.js-heap.used-bytes",
    labelKey: "jsHeap",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "bytes",
    direction: "lower",
    requires: ["renderer.js-heap"],
    extract: (frame) => observation(frame, "renderer.js-heap.used.bytes"),
  },
  {
    id: "renderer.long-task.max-ms",
    labelKey: "longTaskMax",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.long-task"],
    extract: (frame) => observation(frame, "renderer.long-task.max.ms"),
  },
  {
    id: "renderer.long-task.blocking-ms",
    labelKey: "longTaskBlocking",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.long-task"],
    extract: (frame) => observation(frame, "renderer.long-task.blocking.ms"),
  },
  {
    id: "renderer.js-heap.utilization-pct",
    labelKey: "heapUtilization",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "percent",
    direction: "lower",
    max: 100,
    requires: ["renderer.js-heap"],
    extract: (frame) => observation(frame, "renderer.js-heap.utilization.pct"),
  },
  {
    id: "renderer.frame-gap-p95-ms",
    labelKey: "frameGapP95",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.frame-timing"],
    extract: (frame) => observation(frame, "renderer.frame-gap.p95.ms"),
  },
  {
    id: "renderer.slow-frame.count",
    labelKey: "slowFrames",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.frame-timing"],
    extract: (frame) => observation(frame, "renderer.slow-frame.count"),
  },
  {
    id: "renderer.resource.count",
    labelKey: "resourceCount",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.resource"],
    extract: (frame) => observation(frame, "renderer.resource.count"),
  },
  {
    id: "renderer.resource.duration-p95-ms",
    labelKey: "resourceDurationP95",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.resource"],
    extract: (frame) => observation(frame, "renderer.resource.duration.p95.ms"),
  },
  {
    id: "renderer.resource.transfer-bytes",
    labelKey: "resourceTransfer",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "bytes",
    direction: "lower",
    requires: ["renderer.resource"],
    extract: (frame) => observation(frame, "renderer.resource.transfer.bytes"),
  },
  {
    id: "renderer.event.count",
    labelKey: "eventCount",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.event-timing"],
    extract: (frame) => observation(frame, "renderer.event.count"),
  },
  {
    id: "renderer.event.input-delay-p95-ms",
    labelKey: "inputDelayP95",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.event-timing"],
    extract: (frame) => observation(frame, "renderer.event.input-delay.p95.ms"),
  },
  {
    id: "renderer.event.processing-p95-ms",
    labelKey: "eventProcessingP95",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.event-timing"],
    extract: (frame) => observation(frame, "renderer.event.processing.p95.ms"),
  },
  {
    id: "renderer.operation.count",
    labelKey: "operationCount",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.app-operations"],
    extract: (frame) => observation(frame, "renderer.operation.count"),
  },
  {
    id: "renderer.operation.duration-p95-ms",
    labelKey: "operationDurationP95",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "ms",
    direction: "lower",
    requires: ["renderer.app-operations"],
    extract: (frame) => observation(frame, "renderer.operation.duration.p95.ms"),
  },
  {
    id: "renderer.operation.error.count",
    labelKey: "operationErrors",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.app-operations"],
    extract: (frame) => observation(frame, "renderer.operation.error.count"),
  },
  {
    id: "renderer.operation.cancelled.count",
    labelKey: "operationCancelled",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.app-operations"],
    extract: (frame) => observation(frame, "renderer.operation.cancelled.count"),
  },
  {
    id: "renderer.operation.inflight.count",
    labelKey: "operationInFlight",
    definitionVersion: 1,
    sourceKind: "renderer",
    unit: "count",
    direction: "lower",
    requires: ["renderer.app-operations"],
    extract: (frame) => observation(frame, "renderer.operation.inflight.count"),
  },
]

const BY_ID = new Map(PERF_METRICS.map((metric) => [metric.id, metric]))

export function getPerfMetric(id: string): PerfMetricDefinition | null {
  return BY_ID.get(id as PerfMetricId) ?? null
}

export function isPerfMetricId(id: string): id is PerfMetricId {
  return BY_ID.has(id as PerfMetricId)
}

/** Does `source` measure `metric`? */
export function sourceSupportsMetric(
  source: Pick<PerfSourceDescriptor, "kind" | "capabilities" | "runtimeKind">,
  metric: PerfMetricDefinition
): boolean {
  if (source.kind !== metric.sourceKind) return false
  if (metric.runtimeKinds && !metric.runtimeKinds.includes(source.runtimeKind)) return false
  return metric.requires.every((capability) => source.capabilities.includes(capability))
}

/** The catalog entries a source measures, in catalog order. */
export function metricsForSource(
  source: Pick<PerfSourceDescriptor, "kind" | "capabilities" | "runtimeKind"> | null | undefined
): PerfMetricDefinition[] {
  if (!source) return []
  return PERF_METRICS.filter((metric) => sourceSupportsMetric(source, metric))
}

/** Every catalog entry for a source kind, for choosing a metric before any source is known. */
export function metricsForSourceKind(kind: PerfSourceKind): PerfMetricDefinition[] {
  return PERF_METRICS.filter((metric) => metric.sourceKind === kind)
}

/** One value per frame, `null` where the frame did not measure it. */
export function metricSeries(frames: readonly PerfFrame[], metric: PerfMetricDefinition) {
  return frames.map((frame) => metric.extract(frame))
}

/**
 * A frame is a valid comparison interval only when nothing about it makes its
 * delta untrustworthy: a reset, a discontinuity, a counter reset, or missed
 * ticks inside it (ADR-0035, "one value per valid interval").
 */
export function isValidInterval(frame: PerfFrame): boolean {
  return (
    !frame.flags.reset &&
    !frame.flags.discontinuity &&
    !frame.flags.counterReset &&
    frame.missedTicks === 0
  )
}

export function metricIntervals(
  frames: readonly PerfFrame[],
  metric: PerfMetricDefinition
): MetricInterval[] {
  return frames.map((frame) => {
    const value = metric.extract(frame)
    return { value, valid: isValidInterval(frame) && value !== null }
  })
}

export interface MetricSeriesSummary {
  latest: number | null
  peak: number | null
  average: number | null
  /** Frames that measured the metric. */
  samples: number
}

export function summarizeSeries(points: readonly (number | null)[]): MetricSeriesSummary {
  const last = points.at(-1)
  const latest = typeof last === "number" && Number.isFinite(last) ? last : null
  let peak: number | null = null
  let sum = 0
  let samples = 0
  for (const point of points) {
    if (point === null || !Number.isFinite(point)) continue
    peak = peak === null ? point : Math.max(peak, point)
    sum += point
    samples += 1
  }
  return { latest, peak, average: samples > 0 ? sum / samples : null, samples }
}

/**
 * Unit-aware value formatting. Unit symbols (`%`, `MB`, `fps`) are not
 * translated, matching the rest of `lib/perf/backend/format.ts`.
 */
export function formatPerfMetricValue(unit: PerfMetricUnit, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  switch (unit) {
    case "percent":
      return formatPercent(value)
    case "bytes":
      return formatBytes(value)
    case "bytes-per-second":
      return formatBytesPerSec(value)
    case "count":
      return formatCount(value)
    case "ms":
      return formatMs(value)
    case "fps":
      return `${Math.round(Math.max(0, value))} fps`
  }
}

/**
 * Metric schema version every current source publishes
 * (`PerfSourceDescriptor.metricSchemaVersion`: Renderer, Node host and the
 * Rust sampler all emit 1). Budgets pin it so a future schema change makes
 * old budgets incomparable instead of silently reinterpreted.
 */
export const PERF_METRIC_SCHEMA_VERSION = 1

/**
 * Input scale for entering a threshold in a form: bytes are typed in MB
 * (binary), everything else in its own unit. `toUnit(fromUnit(x)) === x`.
 */
export function thresholdInputScale(unit: PerfMetricUnit): number {
  return unit === "bytes" || unit === "bytes-per-second" ? 1024 * 1024 : 1
}
