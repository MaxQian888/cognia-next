/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const getSnapshotMock = jest.fn()
jest.mock("@/lib/logger", () => ({
  getTransportHealthSnapshot: () => getSnapshotMock(),
}))

const getReadinessMock = jest.fn(() => ({ ready: true }))
jest.mock("@/lib/native/native-logging-readiness", () => ({
  getNativeLoggingReadiness: () => getReadinessMock(),
}))

import { useTransportHealth } from "./use-transport-health"

beforeEach(() => {
  getSnapshotMock.mockReset()
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
