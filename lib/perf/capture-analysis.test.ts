import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfSourceDescriptor,
  type PerfSourceKind,
} from "./backend/types"
import type { PerformanceBudgetProfile } from "./budget-service"
import type { PerformanceCaptureRow } from "./capture-types"
import {
  captureCadenceMs,
  compareCaptures,
  evaluateCaptureAgainstBudget,
  expectedIntervals,
  readDecodedCapture,
  type DecodedCapture,
} from "./capture-analysis"
import { getPerfMetric } from "./metric-catalog"

const readFramesMock = jest.fn()
const readMetadataMock = jest.fn()
jest.mock("./capture-portability", () => ({
  readPerformanceCaptureFrames: (...args: unknown[]) => readFramesMock(...args),
  readPerformanceCaptureMetadata: (...args: unknown[]) => readMetadataMock(...args),
}))

function frame(index: number, fps: number | null, overrides: Partial<PerfFrame> = {}): PerfFrame {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: "renderer:doc",
    targetId: "t",
    routingGeneration: 0,
    hostInstanceId: "doc",
    samplingSessionId: "session",
    sequence: index + 1,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1000,
    monotonicElapsedMs: 1000,
    wallStartMs: index * 1000,
    wallEndMs: (index + 1) * 1000,
    collectionDurationMs: 1,
    missedTicks: 0,
    flags: { reset: false, discontinuity: false, counterReset: false, sourceRestarted: false },
    tsMs: (index + 1) * 1000,
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
    observations: { "renderer.fps": fps },
    ...overrides,
  }
}

function row(id: string, frames: number, overrides: Partial<PerformanceCaptureRow> = {}) {
  return {
    id,
    status: "ready",
    purpose: "capture",
    sourceKind: "renderer" as PerfSourceKind,
    sourceId: "renderer:doc",
    hostInstanceId: "doc",
    targetId: "t",
    routingGeneration: 0,
    wireVersion: 1,
    metricSchemaVersion: 1,
    capabilityBits: "",
    startedAt: 0,
    updatedAt: frames * 1000,
    stoppedAt: frames * 1000,
    pinned: 0,
    payloadBytes: 0,
    attachmentBytes: 0,
    frameCount: frames,
    gapCount: 0,
    environmentDigest: "env-a",
    ...overrides,
  } satisfies PerformanceCaptureRow
}

function capture(
  id: string,
  values: (number | null)[],
  overrides: Partial<PerformanceCaptureRow> = {},
  metadata: DecodedCapture["metadata"] = {
    // Only the fields budget applicability reads.
    source: {
      runtimeKind: "browser",
      build: { profile: "production" },
    } as PerfSourceDescriptor,
    requestedCadenceMs: 1000,
    environment: null,
    budget: null,
  }
): DecodedCapture {
  return {
    row: row(id, values.length, overrides),
    frames: values.map((value, index) => frame(index, value)),
    metadata,
  }
}

const fps = getPerfMetric("renderer.fps")!

function budget(overrides: Partial<PerformanceBudgetProfile> = {}): PerformanceBudgetProfile {
  return {
    id: "b",
    name: "Smooth",
    version: 1,
    immutable: true,
    metricId: "renderer.fps",
    metricDefinitionVersion: 1,
    unit: "fps",
    sourceKind: "renderer",
    metricSchemaVersion: 1,
    requestedCadenceMs: 1000,
    aggregation: "median",
    direction: "higher",
    warningThreshold: 50,
    failureThreshold: 30,
    applicability: { runtimeKinds: ["browser"], buildProfiles: ["production"] },
    comparisonWindow: "interval",
    createdAt: 0,
    ...overrides,
  }
}

const steady = (value: number, count = 20) => Array.from({ length: count }, () => value)

