import en from "@/i18n/messages/en/performance.json"
import zh from "@/i18n/messages/zh-CN/performance.json"
import { PERF_WIRE_VERSION, type PerfFrame, type PerfSourceDescriptor } from "./backend/types"
import {
  formatPerfMetricValue,
  getPerfMetric,
  isPerfMetricId,
  isValidInterval,
  metricIntervals,
  metricSeries,
  metricsForSource,
  metricsForSourceKind,
  PERF_METRICS,
  sourceSupportsMetric,
  summarizeSeries,
  thresholdInputScale,
} from "./metric-catalog"

function frame(overrides: Partial<PerfFrame> = {}): PerfFrame {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: "s",
    targetId: "t",
    routingGeneration: 0,
    hostInstanceId: "h",
    samplingSessionId: "session",
    sequence: 1,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1000,
    monotonicElapsedMs: 1000,
    wallStartMs: 0,
    wallEndMs: 1000,
    collectionDurationMs: 1,
    missedTicks: 0,
    flags: { reset: false, discontinuity: false, counterReset: false, sourceRestarted: false },
    tsMs: 1000,
    intervalMs: 1000,
    processes: [],
    runtime: {
      workers: 0,
      aliveTasks: 0,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: 0,
      perWorkerBusyPct: [],
    },
    topSpans: [],
    systemMemory: null,
    managed: [],
    ...overrides,
  }
}

function source(
  kind: PerfSourceDescriptor["kind"],
  runtimeKind: PerfSourceDescriptor["runtimeKind"],
  capabilities: string[]
): Pick<PerfSourceDescriptor, "kind" | "runtimeKind" | "capabilities"> {
  return { kind, runtimeKind, capabilities }
}

describe("metric catalog", () => {
  it("has unique ids and a label and description in both locales for every metric", () => {
    expect(new Set(PERF_METRICS.map((metric) => metric.id)).size).toBe(PERF_METRICS.length)
    for (const metric of PERF_METRICS) {
      expect(en.metrics).toHaveProperty(metric.labelKey)
      expect(zh.metrics).toHaveProperty(metric.labelKey)
      expect(en.metricDescriptions).toHaveProperty(metric.labelKey)
      expect(zh.metricDescriptions).toHaveProperty(metric.labelKey)
    }
  })

  it("looks metrics up by id", () => {
    expect(getPerfMetric("renderer.fps")?.unit).toBe("fps")
    expect(getPerfMetric("nope")).toBeNull()
    expect(isPerfMetricId("host.main.cpu-pct")).toBe(true)
    expect(isPerfMetricId("host.main.cpu")).toBe(false)
  })

  it("offers a metric only when the source advertises every capability it needs", () => {
    const rust = source("host", "tauri-rust", ["host.processes", "runtime.tokio"])
    const node = source("host", "node-headless", [
      "host.processes",
      "runtime.node-heap",
      "runtime.node-event-loop",
    ])
    expect(metricsForSource(rust).map((metric) => metric.id)).toEqual([
      "host.main.cpu-pct",
      "host.main.memory-bytes",
      "host.disk.bytes-per-second",
      "host.runtime.busy-pct",
      "host.runtime.alive-tasks",
    ])
    // The Node host has no Tokio runtime and hard-codes zero disk rates.
    expect(metricsForSource(node).map((metric) => metric.id)).toEqual([
      "host.main.cpu-pct",
      "host.main.memory-bytes",
      "node.event-loop.utilization-pct",
      "node.event-loop.delay-p95-ms",
      "node.heap.used-bytes",
    ])
    // A renderer source never matches a host metric and vice versa.
    expect(
      sourceSupportsMetric(
        source("renderer", "browser", ["host.processes"]),
        getPerfMetric("host.main.cpu-pct")!
      )
    ).toBe(false)
    expect(metricsForSource(null)).toEqual([])
  })

  it("lists every metric for a source kind", () => {
    expect(
      metricsForSourceKind("renderer").every((metric) => metric.sourceKind === "renderer")
    ).toBe(true)
    expect(metricsForSourceKind("renderer").length).toBeGreaterThan(0)
  })

  it("extracts null for an unmeasured interval instead of a zero", () => {
    const cpu = getPerfMetric("host.main.cpu-pct")!
    const fps = getPerfMetric("renderer.fps")!
    const disk = getPerfMetric("host.disk.bytes-per-second")!
    const withMain = frame({
      processes: [
        {
          pid: 1,
          parentPid: null,
          name: "app",
          role: "main",
          cpuPct: 12,
          cpuPctRaw: 12,
          memBytes: 5,
          diskReadBps: 3,
          diskWriteBps: 4,
          runSecs: 1,
        },
      ],
      observations: { "renderer.fps": 60 },
    })
    expect(metricSeries([frame(), withMain], cpu)).toEqual([null, 12])
    expect(metricSeries([frame(), withMain], fps)).toEqual([null, 60])
    expect(metricSeries([frame(), withMain], disk)).toEqual([null, 7])
    expect(fps.extract(frame({ observations: { "renderer.fps": Number.NaN } }))).toBeNull()
  })

  it("marks reset, discontinuous, counter-reset and missed-tick frames invalid", () => {
    expect(isValidInterval(frame())).toBe(true)
    expect(isValidInterval(frame({ missedTicks: 1 }))).toBe(false)
    for (const flag of ["reset", "discontinuity", "counterReset"] as const) {
      expect(
        isValidInterval(
          frame({
            flags: {
              reset: false,
              discontinuity: false,
              counterReset: false,
              sourceRestarted: false,
              [flag]: true,
            },
          })
        )
      ).toBe(false)
    }
    const fps = getPerfMetric("renderer.fps")!
    expect(
      metricIntervals([frame({ observations: { "renderer.fps": 30 } }), frame()], fps)
    ).toEqual([
      { value: 30, valid: true },
      { value: null, valid: false },
    ])
  })

  it("summarizes a series ignoring gaps", () => {
    expect(summarizeSeries([1, null, 5, 3])).toEqual({ latest: 3, peak: 5, average: 3, samples: 3 })
    expect(summarizeSeries([null, null])).toEqual({
      latest: null,
      peak: null,
      average: null,
      samples: 0,
    })
  })

  it("formats values per unit and an unmeasured value as a dash", () => {
    expect(formatPerfMetricValue("percent", 42.34)).toBe("42.3%")
    expect(formatPerfMetricValue("bytes", 1024 * 1024)).toBe("1.0 MB")
    expect(formatPerfMetricValue("bytes-per-second", 2048)).toBe("2.0 KB/s")
    expect(formatPerfMetricValue("count", 1500)).toBe("1.5k")
    expect(formatPerfMetricValue("ms", 12.5)).toBe("13 ms")
    expect(formatPerfMetricValue("fps", 59.6)).toBe("60 fps")
    expect(formatPerfMetricValue("fps", null)).toBe("—")
  })

  it("scales byte thresholds to MB for form input", () => {
    expect(thresholdInputScale("bytes")).toBe(1024 * 1024)
    expect(thresholdInputScale("bytes-per-second")).toBe(1024 * 1024)
    expect(thresholdInputScale("percent")).toBe(1)
  })
})
