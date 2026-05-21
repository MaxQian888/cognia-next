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
    highSeverityOnly: false,
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
    currentPage: 1,
    pageSize: 50,
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
    setHighSeverityOnly: jest.fn() as unknown as LogPanelFilterState["setHighSeverityOnly"],
    setTimeRange: jest.fn() as unknown as LogPanelFilterState["setTimeRange"],
    setCustomTimeRange: jest.fn() as unknown as LogPanelFilterState["setCustomTimeRange"],
    setTraceFocusId: jest.fn() as unknown as LogPanelFilterState["setTraceFocusId"],
    setAutoScroll: noop,
    setViewMode: jest.fn() as unknown as LogPanelFilterState["setViewMode"],
    setSelectedLog: noop,
    setShowDetailPanel: jest.fn() as unknown as LogPanelFilterState["setShowDetailPanel"],
    setSelectedTransportHealthName: noop,
    setSelectedNativeLogging: noop,
    setDiagnosticTransportFilter:
      jest.fn() as unknown as LogPanelFilterState["setDiagnosticTransportFilter"],
    setFocusedIndex: noop,
    setCurrentPage: jest.fn() as unknown as LogPanelFilterState["setCurrentPage"],
    setPageSize: jest.fn() as unknown as LogPanelFilterState["setPageSize"],
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

describe("useLogPanelUrlSync — hydration from URL", () => {
  it("applies parsed search params on mount", () => {
    mockSearchParams.mockReturnValue(
      new URLSearchParams(
        "q=login&re=1&level=error&module=auth&src=tauri&session=s1&t=1h&trace=t-1&dx=remote&bm=1&hsev=1&view=dashboard&page=3&size=100&detail=1&density=compact"
      )
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
    expect(filters.setHighSeverityOnly).toHaveBeenCalledWith(true)
    expect(filters.setViewMode).toHaveBeenCalledWith("dashboard")
    expect(filters.setCurrentPage).toHaveBeenCalledWith(3)
    expect(filters.setPageSize).toHaveBeenCalledWith(100)
    expect(filters.setShowDetailPanel).toHaveBeenCalledWith(true)
    expect(filters.setDensity).toHaveBeenCalledWith("compact")
  })

  it("parses from/to into a customTimeRange when both are valid", () => {
    const fromMs = Date.UTC(2026, 0, 1)
    const toMs = Date.UTC(2026, 0, 2)
    mockSearchParams.mockReturnValue(new URLSearchParams(`from=${fromMs}&to=${toMs}`))
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setCustomTimeRange).toHaveBeenCalledWith({
      start: new Date(fromMs),
      end: new Date(toMs),
    })
  })

  it("silently ignores malformed values without throwing", () => {
    mockSearchParams.mockReturnValue(
      new URLSearchParams("level=garbage&view=garbage&t=garbage&src=garbage&page=NaN&size=abc")
    )
    const filters = makeFilters()
    expect(() => renderHook(() => useLogPanelUrlSync(filters))).not.toThrow()
    expect(filters.setLevelFilter).not.toHaveBeenCalled()
    expect(filters.setViewMode).not.toHaveBeenCalled()
    expect(filters.setTimeRange).not.toHaveBeenCalled()
    expect(filters.setSourceFilter).not.toHaveBeenCalled()
    expect(filters.setCurrentPage).not.toHaveBeenCalled()
    expect(filters.setPageSize).not.toHaveBeenCalled()
  })

  it("ignores from/to when reversed or non-numeric", () => {
    const fromMs = Date.UTC(2026, 0, 2)
    const toMs = Date.UTC(2026, 0, 1)
    mockSearchParams.mockReturnValue(new URLSearchParams(`from=${fromMs}&to=${toMs}`))
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(filters.setCustomTimeRange).not.toHaveBeenCalled()
  })

  it("does not re-apply hydration when filters object changes after mount", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams("q=initial"))
    const filters = makeFilters()
    const { rerender } = renderHook(({ f }) => useLogPanelUrlSync(f), {
      initialProps: { f: filters },
    })
    expect(filters.setSearchQuery).toHaveBeenCalledTimes(1)
    rerender({ f: { ...filters, searchQuery: "changed" } as LogPanelFilterState })
    expect(filters.setSearchQuery).toHaveBeenCalledTimes(1)
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
      highSeverityOnly: true,
      viewMode: "dashboard",
      currentPage: 4,
      pageSize: 100,
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
    expect(url).toContain("hsev=1")
    expect(url).toContain("view=dashboard")
    expect(url).toContain("page=4")
    expect(url).toContain("size=100")
    expect(url).toContain("detail=1")
    expect(url).toContain("sel=log-1")
  })

  it("omits default values to keep the URL clean", () => {
    mockSearchParams.mockReturnValue(new URLSearchParams())
    const filters = makeFilters()
    renderHook(() => useLogPanelUrlSync(filters))
    expect(window.location.search).toBe("")
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
