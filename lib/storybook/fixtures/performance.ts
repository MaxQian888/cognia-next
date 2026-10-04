// Storybook-only fixtures for the Rust performance dashboard
// (`components/performance/**`). These mirror the serde structs the live
// `usePerfStream` sampler emits; the components take them as plain props, so a
// realistic in-memory history is all a story needs. Dependency-free (types).
import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfSample,
  type PerfSourceDescriptor,
  type PerfSourceKind,
  type ProcessSample,
  type RuntimeSample,
  type SpanSnapshot,
  type SystemMemory,
} from "@/lib/perf/backend/types"

const MB = 1024 * 1024

/** Smooth-ish wave for trend series so sparklines/graphs look alive. */
export function wave(n: number, base: number, amp: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Math.max(0, base + amp * (0.5 + 0.5 * Math.sin(i / 3)))
  )
}

export function makeProcess(over: Partial<ProcessSample> = {}): ProcessSample {
  return {
    pid: 1000,
    parentPid: null,
    name: "cognia",
    role: "main",
    cpuPct: 24,
    cpuPctRaw: 96,
    memBytes: 540 * MB,
    diskReadBps: 120 * 1024,
    diskWriteBps: 64 * 1024,
    runSecs: 3600,
    ...over,
  }
}

export function makeRuntime(over: Partial<RuntimeSample> = {}): RuntimeSample {
  return {
    workers: 8,
    aliveTasks: 42,
    globalQueueDepth: 3,
    blockingThreads: 2,
    blockingQueueDepth: 0,
    spawnedTasksCount: 12_840,
    budgetForcedYieldCount: 31,
    workerStealCount: 980,
    workerParkCount: 4500,
    workerOverflowCount: 2,
    busyPct: 37,
    perWorkerBusyPct: [62, 41, 58, 22, 35, 18, 49, 27],
    ...over,
  }
}

export function makeMemory(over: Partial<SystemMemory> = {}): SystemMemory {
  return { totalBytes: 16 * 1024 * MB, usedBytes: 9 * 1024 * MB, ...over }
}

export function makeSpan(name: string, over: Partial<SpanSnapshot> = {}): SpanSnapshot {
  return {
    name,
    count: 120,
    errorCount: 0,
    totalMs: 1450,
    avgMs: 12,
    minMs: 1,
    maxMs: 95,
    p50Ms: 9,
    p95Ms: 48,
    lastTsMs: 0,
    buckets: [2, 8, 22, 36, 19, 9, 4, 1, 0, 0],
    ...over,
  }
}

export const SAMPLE_SPANS: SpanSnapshot[] = [
  makeSpan("db.query.messages", { totalMs: 4200, count: 320, avgMs: 13, p95Ms: 60, maxMs: 210 }),
  makeSpan("vector.search", { totalMs: 2600, count: 48, avgMs: 54, p95Ms: 120, errorCount: 2 }),
  makeSpan("llm.generate", { totalMs: 1800, count: 12, avgMs: 150, p95Ms: 320, maxMs: 800 }),
  makeSpan("ipc.invoke", { totalMs: 640, count: 540, avgMs: 1.2, p95Ms: 4 }),
]

/** A composed frame at index `i` of a synthetic run. */
function makeSample(i: number): PerfSample {
  const t = 1_700_000_000_000 + i * 1000
  return {
    tsMs: t,
    intervalMs: 1000,
    processes: [
      makeProcess({
        pid: 1000,
        role: "main",
        name: "cognia",
        cpuPct: 18 + 24 * (0.5 + 0.5 * Math.sin(i / 4)),
        memBytes: (520 + i * 2) * MB,
      }),
      makeProcess({
        pid: 1042,
        parentPid: 1000,
        role: "sidecar",
        name: "claude-host.mjs",
        cpuPct: 6 + 10 * (0.5 + 0.5 * Math.sin(i / 5 + 1)),
        memBytes: (180 + i) * MB,
        runSecs: 3200,
      }),
      makeProcess({
        pid: 1099,
        parentPid: 1000,
        role: "child",
        name: "ripgrep",
        cpuPct: 2,
        memBytes: 24 * MB,
        runSecs: 4,
      }),
    ],
    runtime: makeRuntime({
      busyPct: 30 + 30 * (0.5 + 0.5 * Math.sin(i / 4)),
      aliveTasks: 38 + (i % 7),
      perWorkerBusyPct: [62, 41, 58, 22, 35, 18, 49, 27].map((v) =>
        Math.min(100, v + 8 * Math.sin(i / 3))
      ),
    }),
    topSpans: SAMPLE_SPANS,
    systemMemory: makeMemory({ usedBytes: (8.5 * 1024 + i * 4) * MB }),
    managed: [],
  }
}

/** A rolling window of composed frames (oldest → newest). */
export function makeHistory(n = 40): PerfSample[] {
  return Array.from({ length: n }, (_, i) => makeSample(i))
}

const HOST_CAPABILITIES = [
  "host.processes",
  "host.system-memory-utilization",
  "runtime.tokio",
  "runtime.dial9",
  "host.managed-processes",
  "host.traces",
]
const RENDERER_CAPABILITIES = [
  "renderer.fps",
  "renderer.long-task",
  "renderer.user-timing",
  "renderer.chat-latency",
  "renderer.js-heap",
]

/** A source descriptor as `usePerfStream().sources` lists it. */
export function makeSource(kind: PerfSourceKind, capabilities?: string[]): PerfSourceDescriptor {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: `${kind}:story`,
    kind,
    hostInstanceId: `${kind}-story`,
    runtimeKind: kind === "host" ? "tauri-rust" : "browser",
    build: { version: "0.0.0-story", commit: null, profile: "development" },
    metricSchemaVersion: 1,
    capabilities: capabilities ?? (kind === "host" ? HOST_CAPABILITIES : RENDERER_CAPABILITIES),
    clock: { kind: "performance-time-origin", originWallMs: 0 },
    connection: { state: "live", changedAtMs: 0, detail: null },
  }
}

/** Versioned frames for a source, built on {@link makeHistory}. */
export function makeFrames(kind: PerfSourceKind, n = 40): PerfFrame[] {
  const fps = wave(n, 48, 12)
  const blocked = wave(n, 2, 18)
  return makeHistory(n).map((sample, index) => {
    const wallEndMs = 1_700_000_000_000 + index * 1000
    const base = {
      ...sample,
      wireVersion: PERF_WIRE_VERSION,
      sourceId: `${kind}:story`,
      targetId: "story",
      routingGeneration: 0,
      hostInstanceId: `${kind}-story`,
      samplingSessionId: "story-session",
      sequence: index + 1,
      requestedIntervalMs: 1000,
      actualIntervalMs: 1000,
      monotonicElapsedMs: 1000,
      wallStartMs: wallEndMs - 1000,
      wallEndMs,
      collectionDurationMs: 2,
      missedTicks: 0,
      flags: {
        reset: index === 0,
        discontinuity: false,
        counterReset: false,
        sourceRestarted: false,
      },
    }
    if (kind === "host") return base
    return {
      ...base,
      processes: [],
      topSpans: [],
      systemMemory: null,
      managed: [],
      observations: {
        "renderer.fps": fps[index],
        "renderer.main-thread-blocked.pct": blocked[index],
        "renderer.long-task.count": Math.round(blocked[index] / 5),
        "renderer.js-heap.used.bytes": (80 + (index % 10)) * MB,
      },
    }
  })
}
