/** @jest-environment node */

import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfOpenLeaseRequest,
  type PerfOpenLeaseResult,
  type PerfSnapshot,
  type PerfSourceDescriptor,
} from "./backend/types"
import {
  PERF_LEASE_CONTENDED_RETRY_MS,
  PERF_LEASE_HEARTBEAT_MS,
  PerfHostLiveLease,
  isContendedPerfRejection,
  type PerfHostLeaseView,
  type PerfHostLiveLeaseDeps,
} from "./host-live-lease"

const hostSource: PerfSourceDescriptor = {
  wireVersion: PERF_WIRE_VERSION,
  sourceId: "host:one",
  kind: "host",
  hostInstanceId: "boot-a",
  runtimeKind: "tauri-rust",
  build: { version: "1", commit: null, profile: "development" },
  metricSchemaVersion: 1,
  capabilities: ["host.processes"],
  clock: { kind: "host-monotonic", originWallMs: 0 },
  connection: { state: "live", changedAtMs: 0, detail: null },
}

function frame(sequence: number, overrides: Partial<PerfFrame> = {}): PerfFrame {
  return {
    wireVersion: PERF_WIRE_VERSION,
    sourceId: "host:one",
    targetId: "target-a",
    routingGeneration: 0,
    hostInstanceId: "boot-a",
    samplingSessionId: "sampling-a",
    sequence,
    requestedIntervalMs: 1000,
    actualIntervalMs: 1000,
    monotonicElapsedMs: 1000,
    wallStartMs: sequence * 1000,
    wallEndMs: sequence * 1000 + 1000,
    collectionDurationMs: 5,
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
    ...overrides,
  }
}

function snapshotOf(frames: PerfFrame[]): PerfSnapshot {
  return {
    wireVersion: PERF_WIRE_VERSION,
    frames,
    oldestSequence: frames[0]?.sequence ?? null,
    latestSequence: frames.at(-1)?.sequence ?? null,
    sources: [hostSource],
    leases: [],
    gaps: [],
    samples: frames,
    running: true,
    intervalMs: 1000,
  }
}

function accepted(leaseId: string): PerfOpenLeaseResult {
  return {
    accepted: true,
    lease: {
      wireVersion: PERF_WIRE_VERSION,
      leaseId,
      clientId: "renderer:doc-a",
      deviceId: "doc-a",
      targetId: "target-a",
      routingGeneration: 0,
      sourceId: "renderer:doc-a",
      purpose: "live",
      requestedCadenceMs: 1000,
      samplingSessionId: "sampling-a",
      openedAtMs: 0,
      heartbeatAtMs: 0,
      expiresAtMs: 15_000,
    },
    source: hostSource,
  }
}

