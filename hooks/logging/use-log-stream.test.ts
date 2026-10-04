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

jest.mock("@cognia/logging", () => {
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

import { createLogSearchMatcher, useLogModules, useLogStream } from "./use-log-stream"

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

  it("rethrows a failed clear without replacing the list with a load error", async () => {
    getLogsMock.mockResolvedValueOnce([sampleEntry()])
    clearMock.mockRejectedValueOnce(new Error("locked"))
    const { result } = renderHook(() => useLogStream())
    await waitFor(() => expect(result.current.logs).toHaveLength(1))
    await act(async () => {
      await expect(result.current.clearLogs()).rejects.toThrow("locked")
    })
    expect(result.current.logs).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it("flags a full window from the pre-search fetch length", async () => {
    // Three entries fill a three-entry window; the search keeps one of them,
    // but the panel still only searched the newest three.
    getLogsMock.mockResolvedValueOnce([
      sampleEntry({ id: "1", message: "needle" }),
      sampleEntry({ id: "2", message: "hay" }),
      sampleEntry({ id: "3", message: "hay" }),
    ])
    const { result } = renderHook(() => useLogStream({ maxLogs: 3, searchQuery: "needle" }))
    await waitFor(() => expect(result.current.logs.map((l) => l.id)).toEqual(["1"]))
    expect(result.current.windowCapped).toBe(true)
  })

  it("does not flag a window that is not full", async () => {
    getLogsMock.mockResolvedValueOnce([sampleEntry({ id: "1" })])
    const { result } = renderHook(() => useLogStream({ maxLogs: 3 }))
    await waitFor(() => expect(result.current.logs).toHaveLength(1))
    expect(result.current.windowCapped).toBe(false)
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

describe("createLogSearchMatcher", () => {
  const entry = (message: string, extra: Record<string, unknown> = {}) =>
    ({
      id: message,
      level: "info",
      module: "agent.trace",
      message,
      timestamp: "2026-01-01T00:00:00Z",
      ...extra,
    }) as never

  it("returns null without a query", () => {
    expect(createLogSearchMatcher("", false)).toBeNull()
    expect(createLogSearchMatcher(undefined, true)).toBeNull()
  })

  it("matches message, module, trace id and data fields case-insensitively", () => {
    const match = createLogSearchMatcher("TOOL", false)!
    expect(match(entry("ran tool"))).toBe(true)
    expect(match(entry("x", { data: { name: "tool-call" } }))).toBe(true)
    expect(createLogSearchMatcher("agent.trace", false)!(entry("x"))).toBe(true)
    expect(match(entry("nothing"))).toBe(false)
  })

  it("treats the query as a pattern with useRegex, and degrades to a literal when invalid", () => {
    expect(createLogSearchMatcher("^ran\\s+t", true)!(entry("ran tool"))).toBe(true)
    expect(createLogSearchMatcher("[x", true)!(entry("has [x inside"))).toBe(true)
    expect(createLogSearchMatcher("[x", true)!(entry("plain"))).toBe(false)
  })
})
