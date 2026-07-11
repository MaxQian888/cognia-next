/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/native/native-logging", () => ({
  queryNativeLogs: jest.fn(),
  listNativeLogFiles: jest.fn(),
}))

import { listNativeLogFiles, queryNativeLogs } from "@/lib/native/native-logging"
import { useNativeLogQuery } from "./use-native-log-query"

const queryMock = queryNativeLogs as jest.Mock
const listMock = listNativeLogFiles as jest.Mock

const RESULT = {
  entries: [
    {
      timestamp: "2026-07-11T01:00:00Z",
      epochMs: 1,
      level: "info",
      target: "boot",
      message: "started",
    },
  ],
  fileSize: 100,
  scannedBytes: 100,
  truncated: false,
  path: "C:/logs/cognia-structured.log",
}

beforeEach(() => {
  queryMock.mockReset()
  listMock.mockReset()
  queryMock.mockResolvedValue(RESULT)
  listMock.mockResolvedValue([])
})

describe("useNativeLogQuery", () => {
  it("fetches on mount and reports availability", async () => {
    const { result } = renderHook(() => useNativeLogQuery())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.result).toEqual(RESULT)
    expect(result.current.available).toBe(true)
    expect(queryMock).toHaveBeenCalledWith({ file: "structured", limit: 200 })
    expect(listMock).not.toHaveBeenCalled()
  })

  it("marks unavailable when the backend returns null", async () => {
    queryMock.mockResolvedValue(null)
    const { result } = renderHook(() => useNativeLogQuery())

    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.result).toBeNull()
  })

  it("re-fetches when the query is patched", async () => {
    const { result } = renderHook(() => useNativeLogQuery())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => {
      result.current.setQuery({ minLevel: "warn" })
    })

    await waitFor(() =>
      expect(queryMock).toHaveBeenCalledWith({ file: "structured", limit: 200, minLevel: "warn" })
    )
    expect(result.current.query.minLevel).toBe("warn")
  })

  it("fetches the file listing when listFiles is enabled", async () => {
    const files = [{ name: "cognia.log", size: 5, modifiedMs: 1 }]
    listMock.mockResolvedValue(files)
    const { result } = renderHook(() => useNativeLogQuery({ listFiles: true }))

    await waitFor(() => expect(result.current.files).toEqual(files))
  })

  it("merges the initial query over the defaults", async () => {
    renderHook(() => useNativeLogQuery({ initialQuery: { file: "plain", limit: 50 } }))
    await waitFor(() => expect(queryMock).toHaveBeenCalledWith({ file: "plain", limit: 50 }))
  })

  it("polls when refreshIntervalMs is set", async () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useNativeLogQuery({ refreshIntervalMs: 1000 }))
      await act(async () => {
        await Promise.resolve()
      })
      const callsAfterMount = queryMock.mock.calls.length
      expect(result.current.available).toBe(true)

      await act(async () => {
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(queryMock.mock.calls.length).toBeGreaterThan(callsAfterMount)
    } finally {
      jest.useRealTimers()
    }
  })
})
