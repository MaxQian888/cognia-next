/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { CogniaDB } from "@/lib/db/schema"
import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { PERF_WIRE_VERSION, type PerfFrame, type PerfSourceDescriptor } from "./backend/types"
import { PerformanceCaptureSession } from "./capture-service"
import { PerformanceQuotaManager } from "./quota"
import {
  __resetPerformanceSecurityGenerationForTests,
  bumpPerformanceSecurityGeneration,
} from "./security-generation"

jest.setTimeout(30_000)

const source: PerfSourceDescriptor = {
  wireVersion: PERF_WIRE_VERSION,
  sourceId: "renderer:doc-a",
  kind: "renderer",
  hostInstanceId: "doc-a",
  runtimeKind: "browser",
  build: { version: "1", commit: null, profile: "development" },
  metricSchemaVersion: 1,
  capabilities: ["renderer.fps"],
  clock: { kind: "performance-time-origin", originWallMs: 0 },
  connection: { state: "live", changedAtMs: 0, detail: null },
}

function frame(sequence: number): PerfFrame {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: source.sourceId,
    targetId: "target-a",
    routingGeneration: 1,
    hostInstanceId: source.hostInstanceId,
    samplingSessionId: "session-a",
    sequence,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1000,
    monotonicElapsedMs: 1000,
    wallStartMs: sequence * 1000,
    wallEndMs: sequence * 1000 + 1000,
    collectionDurationMs: 1,
    missedTicks: 0,
    flags: { reset: false, discontinuity: false, counterReset: false, sourceRestarted: false },
    tsMs: sequence * 1000 + 1000,
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
  }
}

describe("PerformanceCaptureSession", () => {
  let db: CogniaDB
  let registryDb: CogniaAccountRegistryDB
  let quota: PerformanceQuotaManager

  beforeEach(async () => {
    __resetPerformanceSecurityGenerationForTests()
    ;(globalThis as { __COGNIA_DB_FULL_SCHEMA__?: boolean }).__COGNIA_DB_FULL_SCHEMA__ = true
    db = new CogniaDB(`perf-capture-${crypto.randomUUID()}`)
    await db.open()
    registryDb = new CogniaAccountRegistryDB(`perf-registry-${crypto.randomUUID()}`)
    await registryDb.open()
    quota = new PerformanceQuotaManager(registryDb)
  })

  afterEach(async () => {
    delete (globalThis as { __COGNIA_DB_FULL_SCHEMA__?: boolean }).__COGNIA_DB_FULL_SCHEMA__
    db?.close()
    quota?.close()
    await db?.delete()
    await registryDb?.delete()
  })

  // Typed parameters, not just defaults: a `jest.fn()` default makes the
  // parameter type `jest.Mock`, which then rejects the plain callbacks some
  // cases pass.
  async function start(onDemandEnd: () => void = jest.fn(), onStopped: () => void = jest.fn()) {
    return PerformanceCaptureSession.start({
      accountId: "account-a",
      targetDatabase: db.name,
      targetId: "target-a",
      routingGeneration: 1,
      source,
      requestedCadenceMs: 1000,
      key: crypto.getRandomValues(new Uint8Array(32)),
      db,
      quota,
      // The seam is a single call shape now, so the stub only has to return a
      // handle-shaped value rather than impersonate the overloaded global.
      setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: jest.fn(),
      onDemandEnd,
      onStopped,
    })
  }

  it("flushes 64 frames into one encrypted chunk under a quota reservation", async () => {
    const session = await start()
    for (let sequence = 1; sequence <= 64; sequence += 1) await session.append(frame(sequence))
    const chunks = await db.performanceCaptureChunks.where("captureId").equals(session.id).toArray()
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ frameCount: 64, firstSequence: 1, lastSequence: 64 })
    // fake-indexeddb crosses a VM realm and projects ArrayBuffer as `{}`;
    // byteCount is the authoritative persisted binary envelope size here.
    expect(chunks[0]).toHaveProperty("ciphertext")
    expect(chunks[0].byteCount).toBeGreaterThan(0)
    const capture = await db.performanceCaptures.get(session.id)
    expect(capture?.frameCount).toBe(64)
    expect(capture?.metadataByteCount).toBeGreaterThan(0)
    expect(capture?.environmentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(capture).not.toHaveProperty("environmentSnapshot")
    expect(capture).not.toHaveProperty("build")
    expect(await quota.usage("account-a")).toBe(capture?.payloadBytes)
    await session.stop()
  })

  it("discards the unencrypted tail and finalizes structurally when the account locks", async () => {
    const onDemandEnd = jest.fn()
    const onStopped = jest.fn()
    const session = await start(onDemandEnd, onStopped)
    await session.append(frame(1))
    bumpPerformanceSecurityGeneration("account-a", "account-locked", 50)
    await Promise.resolve()
    expect(await db.performanceCaptureChunks.count()).toBe(0)
    expect(await db.performanceCaptures.get(session.id)).toMatchObject({
      status: "ready",
      stopReason: "account-locked",
      stoppedAt: 50,
    })
    expect(onDemandEnd).toHaveBeenCalled()
    expect(onStopped).toHaveBeenCalledTimes(1)
  })

  it("notifies final completion only after the tail is persisted", async () => {
    const events: string[] = []
    const session = await start(
      () => events.push("demand-ended"),
      () => events.push("stopped")
    )
    await session.append(frame(1))

    await session.stop("duration-limit")

    expect(events).toEqual(["demand-ended", "stopped"])
    expect(await db.performanceCaptureChunks.where("captureId").equals(session.id).count()).toBe(1)
    expect(await db.performanceCaptures.get(session.id)).toMatchObject({
      status: "ready",
      stopReason: "duration-limit",
      frameCount: 1,
    })
  })

  it("finalizes the immutable old-target capture when a late frame crosses target scope", async () => {
    const session = await start()
    await expect(session.append({ ...frame(1), targetId: "target-b" })).rejects.toThrow(
      "performance-capture-target-mismatch"
    )
    expect(await db.performanceCaptures.get(session.id)).toMatchObject({
      status: "ready",
      stopReason: "target-switched",
    })
  })
})