function harness() {
  let frameHandler: ((frame: PerfFrame) => void) | null = null
  let leaseCounter = 0
  const open = jest.fn<Promise<PerfOpenLeaseResult>, [PerfOpenLeaseRequest]>(async () =>
    accepted(`lease-${++leaseCounter}`)
  )
  const close = jest.fn<Promise<void>, [string]>(async () => undefined)
  const renew = jest.fn<Promise<void>, [string]>(async () => undefined)
  const snapshot = jest.fn<Promise<PerfSnapshot>, [string]>(async () => snapshotOf([frame(1)]))
  const unsubscribeFrames = jest.fn()
  const deps: PerfHostLiveLeaseDeps = {
    open,
    close,
    renew,
    snapshot,
    subscribeFrames: (handler) => {
      frameHandler = handler
      return unsubscribeFrames
    },
    identity: () => ({ clientId: "renderer:doc-a", deviceId: "doc-a", sourceId: "renderer:doc-a" }),
    scope: () => ({ targetId: "target-a", routingGeneration: 0 }),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
  return {
    lease: new PerfHostLiveLease(deps),
    open,
    close,
    renew,
    snapshot,
    unsubscribeFrames,
    emit: (value: PerfFrame) => frameHandler?.(value),
    hasFrameHandler: () => frameHandler !== null,
  }
}

function recorder() {
  const views: PerfHostLeaseView[] = []
  return {
    views,
    onChange: (view: PerfHostLeaseView) => views.push(view),
    last: () => views.at(-1)!,
  }
}

/** Drain the manager's promise chain (and anything it scheduled at 0 ms). */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await jest.advanceTimersByTimeAsync(0)
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe("PerfHostLiveLease", () => {
  it("serves every consumer from ONE lease instead of refusing the second", async () => {
    const h = harness()
    const statusBar = recorder()
    const dashboard = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: statusBar.onChange })
    h.lease.subscribe({ cadenceMs: 1000, onChange: dashboard.onChange })
    await settle()
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(statusBar.last().state).toBe("live")
    expect(dashboard.last().state).toBe("live")
    h.emit(frame(2, { leaseId: "lease-1" }))
    expect(statusBar.last().frames.map((item) => item.sequence)).toEqual([1, 2])
    expect(dashboard.last().frames.map((item) => item.sequence)).toEqual([1, 2])
  })

  it("subscribes to frames before the open so an early frame is merged, not lost", async () => {
    const h = harness()
    let resolveOpen: (value: PerfOpenLeaseResult) => void = () => {}
    h.open.mockReturnValueOnce(new Promise((resolve) => (resolveOpen = resolve)))
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: view.onChange })
    expect(h.hasFrameHandler()).toBe(true)
    h.emit(frame(3))
    resolveOpen(accepted("lease-early"))
    await settle()
    expect(view.last().frames.map((item) => item.sequence)).toEqual([1, 3])
    expect(view.last().gaps[0]).toMatchObject({ sequenceStart: 2, sequenceEnd: 2 })
  })

  it("keeps the lease across an unmount/remount in one commit (StrictMode)", async () => {
    const h = harness()
    const first = h.lease.subscribe({ cadenceMs: 1000, onChange: () => undefined })
    await settle()
    first.unsubscribe()
    h.lease.subscribe({ cadenceMs: 1000, onChange: () => undefined })
    await settle()
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.close).not.toHaveBeenCalled()
  })

  it("closes the lease and the frame channel once the last consumer leaves", async () => {
    const h = harness()
    const only = h.lease.subscribe({ cadenceMs: 1000, onChange: () => undefined })
    await settle()
    only.unsubscribe()
    await settle()
    expect(h.close).toHaveBeenCalledWith("lease-1")
    expect(h.unsubscribeFrames).toHaveBeenCalled()
  })

  it("closes the previous lease BEFORE opening one at a new fastest cadence", async () => {
    const h = harness()
    const order: string[] = []
    h.close.mockImplementation(async (leaseId) => {
      order.push(`close:${leaseId}`)
    })
    h.open.mockImplementation(async (input) => {
      order.push(`open:${input.requestedCadenceMs}`)
      return accepted(`lease-${order.length}`)
    })
    h.lease.subscribe({ cadenceMs: 1000, onChange: () => undefined })
    await settle()
    h.lease.subscribe({ cadenceMs: 500, onChange: () => undefined })
    await settle()
    expect(order).toEqual(["open:1000", "close:lease-1", "open:500"])
  })

  it("down-samples frames to each subscriber's own cadence", async () => {
    const h = harness()
    h.snapshot.mockResolvedValueOnce(snapshotOf([]))
    const fast = recorder()
    const slow = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: fast.onChange })
    h.lease.subscribe({ cadenceMs: 2000, onChange: slow.onChange })
    await settle()
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      h.emit(frame(sequence, { leaseId: "lease-1" }))
    }
    expect(fast.last().frames.map((item) => item.sequence)).toEqual([1, 2, 3, 4])
    expect(slow.last().frames.map((item) => item.sequence)).toEqual([1, 3])
  })

  it("ignores frames addressed to another lease or another target", async () => {
    const h = harness()
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: view.onChange })
    await settle()
    h.emit(frame(2, { leaseId: "capture-lease" }))
    h.emit(frame(3, { targetId: "target-old" }))
    expect(view.last().frames.map((item) => item.sequence)).toEqual([1])
  })

  it("reports another holder as a typed contended issue and retries until it is free", async () => {
    const h = harness()
    h.open.mockResolvedValueOnce({
      accepted: false,
      code: "device-purpose-limit",
      detail: "device already owns a lease for this purpose",
    })
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: view.onChange })
    await settle()
    expect(view.last().state).toBe("connecting")
    expect(view.last().issue).toEqual({
      kind: "contended",
      code: "device-purpose-limit",
      detail: "device already owns a lease for this purpose",
    })
    // A second consumer joining during the back-off must not bypass it.
    h.lease.subscribe({ cadenceMs: 1000, onChange: () => undefined })
    await settle()
    expect(h.open).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(PERF_LEASE_CONTENDED_RETRY_MS)
    await settle()
    expect(h.open).toHaveBeenCalledTimes(2)
    expect(view.last().state).toBe("live")
    expect(view.last().issue).toBeNull()
  })

  it("treats a request fault as a terminal rejection, not a conflict", async () => {
    const h = harness()
    h.open.mockResolvedValueOnce({
      accepted: false,
      code: "cadence-too-fast",
      detail: "requested cadence is below the admitted minimum",
    })
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 250, onChange: view.onChange })
    await settle()
    expect(view.last().state).toBe("error")
    expect(view.last().issue).toMatchObject({ kind: "rejected", code: "cadence-too-fast" })
    await jest.advanceTimersByTimeAsync(PERF_LEASE_CONTENDED_RETRY_MS * 2)
    expect(h.open).toHaveBeenCalledTimes(1)
  })

  it("reports an unreachable host as unsupported", async () => {
    const h = harness()
    h.open.mockRejectedValueOnce(new Error("unsupported host"))
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: view.onChange })
    await settle()
    expect(view.last().state).toBe("unsupported")
    expect(view.last().issue).toEqual({ kind: "unreachable", detail: "unsupported host" })
  })

  it("takes a fresh lease when the host already expired the held one", async () => {
    const h = harness()
    h.renew.mockRejectedValueOnce(new Error("lease-expired"))
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: view.onChange })
    await settle()
    await jest.advanceTimersByTimeAsync(PERF_LEASE_HEARTBEAT_MS)
    await settle()
    expect(h.open).toHaveBeenCalledTimes(2)
    expect(view.last().state).toBe("live")
  })

  it("marks the stream stale when a heartbeat fails for another reason", async () => {
    const h = harness()
    h.renew.mockRejectedValueOnce(new Error("transport closed"))
    const view = recorder()
    h.lease.subscribe({ cadenceMs: 1000, onChange: view.onChange })
    await settle()
    await jest.advanceTimersByTimeAsync(PERF_LEASE_HEARTBEAT_MS)
    await settle()
    expect(view.last().state).toBe("stale")
    expect(view.last().issue).toEqual({ kind: "renew-failed", detail: "transport closed" })
  })

  it("hands back a lease the host granted after everyone had already left", async () => {
    const h = harness()
    let resolveOpen: (value: PerfOpenLeaseResult) => void = () => {}
    h.open.mockReturnValueOnce(new Promise((resolve) => (resolveOpen = resolve)))
    const only = h.lease.subscribe({ cadenceMs: 1000, onChange: () => undefined })
    await Promise.resolve()
    only.unsubscribe()
    await jest.advanceTimersByTimeAsync(0)
    resolveOpen(accepted("lease-orphan"))
    await settle()
    expect(h.close).toHaveBeenCalledWith("lease-orphan")
  })

  it("resets one subscriber's baseline without touching another's", async () => {
    const h = harness()
    const a = recorder()
    const b = recorder()
    const subscriptionA = h.lease.subscribe({ cadenceMs: 1000, onChange: a.onChange })
    h.lease.subscribe({ cadenceMs: 1000, onChange: b.onChange })
    await settle()
    subscriptionA.resetHistory()
    expect(a.last().frames).toEqual([])
    expect(b.last().frames.map((item) => item.sequence)).toEqual([1])
    h.emit(frame(2, { leaseId: "lease-1" }))
    expect(a.last().frames.map((item) => item.sequence)).toEqual([2])
  })
})

describe("isContendedPerfRejection", () => {
  it("separates another holder from a fault in the request", () => {
    expect(isContendedPerfRejection("device-purpose-limit")).toBe(true)
    expect(isContendedPerfRejection("host-lease-limit")).toBe(true)
    expect(isContendedPerfRejection("rate-limited")).toBe(true)
    expect(isContendedPerfRejection("cadence-too-fast")).toBe(false)
    expect(isContendedPerfRejection("permission-denied")).toBe(false)
    expect(isContendedPerfRejection("unsupported")).toBe(false)
  })
})
