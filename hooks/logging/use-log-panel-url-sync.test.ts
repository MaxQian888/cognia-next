/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const mockSearchParams = jest.fn<URLSearchParams | null, []>()
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams(),
}))

import { useLogPanelUrlSync } from "./use-log-panel-url-sync"
import type { LogPanelFilterState } from "./use-log-panel-filters"

function noop() {}

function makeFilters(overrides: Partial<LogPanelFilterState> = {}): LogPanelFilterState {
  const state: Partial<LogPanelFilterState> = {
    autoRefresh: false,
    levelFilter: "all",
    moduleFilter: "all",
    sourceFilter: "all",
    sessionFilter: "",
    searchQuery: "",
    useRegex: false,
    timeRange: "all",
    customTimeRange: null,
    traceFocusId: null,
    autoScroll: true,
    viewMode: "list",
    selectedLog: null,
    showDetailPanel: false,
    selectedTransportHealthName: null,
    selectedNativeLogging: false,
    diagnosticTransportFilter: null,
    expandedIds: new Set(),
    focusedIndex: -1,
    density: "comfortable",
    presets: [],
    activePresetId: "__none__",
    bookmarkedIds: new Set(),
    bookmarkFilterActive: false,
    showAdvancedFilters: false,
    showShortcutsDialog: false,
    searchHistory: [],
    setBookmarkFilterActive: jest.fn() as unknown as LogPanelFilterState["setBookmarkFilterActive"],
    setShowAdvancedFilters: noop,
    setShowShortcutsDialog: noop,
    addSearchHistory: noop,
    removeSearchHistoryItem: noop,
    clearSearchHistory: noop,
    setAutoRefresh: noop,
    setLevelFilter: jest.fn() as unknown as LogPanelFilterState["setLevelFilter"],
    setModuleFilter: jest.fn() as unknown as LogPanelFilterState["setModuleFilter"],
    setSourceFilter: jest.fn() as unknown as LogPanelFilterState["setSourceFilter"],
    setSessionFilter: jest.fn() as unknown as LogPanelFilterState["setSessionFilter"],
    setSearchQuery: jest.fn() as unknown as LogPanelFilterState["setSearchQuery"],
    setUseRegex: jest.fn() as unknown as LogPanelFilterState["setUseRegex"],
    setTimeRange: jest.fn() as unknown as LogPanelFilterState["setTimeRange"],
    setCustomTimeRange: jest.fn() as unknown as LogPanelFilterState["setCustomTimeRange"],
    setTraceFocusId: jest.fn() as unknown as LogPanelFilterState["setTraceFocusId"],
    setAutoScroll: noop,
    setViewMode: jest.fn() as unknown as LogPanelFilterState["setViewMode"],
    setSelectedLog: jest.fn() as unknown as LogPanelFilterState["setSelectedLog"],
    setShowDetailPanel: jest.fn() as unknown as LogPanelFilterState["setShowDetailPanel"],
    setSelectedTransportHealthName: noop,
    setSelectedNativeLogging: noop,
    setDiagnosticTransportFilter:
      jest.fn() as unknown as LogPanelFilterState["setDiagnosticTransportFilter"],
    setFocusedIndex: noop,
    setDensity: jest.fn() as unknown as LogPanelFilterState["setDensity"],
    toggleExpanded: noop,
    toggleBookmark: noop,
    saveCurrentPreset: noop,
    applyPreset: noop,
    handlePresetChange: noop,
    removeActivePreset: noop,
    handleSelectLog: noop,
    handleFocusTrace: noop,
    handleFocusSession: noop,
    EMPTY_PRESET_VALUE: "__none__",
  }
  return { ...state, ...overrides } as LogPanelFilterState
}

beforeEach(() => {
  mockSearchParams.mockReset()
  mockSearchParams.mockReturnValue(new URLSearchParams())
  window.history.replaceState({}, "", "/logs")
})

/** Seed both the router snapshot and the live URL, the way a real load does. */
function seedUrl(query: string): void {
  mockSearchParams.mockReturnValue(new URLSearchParams(query))
  window.history.replaceState({}, "", query ? `/logs?${query}` : "/logs")
}

