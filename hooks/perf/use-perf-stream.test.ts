/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"
import {
  PERF_WIRE_VERSION,
  type PerfFrame,
  type PerfSourceDescriptor,
} from "@/lib/perf/backend/types"

const openLease = jest.fn()
const closeLease = jest.fn().mockResolvedValue(undefined)
const renewLease = jest.fn().mockResolvedValue(undefined)
const leaseSnapshot = jest.fn()
let hostHandler: ((frame: PerfFrame) => void) | null = null
const unsubscribeHost = jest.fn()

jest.mock("@/lib/perf/backend/commands", () => ({
  perfOpenLease: (...args: unknown[]) => openLease(...args),
  perfCloseLease: (...args: unknown[]) => closeLease(...args),
  perfRenewLease: (...args: unknown[]) => renewLease(...args),
  perfLeaseSnapshot: (...args: unknown[]) => leaseSnapshot(...args),
  subscribePerfFrame: (handler: (frame: PerfFrame) => void) => {
    hostHandler = handler
    return unsubscribeHost
  },
}))

let rendererHandler: ((frame: PerfFrame) => void) | null = null
const closeDemand = jest.fn()
const rendererSource: PerfSourceDescriptor = {
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
const collector = {
  source: rendererSource,
  setScope: jest.fn(),
  openDemand: jest.fn(() => "renderer-demand"),
  closeDemand,
  subscribe: jest.fn((handler: (frame: PerfFrame) => void) => {
    rendererHandler = handler
    return jest.fn()
  }),
}
jest.mock("@/lib/perf/renderer-collector", () => ({
  getRendererPerformanceCollector: () => collector,
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => ({ accountId: "account-a", targetId: "target-a" }),
}))

import { resetPreferredInterval, usePerfStream } from "./use-perf-stream"

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

const hostSource: PerfSourceDescriptor = {
  ...rendererSource,
  sourceId: "host:one",
  kind: "host",
  runtimeKind: "tauri-rust",
}

beforeEach(() => {
  resetPreferredInterval()
  openLease.mockReset()
  closeLease.mockClear()
  renewLease.mockClear()
  leaseSnapshot.mockReset()
  unsubscribeHost.mockClear()
  collector.setScope.mockClear()
  collector.openDemand.mockClear()
  closeDemand.mockClear()
  rendererHandler = null
  hostHandler = null
  openLease.mockResolvedValue({
    accepted: true,
    lease: { leaseId: "lease-a" },
    source: hostSource,
  })
  leaseSnapshot.mockResolvedValue({
    wireVersion: PERF_WIRE_VERSION,
    frames: [frame(1)],
    oldestSequence: 1,
    latestSequence: 1,
    sources: [hostSource],
    leases: [],
    gaps: [],
    samples: [frame(1)],
    running: true,
    intervalMs: 1000,
  })
})

describe("usePerfStream", () => {
  it("keeps Renderer metrics available when the selected host is unsupported", async () => {
    openLease.mockRejectedValue(new Error("unsupported host"))
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(rendererHandler).not.toBeNull())
    act(() => rendererHandler!(frame(1, { sourceId: "renderer:doc-a", hostInstanceId: "doc-a" })))
    await waitFor(() => expect(result.current.latest?.sourceId).toBe("renderer:doc-a"))
    expect(result.current.available).toBe(true)
    expect(result.current.hostState).toBe("unsupported")
    expect(result.current.error).toBe("unsupported host")
  })

  it("subscribes before opening, merges an early event with snapshot, and exposes gaps", async () => {
    let resolveOpen: (value: unknown) => void = () => {}
    openLease.mockReturnValue(new Promise((resolve) => (resolveOpen = resolve)))
    const { result } = renderHook(() => usePerfStream())
    expect(hostHandler).not.toBeNull()
    act(() => hostHandler!(frame(3)))
    await act(async () => {
      resolveOpen({ accepted: true, lease: { leaseId: "lease-a" }, source: hostSource })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(result.current.hostHistory.map((item) => item.sequence)).toEqual([1, 3])
    )
    expect(result.current.gaps[0]).toMatchObject({ sequenceStart: 2, sequenceEnd: 2 })
  })

  it("rejects late frames from an old target generation", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(result.current.hostState).toBe("live"))
    act(() => hostHandler!(frame(2, { targetId: "target-old" })))
    expect(result.current.hostHistory.map((item) => item.sequence)).toEqual([1])
  })

  it("reopens immutable cadence leases and clears incompatible graph history", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(result.current.hostHistory).toHaveLength(1))
    act(() => result.current.setIntervalMs(2000))
    expect(result.current.hostHistory).toEqual([])
    await waitFor(() =>
      expect(openLease).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestedCadenceMs: 2000 })
      )
    )
    expect(closeLease).toHaveBeenCalledWith("lease-a")
  })

  it("closes host and Renderer demand immediately on normal unmount", async () => {
    const { unmount } = renderHook(() => usePerfStream())
    await waitFor(() => expect(openLease).toHaveBeenCalled())
    unmount()
    expect(unsubscribeHost).toHaveBeenCalled()
    expect(closeLease).toHaveBeenCalledWith("lease-a")
    expect(closeDemand).toHaveBeenCalledWith("renderer-demand")
  })

  it("uses a local panel baseline reset without resetting the process-wide hotspot registry", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(result.current.hostHistory).toHaveLength(1))
    act(() => result.current.reset())
    expect(result.current.hostHistory).toEqual([])
  })
})