describe("capture analysis", () => {
  it("derives cadence from metadata, else frames, and expected intervals from duration", () => {
    const decoded = capture("a", steady(60, 5))
    expect(captureCadenceMs(decoded)).toBe(1000)
    expect(captureCadenceMs({ ...decoded, metadata: null })).toBe(1000)
    // 10 s at 1 s cadence, though only 5 frames arrived.
    expect(expectedIntervals({ ...decoded, row: { ...decoded.row, stoppedAt: 10_000 } })).toBe(10)
  })

  it("compares like-for-like captures and reports the statistics", () => {
    const result = compareCaptures(capture("a", steady(60)), capture("b", steady(45)), fps)
    expect(result.eligibility.eligible).toBe(true)
    expect(result.comparison.baseline.median).toBe(60)
    expect(result.comparison.candidate.median).toBe(45)
    expect(result.comparison.absoluteDelta).toBe(-15)
  })

  it("keeps the statistics but lists why a pair is not comparable", () => {
    const short = capture("a", steady(60, 5))
    const reloaded = capture("b", steady(45))
    reloaded.frames[10] = { ...reloaded.frames[10], hostInstanceId: "doc-2" }
    const otherEnv = { ...reloaded, row: { ...reloaded.row, environmentDigest: "env-b" } }
    const result = compareCaptures(short, otherEnv, fps)
    expect(result.eligibility.eligible).toBe(false)
    expect(result.eligibility.reasons).toEqual(
      expect.arrayContaining([
        "minimum-valid-intervals",
        "discontinuous-incarnation",
        "environment-mismatch",
      ])
    )
    expect(result.comparison.candidate.median).toBe(45)
    expect(
      compareCaptures(short, otherEnv, fps, { environmentMismatchAccepted: true }).eligibility
        .reasons
    ).not.toContain("environment-mismatch")
  })

  it("counts unmeasured intervals as invalid, not as zeros", () => {
    const gappy = capture("b", [...steady(45, 15), null, null, null, null, null])
    const result = compareCaptures(capture("a", steady(60)), gappy, fps)
    expect(result.candidate.validIntervals).toBe(15)
    expect(result.comparison.candidate.median).toBe(45)
    expect(result.eligibility.reasons).toContain("minimum-coverage")
  })

  it("returns pass / warn / fail against an applicable budget", () => {
    expect(evaluateCaptureAgainstBudget(capture("a", steady(58)), budget()).verdict).toBe("pass")
    expect(evaluateCaptureAgainstBudget(capture("a", steady(40)), budget()).verdict).toBe("warn")
    const fail = evaluateCaptureAgainstBudget(capture("a", steady(20)), budget())
    expect(fail).toMatchObject({ verdict: "fail", value: 20, validIntervals: 20 })
  })

  it("refuses a verdict on too little data, a mismatch or a foreign environment", () => {
    expect(evaluateCaptureAgainstBudget(capture("a", steady(58, 5)), budget())).toMatchObject({
      verdict: "insufficient-data",
      reason: "minimum-valid-intervals",
    })
    expect(
      evaluateCaptureAgainstBudget(capture("a", steady(58)), budget({ requestedCadenceMs: 2000 }))
    ).toMatchObject({ verdict: "incomparable", reason: "metadata-mismatch" })
    const devBudget = budget({
      applicability: { runtimeKinds: ["browser"], buildProfiles: ["development"] },
    })
    expect(evaluateCaptureAgainstBudget(capture("a", steady(58)), devBudget)).toMatchObject({
      verdict: "incomparable",
      reason: "environment-mismatch",
      environmentMatches: false,
    })
    expect(
      evaluateCaptureAgainstBudget(capture("a", steady(58)), devBudget, {
        environmentMismatchAccepted: true,
      }).verdict
    ).toBe("pass")
    expect(
      evaluateCaptureAgainstBudget(capture("a", steady(58)), budget({ metricId: "gone" }))
    ).toMatchObject({ verdict: "incomparable", reason: "unknown-metric" })
  })

  it("decodes a stored capture only when it exists and is ready", async () => {
    const stored = row("a", 3)
    const get = jest.fn(async (id: string) =>
      id === "a" ? stored : id === "recording" ? { ...stored, status: "recording" } : undefined
    )
    const db = { performanceCaptures: { get } } as never
    readFramesMock.mockResolvedValue([frame(0, 60)])
    readMetadataMock.mockResolvedValue(null)
    const input = { db, accountId: "acc", targetDatabase: "db", key: new Uint8Array(32) }
    await expect(readDecodedCapture({ ...input, captureId: "a" })).resolves.toEqual({
      row: stored,
      frames: [frame(0, 60)],
      metadata: null,
    })
    await expect(readDecodedCapture({ ...input, captureId: "missing" })).rejects.toThrow(
      "performance-capture-not-found"
    )
    await expect(readDecodedCapture({ ...input, captureId: "recording" })).rejects.toThrow(
      "performance-capture-not-ready"
    )
  })
})