describe("useLogPanelUrlSync — hydration from URL", () => {
  it("applies parsed search params on mount", () => {
    seedUrl(
      "q=login&re=1&level=error&module=auth&src=tauri&session=s1&t=1h&trace=t-1&dx=remote&bm=1&view=dashboard&density=compact"
    )
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setSearchQuery).toHaveBeenCalledWith("login")
    expect(filters.setUseRegex).toHaveBeenCalledWith(true)
    expect(filters.setLevelFilter).toHaveBeenCalledWith("error")
    expect(filters.setModuleFilter).toHaveBeenCalledWith("auth")
    expect(filters.setSourceFilter).toHaveBeenCalledWith("tauri")
    expect(filters.setSessionFilter).toHaveBeenCalledWith("s1")
    expect(filters.setTimeRange).toHaveBeenCalledWith("1h")
    expect(filters.setTraceFocusId).toHaveBeenCalledWith("t-1")
    expect(filters.setDiagnosticTransportFilter).toHaveBeenCalledWith("remote")
    expect(filters.setBookmarkFilterActive).toHaveBeenCalledWith(true)
    expect(filters.setViewMode).toHaveBeenCalledWith("dashboard")
    expect(filters.setDensity).toHaveBeenCalledWith("compact")
  })

  it("opens a legacy hsev=1 link on the Error tab", () => {
    seedUrl("hsev=1")
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setLevelFilter).toHaveBeenCalledWith("error")
    // ...and never writes the flag back.
    expect(new URLSearchParams(window.location.search).get("hsev")).toBeNull()
  })

  it("lets an explicit level win over the legacy hsev flag", () => {
    seedUrl("level=warn&hsev=1")
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setLevelFilter).toHaveBeenCalledTimes(1)
    expect(filters.setLevelFilter).toHaveBeenCalledWith("warn")
  })

  it("drops stale pagination keys from a shared link", () => {
    seedUrl("page=3&size=100&q=x")
    const filters = makeFilters({ searchQuery: "x" })
    renderHook(() => useLogPanelUrlSync(filters))
    const params = new URLSearchParams(window.location.search)
    expect(params.get("page")).toBeNull()
    expect(params.get("size")).toBeNull()
  })

  it("parses from/to into a customTimeRange when both are valid", () => {
    const fromMs = Date.UTC(2026, 0, 1)
    const toMs = Date.UTC(2026, 0, 2)
    seedUrl(`from=${fromMs}&to=${toMs}`)
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setCustomTimeRange).toHaveBeenCalledWith({
      start: new Date(fromMs),
      end: new Date(toMs),
    })
  })

  it("silently ignores malformed values without throwing", () => {
    seedUrl("level=garbage&view=garbage&t=garbage&src=garbage&page=NaN&size=abc")
    const filters = makeFilters()
    expect(() => renderHook(() => useLogPanelUrlSync(filters))).not.toThrow()
    expect(filters.setLevelFilter).not.toHaveBeenCalled()
    expect(filters.setViewMode).not.toHaveBeenCalled()
    expect(filters.setTimeRange).not.toHaveBeenCalled()
    expect(filters.setSourceFilter).not.toHaveBeenCalled()
  })

  it("ignores from/to when reversed or non-numeric", () => {
    const fromMs = Date.UTC(2026, 0, 2)
    const toMs = Date.UTC(2026, 0, 1)
    seedUrl(`from=${fromMs}&to=${toMs}`)
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setCustomTimeRange).not.toHaveBeenCalled()
  })

  it("prefers the live URL over a stale router snapshot", () => {
    // A host that seeds the panel with `history.replaceState` and remounts it
    // (the /logs Traces → Logs jump) beats `useSearchParams()` to the punch.
    mockSearchParams.mockReturnValue(new URLSearchParams())
    window.history.replaceState({}, "", "/logs?trace=t-9")
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setTraceFocusId).toHaveBeenCalledWith("t-9")
  })

  it("does not re-apply hydration when filters object changes after mount", () => {
    seedUrl("q=initial")
    const filters = makeFilters()
    const { rerender } = renderHook(({ f }) => useLogPanelUrlSync(f), {
      initialProps: { f: filters },
    })
    expect(filters.setSearchQuery).toHaveBeenCalledTimes(1)
    rerender({ f: { ...filters, searchQuery: "changed" } as LogPanelFilterState })
    expect(filters.setSearchQuery).toHaveBeenCalledTimes(1)
  })
})

describe("useLogPanelUrlSync — deep-linked selection", () => {
  const entry = { id: "log-7", timestamp: "2026-01-01T00:00:00.000Z" } as never

  it("keeps sel in the URL until the logs load, then selects the entry", () => {
    seedUrl("sel=log-7&detail=1")
    const filters = makeFilters()
    const { rerender } = renderHook(
      ({ f, logs, ready }: { f: LogPanelFilterState; logs: never[]; ready: boolean }) =>
        useLogPanelUrlSync(f, { logs, logsReady: ready }),
      { initialProps: { f: filters, logs: [] as never[], ready: false } }
    )
    expect(filters.setSelectedLog).not.toHaveBeenCalled()
    let params = new URLSearchParams(window.location.search)
    expect(params.get("sel")).toBe("log-7")
    expect(params.get("detail")).toBe("1")

    rerender({ f: filters, logs: [entry], ready: true })
    expect(filters.setSelectedLog).toHaveBeenCalledWith(entry)
    expect(filters.setShowDetailPanel).toHaveBeenCalledWith(true)
    // The panel's state now carries the selection; the URL keeps describing it.
    rerender({
      f: { ...filters, selectedLog: entry, showDetailPanel: true } as LogPanelFilterState,
      logs: [entry],
      ready: true,
    })
    params = new URLSearchParams(window.location.search)
    expect(params.get("sel")).toBe("log-7")
    expect(params.get("detail")).toBe("1")
  })

  it("does not open the pane when the link only selected the entry", () => {
    seedUrl("sel=log-7")
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters, { logs: [entry], logsReady: true }))
    expect(filters.setSelectedLog).toHaveBeenCalledWith(entry)
    expect(filters.setShowDetailPanel).not.toHaveBeenCalled()
  })

  it("drops a selection the finished load does not contain", () => {
    seedUrl("sel=gone&detail=1")
    const filters = makeFilters()
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useLogPanelUrlSync(filters, { logs: [], logsReady: ready }),
      { initialProps: { ready: false } }
    )
    rerender({ ready: true })
    expect(filters.setSelectedLog).not.toHaveBeenCalled()
    const params = new URLSearchParams(window.location.search)
    expect(params.get("sel")).toBeNull()
    expect(params.get("detail")).toBeNull()
  })

  it("ignores a bare detail=1 with nothing selected", () => {
    seedUrl("detail=1")
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters, { logs: [], logsReady: true }))
    expect(filters.setShowDetailPanel).not.toHaveBeenCalled()
    expect(new URLSearchParams(window.location.search).get("detail")).toBeNull()
  })
})

