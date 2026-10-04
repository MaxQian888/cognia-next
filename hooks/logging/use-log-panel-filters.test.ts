/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

jest.mock("@cognia/logging/filter-presets", () => ({
  LOG_FILTER_PRESETS_STORAGE_KEY: "log-filter-presets",
  loadLogFilterPresets: (raw: string | null) => (raw ? JSON.parse(raw) : []),
  serializeLogFilterPresets: (next: unknown) => JSON.stringify(next),
  createLogFilterPreset: (name: string, filters: unknown) => ({
    id: `id-${name}`,
    name,
    filters,
  }),
}))

import {
  autoRefreshStorageKey,
  resolvePresetFacets,
  useLogPanelFilters,
} from "./use-log-panel-filters"

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
    act(() => result.current.handleSelectLog(log))
    act(() => result.current.handleFocusTrace("trace-1", log))
    expect(result.current.traceFocusId).toBe("trace-1")
    expect(result.current.moduleFilter).toBe("all")
    act(() => result.current.handleFocusSession("session-1", log))
    expect(result.current.sessionFilter).toBe("session-1")
    // Focusing keeps whatever the detail pane was doing.
    expect(result.current.showDetailPanel).toBe(true)
  })

  it("handleFocusTrace does not open a closed detail pane", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const log = { id: "x" } as never
    act(() => result.current.handleFocusTrace("trace-1", log))
    expect(result.current.traceFocusId).toBe("trace-1")
    expect(result.current.selectedLog).toBe(log)
    expect(result.current.showDetailPanel).toBe(false)
  })

  it("handleFocusSession does not open a closed detail pane", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const log = { id: "x" } as never
    act(() => result.current.handleFocusSession("session-1", log))
    expect(result.current.sessionFilter).toBe("session-1")
    expect(result.current.showDetailPanel).toBe(false)
  })

  it("saveCurrentPreset stores the given name, trimmed", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.saveCurrentPreset("  Errors in chat  "))
    expect(result.current.presets[0].name).toBe("Errors in chat")
    expect(result.current.activePresetId).toBe(result.current.presets[0].id)
  })

  it("saveCurrentPreset falls back to a numbered name when the name is blank", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.saveCurrentPreset("   "))
    expect(result.current.presets[0].name).toBe("#1")
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

  it("exposes customTimeRange and density with sensible defaults, and no pagination", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.customTimeRange).toBeNull()
    expect(result.current.density).toBe("comfortable")
    // The list is virtualized over the whole window; there is no page state.
    expect(result.current).not.toHaveProperty("currentPage")
    expect(result.current).not.toHaveProperty("pageSize")
    expect(result.current).not.toHaveProperty("highSeverityOnly")
  })

  it("loads density from localStorage on mount and persists changes", () => {
    localStorage.setItem("cognia-log-density", "compact")
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.density).toBe("compact")
    act(() => result.current.setDensity("spacious"))
    expect(result.current.density).toBe("spacious")
    expect(localStorage.getItem("cognia-log-density")).toBe("spacious")
  })

  it("defers to a host-controlled density and stops writing localStorage", () => {
    // The `/logs` workspace keeps its own density preference; without this the
    // page rendered two density controls whose values drifted apart.
    localStorage.setItem("cognia-log-density", "compact")
    const onDensityChange = jest.fn()
    const { result } = renderHook(() =>
      useLogPanelFilters({ density: "spacious", onDensityChange })
    )
    expect(result.current.density).toBe("spacious")

    act(() => result.current.setDensity("comfortable"))
    expect(onDensityChange).toHaveBeenCalledWith("comfortable")
    // the host owns it, so nothing was written behind its back
    expect(localStorage.getItem("cognia-log-density")).toBe("compact")
  })

  it("stays uncontrolled when a density arrives without a way to write it back", () => {
    const { result } = renderHook(() => useLogPanelFilters({ density: "spacious" }))
    expect(result.current.density).toBe("comfortable")
    act(() => result.current.setDensity("compact"))
    expect(result.current.density).toBe("compact")
    expect(localStorage.getItem("cognia-log-density")).toBe("compact")
  })

  it("ignores stored density values that are not in the valid set", () => {
    localStorage.setItem("cognia-log-density", "wat")
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.density).toBe("comfortable")
  })

  it("setCustomTimeRange updates its slot", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const range = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-02T00:00:00Z") }
    act(() => {
      result.current.setCustomTimeRange(range)
    })
    expect(result.current.customTimeRange).toEqual(range)
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
    expect(result.current.useRegex).toBe(true)
    expect(result.current.traceFocusId).toBe("t-1")
    expect(result.current.focusedIndex).toBe(3)
    expect(result.current.viewMode).toBe("dashboard")
  })
})

describe("autoRefresh persistence", () => {
  it("persists the auto-refresh toggle to localStorage", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.setAutoRefresh(true))
    expect(result.current.autoRefresh).toBe(true)
    expect(localStorage.getItem("cognia-log-auto-refresh")).toBe("1")
    act(() => result.current.setAutoRefresh(false))
    expect(localStorage.getItem("cognia-log-auto-refresh")).toBe("0")
  })

  it("restores the persisted value on a fresh mount, overriding the default", () => {
    localStorage.setItem("cognia-log-auto-refresh", "1")
    const { result } = renderHook(() => useLogPanelFilters())
    expect(result.current.autoRefresh).toBe(true)

    localStorage.setItem("cognia-log-auto-refresh", "0")
    const { result: second } = renderHook(() => useLogPanelFilters({ defaultAutoRefresh: true }))
    expect(second.current.autoRefresh).toBe(false)
  })

  it("falls back to defaultAutoRefresh when nothing is stored", () => {
    const { result } = renderHook(() => useLogPanelFilters({ defaultAutoRefresh: true }))
    expect(result.current.autoRefresh).toBe(true)
  })
})

