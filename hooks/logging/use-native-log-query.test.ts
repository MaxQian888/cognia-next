/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))
jest.mock("@/lib/tauri/transport-web", () => ({
  NO_HOST_TRANSPORT_CODE: "no_host_transport",
}))

import { transport } from "@/lib/tauri"
import { classifyNativeLogError, useNativeLogQuery } from "./use-native-log-query"

const callMock = transport.call as jest.Mock
const queryMock = jest.fn()
const listMock = jest.fn()

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
  callMock.mockReset()
  // Route each command to its own mock so the assertions read like the old
  // `queryNativeLogs(query)` / `listNativeLogFiles()` ones.
  callMock.mockImplementation((name: string, args: { query?: unknown }) =>
    name === "logs_query" ? queryMock(args.query) : listMock()
  )
})

function rejectWith(code: string | undefined, message: string) {
  return Object.assign(new Error(message), code ? { code } : {})
}

describe("useNativeLogQuery", () => {
  it("fetches on mount and reports availability", async () => {
    const { result } = renderHook(() => useNativeLogQuery())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.result).toEqual(RESULT)
    expect(result.current.available).toBe(true)
    expect(queryMock).toHaveBeenCalledWith({ file: "structured", limit: 200 })
    expect(listMock).not.toHaveBeenCalled()
  })

  it("marks unavailable when nothing on this device can answer", async () => {
    queryMock.mockRejectedValue(rejectWith("no_host_transport", "web"))
    const { result } = renderHook(() => useNativeLogQuery())

    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("marks an unpaired companion unavailable too", async () => {
    queryMock.mockRejectedValue(rejectWith("not_paired", "pair first"))
    const { result } = renderHook(() => useNativeLogQuery())
    await waitFor(() => expect(result.current.available).toBe(false))
  })

  it("reports a host failure as an error, not as unavailable, and keeps the last result", async () => {
    const { result } = renderHook(() => useNativeLogQuery())
    await waitFor(() => expect(result.current.result).toEqual(RESULT))

    queryMock.mockRejectedValue(rejectWith("io", "log file is locked"))
    act(() => result.current.refresh())

    await waitFor(() => expect(result.current.error).toBe("log file is locked"))
    expect(result.current.available).toBe(true)
    expect(result.current.result).toEqual(RESULT)
    expect(result.current.loading).toBe(false)
  })

  it("clears the error once a later fetch succeeds", async () => {
    queryMock.mockRejectedValueOnce(rejectWith(undefined, "timeout"))
    const { result } = renderHook(() => useNativeLogQuery())
    await waitFor(() => expect(result.current.error).toBe("timeout"))

    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.result).toEqual(RESULT)
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

describe("classifyNativeLogError", () => {
  it("separates 'no backend' codes from host failures", () => {
    expect(classifyNativeLogError(rejectWith("no_host_transport", "x")).unavailable).toBe(true)
    expect(classifyNativeLogError(rejectWith("not_paired", "x")).unavailable).toBe(true)
    expect(classifyNativeLogError(rejectWith("http_500", "boom"))).toEqual({
      unavailable: false,
      message: "boom",
    })
    expect(classifyNativeLogError("plain")).toEqual({ unavailable: false, message: "plain" })
  })
})