describe("useLogPanelUrlSync — writes to URL on state change", () => {
  it("writes a fully-encoded query string for non-default state", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams())
    const fromMs = Date.UTC(2026, 0, 1)
    const toMs = Date.UTC(2026, 0, 2)
    const filters = makeFilters({
      searchQuery: "boom",
      useRegex: true,
      levelFilter: "error",
      moduleFilter: "api",
      sourceFilter: "mcp",
      sessionFilter: "  s2  ",
      timeRange: "6h",
      customTimeRange: { start: new Date(fromMs), end: new Date(toMs) },
      traceFocusId: "t-42",
      diagnosticTransportFilter: "remote",
      bookmarkFilterActive: true,
      viewMode: "dashboard",
      showDetailPanel: true,
      selectedLog: { id: "log-1" } as never,
      density: "spacious",
    })
    renderHook(() => useLogPanelUrlSync(filters))
    const url = window.location.search
    expect(url).toContain("q=boom")
    expect(url).toContain("density=spacious")
    expect(url).toContain("re=1")
    expect(url).toContain("level=error")
    expect(url).toContain("module=api")
    expect(url).toContain("src=mcp")
    expect(url).toContain("session=s2")
    expect(url).toContain("t=6h")
    expect(url).toContain(`from=${fromMs}`)
    expect(url).toContain(`to=${toMs}`)
    expect(url).toContain("trace=t-42")
    expect(url).toContain("dx=remote")
    expect(url).toContain("bm=1")
    expect(url).not.toContain("hsev")
    expect(url).toContain("view=dashboard")
    expect(url).toContain("detail=1")
    expect(url).toContain("sel=log-1")
  })

  it("drops detail=1 when nothing is selected", () => {
    const filters = makeFilters({ showDetailPanel: true, selectedLog: null })
    renderHook(() => useLogPanelUrlSync(filters))
    expect(new URLSearchParams(window.location.search).get("detail")).toBeNull()
  })

  it("omits default values to keep the URL clean", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams())
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(window.location.search).toBe("")
  })

  it("preserves host-owned params it does not own", () => {
    // `/logs` keeps its channel + selected trace in the query string; a filter
    // change used to wipe them because the write pass rebuilt from empty.
    window.history.replaceState({}, "", "/logs?channel=traces&traceId=abc")
    mockSearchParams.mockReturnValue(new URLSearchParams("channel=traces&traceId=abc"))
    const filters = makeFilters({ searchQuery: "boom", levelFilter: "error" })
    renderHook(() => useLogPanelUrlSync(filters))
    const params = new URLSearchParams(window.location.search)
    expect(params.get("channel")).toBe("traces")
    expect(params.get("traceId")).toBe("abc")
    expect(params.get("q")).toBe("boom")
    expect(params.get("level")).toBe("error")
  })

  it("clears its own stale params instead of accumulating them", () => {
    window.history.replaceState({}, "", "/logs?channel=traces&q=old&level=warn&view=dashboard")
    mockSearchParams.mockReturnValue(new URLSearchParams("channel=traces"))
    const filters = makeFilters({ searchQuery: "new" })
    renderHook(() => useLogPanelUrlSync(filters))
    const params = new URLSearchParams(window.location.search)
    expect(params.get("q")).toBe("new")
    expect(params.get("level")).toBeNull()
    expect(params.get("view")).toBeNull()
    expect(params.get("channel")).toBe("traces")
  })

  it("does not duplicate writes when nothing changed", () => {
    const spy = jest.spyOn(window.history, "replaceState")
    mockSearchParams.mockReturnValue(new URLSearchParams())
    const filters = makeFilters({ searchQuery: "x" })
    const { rerender } = renderHook(({ f }) => useLogPanelUrlSync(f), {
      initialProps: { f: filters },
    })
    const callsAfterFirst = spy.mock.calls.length
    act(() => {
      rerender({ f: filters })
    })
    expect(spy.mock.calls.length).toBe(callsAfterFirst)
    spy.mockRestore()
  })
})
