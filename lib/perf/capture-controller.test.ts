/** @jest-environment jsdom */
import { PerformanceCaptureController } from "./capture-controller"
import { PERF_WIRE_VERSION, type PerfFrame, type PerfSourceDescriptor } from "./backend/types"

const rendererListeners = new Set<(frame: PerfFrame) => void>()
const closeDemand = jest.fn()
const mockSource: PerfSourceDescriptor = {
  wireVersion: PERF_WIRE_VERSION,
  sourceId: "renderer:doc",
  kind: "renderer",
  hostInstanceId: "doc",
  runtimeKind: "browser",
  build: { version: "test", commit: null, profile: "development" },
  metricSchemaVersion: 1,
  capabilities: ["renderer.fps"],
  clock: { kind: "performance-time-origin", originWallMs: 0 },
  connection: { state: "live", changedAtMs: 0, detail: null },
}

jest.mock("./renderer-collector", () => ({
  getRendererPerformanceCollector: () => ({
    source: mockSource,
    setScope: jest.fn(),
    openDemand: jest.fn(() => "demand"),
    closeDemand,
    subscribe: (listener: (frame: PerfFrame) => void) => {
      rendererListeners.add(listener)
      return () => rendererListeners.delete(listener)
    },
  }),
}))

const frame = (sequence: number): PerfFrame => ({
  wireVersion: PERF_WIRE_VERSION,
  sourceId: mockSource.sourceId,
  targetId: "target-a",
  routingGeneration: 4,
  hostInstanceId: mockSource.hostInstanceId,
  samplingSessionId: "session",
  sequence,
  requestedIntervalMs: 1000,
  actualIntervalMs: 1000,
  monotonicElapsedMs: 1000,
  wallStartMs: sequence * 1000,
  wallEndMs: sequence * 1000 + 1000,
  collectionDurationMs: 2,
  missedTicks: 0,
  flags: {
    reset: sequence === 1,
    discontinuity: false,
    counterReset: false,
    sourceRestarted: false,
  },
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
})

describe("PerformanceCaptureController", () => {
  beforeEach(() => {
    rendererListeners.clear()
    closeDemand.mockClear()
  })

  it("keeps an explicit capture alive independently of the performance page consumer", async () => {
    const session = {
      id: "capture-a",
      append: jest.fn().mockResolvedValue(undefined),
      appendGap: jest.fn().mockResolvedValue(undefined),
    }
    const coordinator = {
      start: jest.fn().mockResolvedValue(session),
      stop: jest.fn().mockResolvedValue(undefined),
    }
    const quota = { close: jest.fn() }
    const controller = new PerformanceCaptureController({
      getDb: () => ({ name: "target-db" }) as never,
      getScope: () => ({ accountId: "account-a", targetId: "target-a", routingGeneration: 4 }),
      getAccountId: () => "account-a",
      loadKey: async () => new Uint8Array(32),
      createQuota: () => quota as never,
      coordinator: () => coordinator as never,
      now: () => 123,
    })

    await expect(controller.start({ sourceKind: "renderer", cadenceMs: 1000 })).resolves.toBe(
      "capture-a"
    )
    rendererListeners.forEach((listener) => listener(frame(1)))
    await Promise.resolve()
    expect(session.append).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }))
    expect(controller.snapshot).toMatchObject({ active: true, captureId: "capture-a" })

    await controller.stop()
    expect(coordinator.stop).toHaveBeenCalledWith("manual")
    expect(closeDemand).toHaveBeenCalledWith("demand")
    expect(quota.close).toHaveBeenCalled()
    controller.dispose()
  })

  it("records a visible gap and never coerces the missing interval to zero", async () => {
    const session = {
      id: "capture-gap",
      append: jest.fn().mockResolvedValue(undefined),
      appendGap: jest.fn().mockResolvedValue(undefined),
    }
    const controller = new PerformanceCaptureController({
      getDb: () => ({ name: "target-db" }) as never,
      getScope: () => ({ accountId: "account-a", targetId: "target-a", routingGeneration: 4 }),
      getAccountId: () => "account-a",
      loadKey: async () => new Uint8Array(32),
      createQuota: () => ({ close: jest.fn() }) as never,
      coordinator: () => ({ start: async () => session, stop: jest.fn() }) as never,
      now: Date.now,
    })
    await controller.start({ sourceKind: "renderer", cadenceMs: 1000 })
    rendererListeners.forEach((listener) => listener(frame(1)))
    rendererListeners.forEach((listener) => listener(frame(3)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.appendGap).toHaveBeenCalledWith(
      expect.objectContaining({ sequenceStart: 2, sequenceEnd: 2, recoverable: false })
    )
    expect(session.append).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it("publishes inactive state when the session ends automatically", async () => {
    const session = {
      id: "capture-auto-stop",
      append: jest.fn().mockResolvedValue(undefined),
      appendGap: jest.fn().mockResolvedValue(undefined),
    }
    let onDemandEnd: (() => void) | undefined
    let onStopped: (() => void) | undefined
    const coordinator = {
      start: jest.fn(async (options: { onDemandEnd?: () => void; onStopped?: () => void }) => {
        onDemandEnd = options.onDemandEnd
        onStopped = options.onStopped
        return session
      }),
      stop: jest.fn().mockResolvedValue(undefined),
    }
    const quota = { close: jest.fn() }
    const controller = new PerformanceCaptureController({
      getDb: () => ({ name: "target-db" }) as never,
      getScope: () => ({ accountId: "account-a", targetId: "target-a", routingGeneration: 4 }),
      getAccountId: () => "account-a",
      loadKey: async () => new Uint8Array(32),
      createQuota: () => quota as never,
      coordinator: () => coordinator as never,
      now: () => 123,
    })

    await controller.start({ sourceKind: "renderer", cadenceMs: 1000 })
    onDemandEnd?.()

    expect(controller.snapshot.active).toBe(false)
    expect(closeDemand).toHaveBeenCalledWith("demand")
    expect(quota.close).not.toHaveBeenCalled()
    await expect(controller.start({ sourceKind: "renderer", cadenceMs: 1000 })).rejects.toThrow(
      "already-active"
    )
    onStopped?.()
    expect(quota.close).toHaveBeenCalled()
    await expect(controller.start({ sourceKind: "renderer", cadenceMs: 1000 })).resolves.toBe(
      "capture-auto-stop"
    )
    controller.dispose()
  })
})
