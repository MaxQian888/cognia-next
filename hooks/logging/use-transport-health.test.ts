/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const getSnapshotMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  getTransportHealthSnapshot: () => getSnapshotMock(),
}))

const getBehaviorSnapshotMock = jest.fn()
jest.mock("@/lib/telemetry/events/track-event", () => ({
  getBehaviorEventExporterHealthSnapshot: () => getBehaviorSnapshotMock(),
}))

const getReadinessMock = jest.fn(() => ({ ready: true }))
jest.mock("@/lib/native/native-logging-readiness", () => ({
  getNativeLoggingReadiness: () => getReadinessMock(),
}))

import { useTransportHealth } from "./use-transport-health"

beforeEach(() => {
  getSnapshotMock.mockReset()
  getBehaviorSnapshotMock.mockReset().mockReturnValue({})
  getReadinessMock.mockReset().mockReturnValue({ ready: true })
})

describe("useTransportHealth", () => {
  it("loads the initial snapshot and reflects it on first paint", () => {
    getSnapshotMock.mockReturnValue({
      indexed: { queueDepth: 5 },
    })
    const { result } = renderHook(() => useTransportHealth({ autoRefresh: false }))
    expect(result.current.healthByTransport.indexed.queueDepth).toBe(5)
    expect(result.current.queueDepthHistoryByTransport.indexed).toEqual([5])
    expect(result.current.nativeLogging).toEqual({ ready: true })
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it("includes Cognia Product Analytics exporters in the unified health snapshot", () => {
    getSnapshotMock.mockReturnValue({ indexed: { queueDepth: 0 } })
    getBehaviorSnapshotMock.mockReturnValue({
      "posthog-managed": {
        transport: "posthog-managed",
        status: "degraded",
        queueDepth: 2,
        retryCount: 1,
        droppedEntries: 0,
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
    })

    const { result } = renderHook(() => useTransportHealth({ autoRefresh: false }))

    expect(result.current.healthByTransport["posthog-managed"]).toMatchObject({
      status: "degraded",
      queueDepth: 2,
    })
  })

  it("auto-refresh appends queue-depth samples up to the cap", async () => {
    let depth = 0
    getSnapshotMock.mockImplementation(() => ({ x: { queueDepth: depth++ } }))
    jest.useFakeTimers()
    const { result } = renderHook(() =>
      useTransportHealth({ autoRefresh: true, refreshInterval: 100 })
    )
    for (let i = 0; i < 35; i++) {
      await act(async () => {
        jest.advanceTimersByTime(100)
      })
    }
    jest.useRealTimers()
    expect(result.current.queueDepthHistoryByTransport.x.length).toBeLessThanOrEqual(30)
  })

  it("captures snapshot errors as Error", () => {
    getSnapshotMock.mockImplementation(() => {
      throw new Error("snapshot bad")
    })
    const { result } = renderHook(() => useTransportHealth({ autoRefresh: false }))
    expect(result.current.error?.message).toBe("snapshot bad")
  })

  it("manual refresh re-runs the snapshot fetch", () => {
    getSnapshotMock.mockReturnValue({})
    const { result } = renderHook(() => useTransportHealth({ autoRefresh: false }))
    expect(getSnapshotMock).toHaveBeenCalledTimes(1)
    act(() => result.current.refresh())
    expect(getSnapshotMock).toHaveBeenCalledTimes(2)
  })
})
