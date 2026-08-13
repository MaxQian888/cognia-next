/** @jest-environment node */
import "fake-indexeddb/auto"
import { CogniaDB } from "@/lib/db/schema"
import { buildCogniaPerfPackage } from "./package-format"
import { importPerformanceCapture, preparePerformanceRawExport } from "./capture-portability"
import { PerformanceQuotaManager } from "./quota"
import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { PERF_WIRE_VERSION, type PerfFrame } from "./backend/types"

const frame: PerfFrame = {
  wireVersion: PERF_WIRE_VERSION,
  sourceId: "renderer:source",
  targetId: "origin-target",
  routingGeneration: 8,
  hostInstanceId: "document",
  samplingSessionId: "session",
  sequence: 1,
  requestedIntervalMs: 1000,
  actualIntervalMs: 1000,
  monotonicElapsedMs: 1000,
  wallStartMs: 100,
  wallEndMs: 1100,
  collectionDurationMs: 1,
  missedTicks: 0,
  flags: { reset: true, discontinuity: false, counterReset: false, sourceRestarted: true },
  tsMs: 1100,
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

it("imports through an invisible row and exposes only the final ready provenance", async () => {
  const db = new CogniaDB(`perf-portability-${crypto.randomUUID()}`)
  const registry = new CogniaAccountRegistryDB()
  const quota = new PerformanceQuotaManager(registry)
  const packageBytes = await buildCogniaPerfPackage({
    capture: {
      originalId: "origin-capture",
      digest: "a".repeat(64),
      wireVersion: 1,
      metricSchemaVersion: 1,
      sourceKind: "renderer",
    },
    redactionMode: "redacted",
    producerFingerprint: "producer",
    issuedAt: "2026-08-13T00:00:00.000Z",
    entries: [
      {
        path: "samples/000000.json",
        contentType: "application/vnd.cognia.perf-frames+json",
        bytes: new TextEncoder().encode(JSON.stringify([frame])),
      },
    ],
  })
  const id = await importPerformanceCapture({
    db,
    quota,
    accountId: "account-a",
    targetDatabase: db.name,
    targetId: "destination-target",
    key: crypto.getRandomValues(new Uint8Array(32)),
    packageBytes,
    now: 2_000,
  })
  expect(id).not.toBe("origin-capture")
  expect(await db.performanceCaptures.get(id)).toMatchObject({
    status: "ready",
    targetId: "destination-target",
    originalCaptureId: "origin-capture",
    originalDigest: "a".repeat(64),
    trustState: "origin-unverified",
    frameCount: 1,
  })
  expect(await db.performanceCaptureChunks.where("captureId").equals(id).count()).toBe(1)
  expect(await quota.usage("account-a")).toBeGreaterThan(0)
  quota.close()
  await db.delete()
  await registry.delete()
})

it("rejects malformed frame payloads before exposing any capture row", async () => {
  const db = new CogniaDB(`perf-portability-invalid-${crypto.randomUUID()}`)
  const registry = new CogniaAccountRegistryDB()
  const quota = new PerformanceQuotaManager(registry)
  const packageBytes = await buildCogniaPerfPackage({
    capture: {
      originalId: "bad",
      digest: "b".repeat(64),
      wireVersion: 1,
      metricSchemaVersion: 1,
      sourceKind: "renderer",
    },
    redactionMode: "redacted",
    producerFingerprint: "producer",
    issuedAt: "2026-08-13T00:00:00.000Z",
    entries: [
      {
        path: "samples/000000.json",
        contentType: "application/vnd.cognia.perf-frames+json",
        bytes: new TextEncoder().encode(JSON.stringify([{ sequence: 1 }])),
      },
    ],
  })
  await expect(
    importPerformanceCapture({
      db,
      quota,
      accountId: "account-b",
      targetDatabase: db.name,
      targetId: "destination-target",
      key: crypto.getRandomValues(new Uint8Array(32)),
      packageBytes,
    })
  ).rejects.toThrow(/frame-schema-invalid/)
  expect(await db.performanceCaptures.count()).toBe(0)
  expect(await quota.usage("account-b")).toBe(0)
  quota.close()
  await db.delete()
  await registry.delete()
})

it("binds raw export confirmation to the capture digest and explicit attachments", async () => {
  const db = new CogniaDB(`perf-portability-raw-${crypto.randomUUID()}`)
  await db.performanceCaptures.put({
    id: "capture-a",
    status: "ready",
    purpose: "capture",
    sourceKind: "renderer",
    sourceId: "renderer:source",
    hostInstanceId: "document",
    targetId: "target-a",
    routingGeneration: 1,
    wireVersion: 1,
    metricSchemaVersion: 1,
    capabilityBits: "renderer.fps",
    startedAt: 1,
    updatedAt: 2,
    pinned: 0,
    payloadBytes: 10,
    attachmentBytes: 20,
    frameCount: 1,
    gapCount: 0,
    digest: "c".repeat(64),
  })
  await db.performanceCaptureAttachments.put({
    id: "attachment-a",
    captureId: "capture-a",
    ordinal: 3,
    byteCount: 20,
    contentType: "application/octet-stream",
    iv: new ArrayBuffer(12),
    ciphertext: new ArrayBuffer(20),
    digest: "d".repeat(64),
  })

  const withoutAttachment = await preparePerformanceRawExport({ db, captureId: "capture-a" })
  const withAttachment = await preparePerformanceRawExport({
    db,
    captureId: "capture-a",
    attachmentIds: ["attachment-a"],
  })
  expect(withAttachment.manifestDigest).toBe("c".repeat(64))
  expect(withAttachment.attachmentIds).toEqual(["attachment-a"])
  expect(withAttachment.confirmation).not.toBe(withoutAttachment.confirmation)

  await expect(
    preparePerformanceRawExport({
      db,
      captureId: "capture-a",
      attachmentIds: ["other-capture-attachment"],
    })
  ).rejects.toThrow("performance-capture-attachment-invalid")
  await db.delete()
})
