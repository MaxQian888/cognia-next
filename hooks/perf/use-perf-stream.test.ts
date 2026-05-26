/**
 * @jest-environment jsdom
 */

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const startMock = jest.fn().mockResolvedValue(undefined)
const stopMock = jest.fn().mockResolvedValue(undefined)
const snapshotMock = jest.fn()
const setIntervalMock = jest.fn().mockResolvedValue(undefined)
const resetMock = jest.fn().mockResolvedValue(undefined)
let sampleHandler: ((s: unknown) => void) | null = null
const unsubMock = jest.fn()
const subscribeMock = jest.fn((h: (s: unknown) => void) => {
  sampleHandler = h
  return unsubMock
})

jest.mock("@/lib/perf/backend/commands", () => ({
  perfStartSampling: (...a: unknown[]) => startMock(...a),
  perfStopSampling: (...a: unknown[]) => stopMock(...a),
  perfSnapshot: (...a: unknown[]) => snapshotMock(...a),
  perfSetInterval: (...a: unknown[]) => setIntervalMock(...a),
  perfResetHotspots: (...a: unknown[]) => resetMock(...a),
  subscribePerfSample: (h: (s: unknown) => void) => subscribeMock(h),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { DEFAULT_PERF_INTERVAL, usePerfStream } from "./use-perf-stream"
import type { PerfSample } from "@/lib/perf/backend/types"

function sample(ts: number): PerfSample {
  return {
    tsMs: ts,
    intervalMs: 1000,
    processes: [],
    runtime: {
      workers: 1,
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
      perWorkerBusyPct: [0],
    },
    topSpans: [],
    systemMemory: null,
  }
}

beforeEach(() => {
  isTauriMock.mockReset()
  startMock.mockClear()
  stopMock.mockClear()
  snapshotMock.mockReset()
  setIntervalMock.mockClear()
  resetMock.mockClear()
  subscribeMock.mockClear()
  unsubMock.mockClear()
  sampleHandler = null
})

describe("usePerfStream — non-desktop", () => {
  it("is inert when not running in Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => usePerfStream())
    expect(result.current.available).toBe(false)
    expect(startMock).not.toHaveBeenCalled()
    expect(result.current.latest).toBeNull()
  })
})

describe("usePerfStream — desktop", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    snapshotMock.mockResolvedValue({
      samples: [sample(1), sample(2)],
      running: true,
      intervalMs: 1000,
    })
  })

  it("starts sampling, backfills, and subscribes on mount", async () => {
    const { result } = renderHook(() => usePerfStream())
    expect(startMock).toHaveBeenCalledWith(DEFAULT_PERF_INTERVAL)
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled())
    await waitFor(() => expect(result.current.history).toHaveLength(2))
    expect(result.current.latest?.tsMs).toBe(2)
  })

  it("appends live samples and exposes the latest", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(sampleHandler).not.toBeNull())
    act(() => sampleHandler!(sample(3)))
    await waitFor(() => expect(result.current.latest?.tsMs).toBe(3))
    expect(result.current.history).toHaveLength(3)
  })

  it("pause freezes appends without stopping the backend", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(sampleHandler).not.toBeNull())
    act(() => result.current.setPaused(true))
    act(() => sampleHandler!(sample(99)))
    expect(result.current.paused).toBe(true)
    expect(result.current.history.some((s) => s.tsMs === 99)).toBe(false)
  })

  it("setIntervalMs updates state and the backend cadence", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled())
    act(() => result.current.setIntervalMs(2000))
    expect(result.current.intervalMs).toBe(2000)
    expect(setIntervalMock).toHaveBeenCalledWith(2000)
  })

  it("reset clears backend hotspots", async () => {
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled())
    act(() => result.current.reset())
    expect(resetMock).toHaveBeenCalled()
  })

  it("caps the rolling window at PERF_HISTORY_LIMIT", async () => {
    snapshotMock.mockResolvedValue({ samples: [], running: true, intervalMs: 1000 })
    const { result } = renderHook(() => usePerfStream())
    await waitFor(() => expect(sampleHandler).not.toBeNull())
    act(() => {
      for (let i = 0; i < 130; i += 1) sampleHandler!(sample(i))
    })
    await waitFor(() => expect(result.current.history.length).toBe(120))
    // Oldest entries evicted; newest retained.
    expect(result.current.latest?.tsMs).toBe(129)
    expect(result.current.history[0].tsMs).toBe(10)
  })

  it("stops sampling and unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => usePerfStream())
    await waitFor(() => expect(subscribeMock).toHaveBeenCalled())
    unmount()
    expect(stopMock).toHaveBeenCalled()
    expect(unsubMock).toHaveBeenCalled()
  })
})
