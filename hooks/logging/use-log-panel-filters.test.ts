/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/logging/filter-presets", () => ({
  LOG_FILTER_PRESETS_STORAGE_KEY: "log-filter-presets",
  loadLogFilterPresets: (raw: string | null) => (raw ? JSON.parse(raw) : []),
  serializeLogFilterPresets: (next: unknown) => JSON.stringify(next),
  createLogFilterPreset: (name: string, filters: unknown) => ({
    id: `id-${name}`,
    name,
    filters,
  }),
}))

import { useLogPanelFilters } from "./use-log-panel-filters"

beforeEach(() => {
  localStorage.clear()
})

describe("useLogPanelFilters", () => {
  it("initializes with sensible defaults", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.autoRefresh).toBe(false)
    expect(result.current.levelFilter).toBe("all")
    expect(result.current.moduleFilter).toBe("all")
    expect(result.current.sourceFilter).toBe("all")
    expect(result.current.viewMode).toBe("list")
    expect(result.current.bookmarkedIds.size).toBe(0)
    expect(result.current.searchHistory).toEqual([])
  })

  it("respects defaultAutoRefresh & sources options", () => {
    const { result } = renderHook(() =>
      useLogPanelFilters({ defaultAutoRefresh: true, sources: ["frontend"] })
    )
    expect(result.current.autoRefresh).toBe(true)
    expect(result.current.sourceFilter).toBe("frontend")
  })

  it("toggleExpanded adds and removes ids", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.toggleExpanded("a"))
    expect(result.current.expandedIds.has("a")).toBe(true)
    act(() => result.current.toggleExpanded("a"))
    expect(result.current.expandedIds.has("a")).toBe(false)
  })

  it("toggleBookmark persists to localStorage", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.toggleBookmark("log-1"))
    expect(result.current.bookmarkedIds.has("log-1")).toBe(true)
    expect(JSON.parse(localStorage.getItem("cognia-log-bookmarks")!)).toEqual(["log-1"])
    act(() => result.current.toggleBookmark("log-1"))
    expect(result.current.bookmarkedIds.has("log-1")).toBe(false)
  })

  it("preset CRUD: save / apply / handlePresetChange / removeActivePreset", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => {
      result.current.setLevelFilter("error")
      result.current.setSearchQuery("hello")
    })
    act(() => result.current.saveCurrentPreset())
    expect(result.current.presets).toHaveLength(1)
    act(() => result.current.setLevelFilter("info"))
    const presetId = result.current.presets[0].id
    act(() => result.current.handlePresetChange(presetId))
    expect(result.current.levelFilter).toBe("error")
    act(() => result.current.removeActivePreset())
    expect(result.current.presets).toHaveLength(0)
  })

  it("handlePresetChange with EMPTY_PRESET_VALUE clears active preset", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.handlePresetChange(result.current.EMPTY_PRESET_VALUE))
    expect(result.current.activePresetId).toBe(result.current.EMPTY_PRESET_VALUE)
  })

  it("handleSelectLog opens the detail panel", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const log = { id: "x" } as never
    act(() => result.current.handleSelectLog(log))
    expect(result.current.selectedLog).toBe(log)
    expect(result.current.showDetailPanel).toBe(true)
  })

  it("handleFocusTrace + handleFocusSession update derived state", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const log = { id: "x" } as never
    act(() => result.current.handleFocusTrace("trace-1", log))
    expect(result.current.traceFocusId).toBe("trace-1")
    expect(result.current.moduleFilter).toBe("all")
    act(() => result.current.handleFocusSession("session-1", log))
    expect(result.current.sessionFilter).toBe("session-1")
    expect(result.current.showDetailPanel).toBe(false)
  })

  it("addSearchHistory dedupes and caps at 5", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => {
      ;["a", "b", "c", "d", "e", "f"].forEach((q) => result.current.addSearchHistory(q))
      result.current.addSearchHistory("a")
    })
    expect(result.current.searchHistory).toHaveLength(5)
    expect(result.current.searchHistory[0]).toBe("a")
  })

  it("removeSearchHistoryItem and clearSearchHistory work", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => {
      result.current.addSearchHistory("a")
      result.current.addSearchHistory("b")
    })
    act(() => result.current.removeSearchHistoryItem("a"))
    expect(result.current.searchHistory).toEqual(["b"])
    act(() => result.current.clearSearchHistory())
    expect(result.current.searchHistory).toEqual([])
  })

  it("loads bookmarks from localStorage on mount", () => {
    localStorage.setItem("cognia-log-bookmarks", JSON.stringify(["seed"]))
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.bookmarkedIds.has("seed")).toBe(true)
  })

  it("loads search history from localStorage on mount", () => {
    localStorage.setItem("log-panel-search-history", JSON.stringify(["foo"]))
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.searchHistory).toEqual(["foo"])
  })

  it("exposes customTimeRange, currentPage, pageSize, and density with sensible defaults", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.customTimeRange).toBeNull()
    expect(result.current.currentPage).toBe(1)
    expect(result.current.pageSize).toBe(50)
    expect(result.current.density).toBe("comfortable")
  })

  it("loads density from localStorage on mount and persists changes", () => {
    localStorage.setItem("cognia-log-density", "compact")
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.density).toBe("compact")
    act(() => result.current.setDensity("spacious"))
    expect(result.current.density).toBe("spacious")
    expect(localStorage.getItem("cognia-log-density")).toBe("spacious")
  })

  it("ignores stored density values that are not in the valid set", () => {
    localStorage.setItem("cognia-log-density", "wat")
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.density).toBe("comfortable")
  })

  it("setCustomTimeRange / setCurrentPage / setPageSize update their slots", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const range = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-02T00:00:00Z") }
    act(() => {
      result.current.setCustomTimeRange(range)
      result.current.setCurrentPage(4)
      result.current.setPageSize(100)
    })
    expect(result.current.customTimeRange).toEqual(range)
    expect(result.current.currentPage).toBe(4)
    expect(result.current.pageSize).toBe(100)
    act(() => result.current.setCustomTimeRange(null))
    expect(result.current.customTimeRange).toBeNull()
  })

  it("misc setters flip their respective slots", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => {
      result.current.setAutoScroll(false)
      result.current.setShowAdvancedFilters(true)
      result.current.setShowShortcutsDialog(true)
      result.current.setBookmarkFilterActive(true)
      result.current.setSelectedTransportHealthName("xx")
      result.current.setSelectedNativeLogging(true)
      result.current.setDiagnosticTransportFilter("yy")
      result.current.setHighSeverityOnly(true)
      result.current.setUseRegex(true)
      result.current.setTimeRange("1h" as never)
      result.current.setTraceFocusId("t-1")
      result.current.setFocusedIndex(3)
      result.current.setViewMode("dashboard")
    })
    expect(result.current.autoScroll).toBe(false)
    expect(result.current.showAdvancedFilters).toBe(true)
    expect(result.current.showShortcutsDialog).toBe(true)
    expect(result.current.bookmarkFilterActive).toBe(true)
    expect(result.current.selectedTransportHealthName).toBe("xx")
    expect(result.current.selectedNativeLogging).toBe(true)
    expect(result.current.diagnosticTransportFilter).toBe("yy")
    expect(result.current.highSeverityOnly).toBe(true)
    expect(result.current.useRegex).toBe(true)
    expect(result.current.traceFocusId).toBe("t-1")
    expect(result.current.focusedIndex).toBe(3)
    expect(result.current.viewMode).toBe("dashboard")
  })
})
