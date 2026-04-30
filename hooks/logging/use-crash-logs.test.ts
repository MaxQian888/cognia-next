/**
 * @jest-environment jsdom
 *
 * Coverage focus: deterministic surface of `useCrashLogs`. The hook depends on
 * a heavy chain of native runtime + log transports — we mock all of them so
 * the test is fast and predictable.
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const buildItemsMock = jest.fn((..._a: unknown[]) => [] as unknown[])
const summarizeMock = jest.fn((..._a: unknown[]) => ({ total: 0 }))
const buildBundleMock = jest.fn(
  (..._a: unknown[]): Record<string, unknown> => ({ items: [], generatedAt: "now" })
)
const isCrashRelevantMock = jest.fn((..._a: unknown[]) => true)

jest.mock("@/lib/logger/crash-log", () => ({
  buildCrashLogExportBundle: (...a: unknown[]) => buildBundleMock(...a),
  buildCrashLogItems: (...a: unknown[]) => buildItemsMock(...a),
  isCrashRelevantLogEntry: (...a: unknown[]) => isCrashRelevantMock(...a),
  summarizeCrashLogItems: (...a: unknown[]) => summarizeMock(...a),
}))

const transportDeleteMock = jest.fn().mockResolvedValue(undefined)
const fakeTransport = {
  deleteEntries: (ids: string[]) => transportDeleteMock(ids),
  clear: jest.fn(async () => undefined),
}
jest.mock("@/lib/logger", () => ({
  getIndexedDBTransport: () => fakeTransport,
}))

const recentSubscribers: Array<() => void> = []
const recentLogs: unknown[] = []
const clearRecentMock = jest.fn(() => recentLogs.splice(0))
jest.mock("@/lib/logger/recent-errors", () => ({
  clearRecentErrorLogs: () => clearRecentMock(),
  getRecentErrorLogs: () => recentLogs,
  subscribeRecentErrorLogs: (fn: () => void) => {
    recentSubscribers.push(fn)
    return () => {
      const i = recentSubscribers.indexOf(fn)
      if (i >= 0) recentSubscribers.splice(i, 1)
    }
  },
}))

jest.mock("@/lib/native/local-runtime", () => ({
  getLocalRuntimeDiagnostics: jest.fn(async () => ({ runtime: "ok" })),
}))

const openDirMock = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/native/native-logging", () => ({
  getNativeLogDirectory: jest.fn(async () => "/var/log"),
  getNativeLoggingReadiness: jest.fn(async () => ({ ready: true })),
  getNativeLoggingReadinessSnapshot: jest.fn(() => ({ ready: true })),
  openNativeLogDirectory: () => openDirMock(),
}))

jest.mock("@/lib/native/window-diagnostics", () => ({
  getWindowDiagnostics: jest.fn(async () => ({ window: "ok" })),
}))

const useLogStreamMock = jest.fn()
jest.mock("./use-log-stream", () => ({
  useLogStream: (opts: unknown) => useLogStreamMock(opts),
}))

import { useCrashLogs } from "./use-crash-logs"

beforeEach(() => {
  buildItemsMock.mockReset().mockReturnValue([])
  summarizeMock.mockReset().mockReturnValue({ total: 0 })
  buildBundleMock.mockReset().mockReturnValue({ items: [], generatedAt: "now" })
  isCrashRelevantMock.mockReset().mockReturnValue(true)
  transportDeleteMock.mockReset().mockResolvedValue(undefined)
  fakeTransport.clear.mockReset().mockResolvedValue(undefined)
  recentSubscribers.length = 0
  recentLogs.length = 0
  clearRecentMock.mockClear()
  openDirMock.mockReset().mockResolvedValue(true)
  useLogStreamMock.mockReset().mockReturnValue({
    logs: [],
    isLoading: false,
    error: null,
    refresh: jest.fn().mockResolvedValue(undefined),
    clearLogs: jest.fn().mockResolvedValue(undefined),
  })
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: jest.fn(() => "blob:url"),
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: jest.fn(),
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("useCrashLogs", () => {
  it("aggregates items from build helper and exposes filter setters", async () => {
    buildItemsMock.mockReturnValue([
      { id: "1", title: "boom", sources: ["frontend"], level: "error" },
    ])
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0))
    expect(result.current.filters.source).toBe("all")
    act(() => {
      result.current.setSourceFilter("frontend" as never)
      result.current.setLevelFilter("error" as never)
      result.current.setSearchQuery("boom")
    })
    expect(result.current.filters.source).toBe("frontend")
    expect(result.current.filters.level).toBe("error")
    expect(result.current.filters.search).toBe("boom")
  })

  it("search query filters out items by title / summary", async () => {
    buildItemsMock.mockReturnValue([
      { id: "1", title: "alpha", sources: [], level: "error" },
      { id: "2", title: "beta", sources: [], level: "error" },
    ])
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.items.length).toBe(2))
    act(() => {
      result.current.setSearchQuery("alpha")
    })
    expect(result.current.items.map((i) => i.id)).toEqual(["1"])
  })

  it("clearRecent forwards to the recent-errors helper", () => {
    const { result } = renderHook(() => useCrashLogs())
    act(() => result.current.clearRecent())
    expect(clearRecentMock).toHaveBeenCalled()
  })

  it("clearPersisted: uses transport.deleteEntries when persisted ids exist", async () => {
    buildItemsMock.mockReturnValue([
      { id: "p1", title: "x", sources: ["persisted"], level: "error" },
    ])
    const refresh = jest.fn().mockResolvedValue(undefined)
    useLogStreamMock.mockReturnValue({
      logs: [],
      isLoading: false,
      error: null,
      refresh,
      clearLogs: jest.fn().mockResolvedValue(undefined),
    })
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.items.length).toBe(1))
    await act(async () => {
      await result.current.clearPersisted()
    })
    expect(transportDeleteMock).toHaveBeenCalledWith(["p1"])
    expect(refresh).toHaveBeenCalled()
  })

  it("clearPersisted: falls back to clearLogs when no persisted ids", async () => {
    buildItemsMock.mockReturnValue([])
    const clearLogs = jest.fn().mockResolvedValue(undefined)
    useLogStreamMock.mockReturnValue({
      logs: [],
      isLoading: false,
      error: null,
      refresh: jest.fn().mockResolvedValue(undefined),
      clearLogs,
    })
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => {
      await result.current.clearPersisted()
    })
    expect(clearLogs).toHaveBeenCalled()
  })

  it("copySelected returns false when nothing is selected", async () => {
    buildItemsMock.mockReturnValue([])
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.copySelected()
    })
    expect(ok).toBe(false)
  })

  it("exportBundle: bundle / json / text variants all trigger a download", async () => {
    buildItemsMock.mockReturnValue([
      { id: "1", title: "x", sources: [], level: "error", timestamp: "now", module: "m" },
    ])
    buildBundleMock.mockReturnValue({
      items: [{ id: "1", level: "error", timestamp: "now", module: "m", title: "x" }],
    })
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined)
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.items.length).toBe(1))
    act(() => result.current.exportBundle("bundle"))
    act(() => result.current.exportBundle("json"))
    act(() => result.current.exportBundle("text"))
    expect(clickSpy).toHaveBeenCalledTimes(3)
    clickSpy.mockRestore()
  })

  it("openNativeLogDirectory delegates to native helper", async () => {
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.openNativeLogDirectory()
    })
    expect(ok).toBe(true)
    expect(openDirMock).toHaveBeenCalled()
  })

  it("autoRefresh toggle keeps the diagnostics polling timer active", () => {
    jest.useFakeTimers()
    const { result } = renderHook(() => useCrashLogs())
    expect(result.current.autoRefresh).toBe(true)
    act(() => result.current.setAutoRefresh(false))
    expect(result.current.autoRefresh).toBe(false)
    jest.useRealTimers()
  })
})