describe("presets carry every facet", () => {
  it("saves and restores source, session, custom range, trace and transport", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    const range = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-02T00:00:00Z") }
    act(() => {
      result.current.setSourceFilter("mcp")
      result.current.setSessionFilter("  s-1 ")
      result.current.setCustomTimeRange(range)
      result.current.setTraceFocusId("t-1")
      result.current.setDiagnosticTransportFilter("remote")
    })
    act(() => result.current.saveCurrentPreset("Everything"))
    const saved = result.current.presets[0].filters
    expect(saved).toMatchObject({
      sourceFilter: "mcp",
      sessionFilter: "s-1",
      customTimeRange: { start: range.start.getTime(), end: range.end.getTime() },
      traceFocusId: "t-1",
      diagnosticTransportFilter: "remote",
    })

    act(() => {
      result.current.setSourceFilter("all")
      result.current.setSessionFilter("")
      result.current.setCustomTimeRange(null)
      result.current.setTraceFocusId(null)
      result.current.setDiagnosticTransportFilter(null)
      result.current.setBookmarkFilterActive(true)
    })
    act(() => result.current.handlePresetChange(result.current.presets[0].id))
    expect(result.current.sourceFilter).toBe("mcp")
    expect(result.current.sessionFilter).toBe("s-1")
    expect(result.current.customTimeRange).toEqual(range)
    expect(result.current.traceFocusId).toBe("t-1")
    expect(result.current.diagnosticTransportFilter).toBe("remote")
    expect(result.current.bookmarkFilterActive).toBe(false)
  })

  it("stops naming the preset once a filter diverges, and names it again when restored", () => {
    const { result } = renderHook(() => useLogPanelFilters())
    act(() => result.current.setLevelFilter("warn"))
    act(() => result.current.saveCurrentPreset("Warnings"))
    const id = result.current.presets[0].id
    expect(result.current.activePresetId).toBe(id)
    act(() => result.current.setTimeRange("1h"))
    expect(result.current.activePresetId).toBe(result.current.EMPTY_PRESET_VALUE)
    act(() => result.current.setTimeRange("all"))
    expect(result.current.activePresetId).toBe(id)
  })

  it("opens the Error tab for a legacy 'all + high severity' preset", () => {
    localStorage.setItem(
      "log-filter-presets",
      JSON.stringify([
        {
          id: "legacy",
          name: "Legacy",
          filters: {
            levelFilter: "all",
            moduleFilter: "all",
            timeRange: "all",
            searchQuery: "",
            useRegex: false,
            highSeverityOnly: true,
          },
        },
      ])
    )
    const { result } = renderHook(() => useLogPanelFilters({ sources: ["mcp"] }))
    act(() => result.current.setSourceFilter("all"))
    act(() => result.current.handlePresetChange("legacy"))
    expect(result.current.levelFilter).toBe("error")
    // An absent source restores this embed's own default, not "all".
    expect(result.current.sourceFilter).toBe("mcp")
    expect(result.current.activePresetId).toBe("legacy")
  })

  it("drops malformed optional facets instead of loading them into state", () => {
    const filters = {
      levelFilter: "info",
      moduleFilter: "m",
      timeRange: "24h",
      searchQuery: "",
      useRegex: false,
      highSeverityOnly: false,
      sourceFilter: "nonsense",
      sessionFilter: 42,
      customTimeRange: { start: 10, end: 5 },
      traceFocusId: "",
    } as unknown as Parameters<typeof resolvePresetFacets>[0]
    expect(resolvePresetFacets(filters, "all")).toEqual({
      levelFilter: "info",
      moduleFilter: "m",
      timeRange: "24h",
      searchQuery: "",
      useRegex: false,
      sourceFilter: "all",
      sessionFilter: "",
      customTimeRange: null,
      traceFocusId: null,
      diagnosticTransportFilter: null,
    })
  })
})

describe("autoRefresh storage scope", () => {
  it("keeps the unscoped key for the default embed", () => {
    expect(autoRefreshStorageKey()).toBe("cognia-log-auto-refresh")
    expect(autoRefreshStorageKey("  ")).toBe("cognia-log-auto-refresh")
    expect(autoRefreshStorageKey("settings-mcp")).toBe("cognia-log-auto-refresh:settings-mcp")
  })

  it("a scoped embed neither reads nor overwrites the /logs preference", () => {
    localStorage.setItem("cognia-log-auto-refresh", "0")
    const { result } = renderHook(() =>
      useLogPanelFilters({ defaultAutoRefresh: true, storageScope: "settings-mcp" })
    )
    expect(result.current.autoRefresh).toBe(true)
    act(() => result.current.setAutoRefresh(false))
    expect(localStorage.getItem("cognia-log-auto-refresh:settings-mcp")).toBe("0")
    act(() => result.current.setAutoRefresh(true))
    expect(localStorage.getItem("cognia-log-auto-refresh:settings-mcp")).toBe("1")
    expect(localStorage.getItem("cognia-log-auto-refresh")).toBe("0")
  })
})
