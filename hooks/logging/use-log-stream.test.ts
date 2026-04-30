/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const getLogsMock = jest.fn(async (..._a: unknown[]) => [] as unknown[])
const clearMock = jest.fn(async () => undefined)
const onLogsUpdatedMock = jest.fn(
  (..._a: unknown[]) =>
    () =>
      undefined
)

jest.mock("@/lib/logger", () => {
  class FakeIndexedDBTransport {
    static onLogsUpdated = (...args: unknown[]) => onLogsUpdatedMock(...args)
    getLogs = (filter: unknown) => getLogsMock(filter)
    clear = () => clearMock()
    getStats = jest.fn(async () => ({ byModule: { foo: 1 } }))
  }
  return {
    IndexedDBTransport: FakeIndexedDBTransport,
    getRegisteredModules: () => ["alpha", "beta"],
  }
})

import { useLogModules, useLogStream } from "./use-log-stream"

beforeEach(() => {
  getLogsMock.mockReset().mockResolvedValue([])
  clearMock.mockReset().mockResolvedValue(undefined)
  onLogsUpdatedMock.mockReset().mockReturnValue(() => undefined)
})

const sampleEntry = (
  overrides: Partial<{
    id: string
    level: string
    module: string
    message: string
    timestamp: string
    traceId?: string
    data?: Record<string, unknown>
    tags?: string[]
  }> = {}
) => ({
  id: overrides.id ?? "log-1",
  level: overrides.level ?? "info",
  module: overrides.module ?? "alpha",
  message: overrides.message ?? "hello",
  timestamp: overrides.timestamp ?? "2026-01-01T00:00:00Z",
  traceId: overrides.traceId,
  data: overrides.data,
  tags: overrides.tags,
})

describe("useLogStream", () => {
  it("loads the initial logs", async () => {
    getLogsMock.mockResolvedValueOnce([sampleEntry()])
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.logs).toHaveLength(1))
  })

  it("filters by level into the LogFilter passed to the transport", async () => {
    renderHook(() => useLogStream({ level: "error" }))
    await waitFor(() => expect(getLogsMock).toHaveBeenCalled())
    expect(getLogsMock.mock.calls[0][0]).toMatchObject({ level: "error" })
  })

  it("applies a search query filter post-fetch (case-insensitive)", async () => {
    getLogsMock.mockResolvedValueOnce([
      sampleEntry({ id: "1", message: "Hello world" }),
      sampleEntry({ id: "2", message: "goodbye" }),
    ])
    const { result } = renderHook(() => useLogStream({ searchQuery: "hello" }))
    await waitFor(() => expect(result.current.logs.map((l) => l.id)).toEqual(["1"]))
  })

  it("falls back to message-only filter when regex is invalid", async () => {
    getLogsMock.mockResolvedValueOnce([
      sampleEntry({ id: "1", message: "hello" }),
      sampleEntry({ id: "2", message: "world" }),
    ])
    const { result } = renderHook(() => useLogStream({ searchQuery: "[unclosed", useRegex: true }))
    await waitFor(() => expect(result.current.logs).toHaveLength(0))
  })

  it("filters by tags when provided", async () => {
    getLogsMock.mockResolvedValueOnce([
      sampleEntry({ id: "1", tags: ["x"] }),
      sampleEntry({ id: "2", tags: ["y"] }),
    ])
    const { result } = renderHook(() => useLogStream({ tags: ["x"] }))
    await waitFor(() => expect(result.current.logs.map((l) => l.id)).toEqual(["1"]))
  })

  it("groups logs by trace id when groupByTraceId is true", async () => {
    getLogsMock.mockResolvedValueOnce([
      sampleEntry({ id: "1", traceId: "t1" }),
      sampleEntry({ id: "2", traceId: "t1" }),
      sampleEntry({ id: "3" }),
    ])
    const { result } = renderHook(() => useLogStream({ groupByTraceId: true }))
    await waitFor(() => expect(result.current.groupedLogs.size).toBeGreaterThan(0))
    expect(result.current.groupedLogs.get("t1")).toHaveLength(2)
    expect(result.current.groupedLogs.get("no-trace")).toHaveLength(1)
  })

  it("exportLogs returns text and JSON formats", async () => {
    getLogsMock.mockResolvedValueOnce([sampleEntry()])
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.logs).toHaveLength(1))
    expect(result.current.exportLogs("json")).toContain("hello")
    expect(result.current.exportLogs("text")).toContain("hello")
  })

  it("clearLogs delegates to the transport and empties state", async () => {
    getLogsMock.mockResolvedValueOnce([sampleEntry()])
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.logs).toHaveLength(1))
    await act(async () => {
      await result.current.clearLogs()
    })
    expect(clearMock).toHaveBeenCalled()
    expect(result.current.logs).toHaveLength(0)
  })

  it("captures fetch errors", async () => {
    getLogsMock.mockRejectedValueOnce(new Error("idb dead"))
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.error?.message).toBe("idb dead"))
  })

  it("computes stats and logRate from logs", async () => {
    getLogsMock.mockResolvedValueOnce([
      sampleEntry({ id: "1", level: "info", timestamp: "2026-01-01T00:00:00Z" }),
      sampleEntry({ id: "2", level: "error", timestamp: "2026-01-01T00:01:00Z" }),
    ])
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.logs).toHaveLength(2))
    expect(result.current.stats.total).toBe(2)
    expect(result.current.stats.byLevel.info).toBe(1)
    expect(result.current.logRate).toBeGreaterThan(0)
  })

  it("logRate is 0 with fewer than 2 logs", async () => {
    getLogsMock.mockResolvedValueOnce([sampleEntry()])
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.logs).toHaveLength(1))
    expect(result.current.logRate).toBe(0)
  })
})

describe("useLogModules", () => {
  it("initializes with the registered modules", async () => {
    const { result } = renderHook(() => useLogModules())
    expect(result.current).toEqual(["alpha", "beta"])
  })
})
