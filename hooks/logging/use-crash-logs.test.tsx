/**
 * @jest-environment jsdom
 *
 * Coverage focus: deterministic surface of `useCrashLogs`. The hook depends on
 * a heavy chain of native runtime + log transports — we mock all of them so
 * the test is fast and predictable.
 */
import { act, render, renderHook, waitFor } from "@testing-library/react"

const buildItemsMock = jest.fn((..._a: unknown[]) => [] as unknown[])
const summarizeMock = jest.fn((..._a: unknown[]) => ({ total: 0 }))
const buildBundleMock = jest.fn((..._a: unknown[]): Record<string, unknown> => ({
  items: [],
  generatedAt: "now",
}))
const isCrashRelevantMock = jest.fn((..._a: unknown[]) => true)

const serializeBundleMock = jest.fn(
  (_bundle: unknown, format: "bundle" | "json" | "text" = "bundle") => ({
    filename: `cognia-crash-${format}-2026-04-29.json`,
    content: "{}",
    mimeType: "application/json",
  })
)

jest.mock("@/lib/logging/crash-log", () => ({
  buildCrashLogExportBundle: (...a: unknown[]) => buildBundleMock(...a),
  buildCrashLogItems: (...a: unknown[]) => buildItemsMock(...a),
  isCrashRelevantLogEntry: (...a: unknown[]) => isCrashRelevantMock(...a),
  serializeCrashLogBundle: (...a: unknown[]) => serializeBundleMock(...(a as [unknown, never])),
  summarizeCrashLogItems: (...a: unknown[]) => summarizeMock(...a),
}))

const transportDeleteMock = jest.fn().mockResolvedValue(undefined)
const fakeTransport = {
  deleteEntries: (ids: string[]) => transportDeleteMock(ids),
  clear: jest.fn(async () => undefined),
}
jest.mock("@/lib/logging", () => ({
  getIndexedDBTransport: () => fakeTransport,
}))

const recentSubscribers: Array<() => void> = []
// Replaced, never mutated in place — the real module works that way, and the
// hook now reads it as a `useSyncExternalStore` snapshot, whose identity is
// what tells React something changed.
let recentLogs: unknown[] = []
function notifyRecent(): void {
  for (const subscriber of [...recentSubscribers]) subscriber()
}
function recordRecent(entry: unknown): void {
  recentLogs = [entry, ...recentLogs]
  notifyRecent()
}
const clearRecentMock = jest.fn(() => {
  recentLogs = []
  notifyRecent()
})
jest.mock("@cognia/logging/recent-errors", () => ({
  clearRecentErrorLogs: () => clearRecentMock(),
  getRecentErrorLogs: () => recentLogs,
  getRecentErrorLogsSnapshot: () => recentLogs,
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
  recentLogs = []
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

  // Regression: the console bridge records recent errors on the synchronous
  // `console.error` path, so a sibling that logs during its own render
  // notifies this hook mid-render. With `useState` that was React's "Cannot
  // update a component while rendering a different component", which is what
  // the `/logs` Diagnostics channel surfaced.
  it("takes a mid-render recent-error notification without a render-phase update warning", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    let recorded = false

    function Subscriber() {
      useCrashLogs()
      return null
    }
    function LogsWhileRendering({ noisy }: { noisy: boolean }) {
      if (noisy && !recorded) {
        recorded = true
        recordRecent({ id: "mid-render", level: "error" })
      }
      return null
    }
    const tree = (noisy: boolean) => (
      <>
        <Subscriber />
        <LogsWhileRendering noisy={noisy} />
      </>
    )

    // Mount first: the subscription is an effect, so nothing is listening
    // during the very first pass. The warning needs a *re-render* that logs
    // while an already-mounted subscriber is on screen — the real shape, where
    // `DiagnosticsWorkspace` re-renders under a mounted Diagnostics channel.
    const { rerender } = render(tree(false))
    rerender(tree(true))

    expect(recorded).toBe(true)
    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")
    expect(logged).not.toContain("Cannot update a component")
    errorSpy.mockRestore()
  })

  // The deferral must not swallow the update: one microtask later the hook has
  // to be looking at the entry that was recorded.
  it("still picks up a recorded error once the microtask runs", async () => {
    const { result } = renderHook(() => useCrashLogs())
    await waitFor(() => expect(buildItemsMock).toHaveBeenCalled())
    buildItemsMock.mockClear()

    await act(async () => {
      recordRecent({ id: "later", level: "error" })
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(buildItemsMock).toHaveBeenCalledWith(
        expect.objectContaining({ recentErrors: [{ id: "later", level: "error" }] })
      )
    )
    expect(result.current).toBeTruthy()
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
