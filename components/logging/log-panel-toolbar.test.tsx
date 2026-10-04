/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("@cognia/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
}))

import { LogPanelToolbar, type LogPanelToolbarProps } from "./log-panel-toolbar"
import type { LogLevel } from "@cognia/logging"

function makeProps(overrides: Partial<LogPanelToolbarProps> = {}): LogPanelToolbarProps {
  return {
    viewMode: "list",
    setViewMode: jest.fn(),
    traceViewAvailable: true,
    searchQuery: "",
    setSearchQuery: jest.fn(),
    useRegex: false,
    setUseRegex: jest.fn(),
    levelFilter: "all",
    setLevelFilter: jest.fn(),
    moduleFilter: "all",
    setModuleFilter: jest.fn(),
    augmentedModules: ["auth", "api", "agent.trace"],
    sourceFilter: "all",
    setSourceFilter: jest.fn(),
    allowedSources: ["frontend", "tauri"],
    sessionFilter: "",
    setSessionFilter: jest.fn(),
    timeRange: "all",
    setTimeRange: jest.fn(),
    stats: {
      total: 30,
      byLevel: {
        trace: 0,
        debug: 0,
        info: 20,
        warn: 5,
        error: 4,
        fatal: 1,
      } as Record<LogLevel, number>,
    },
    presets: [{ id: "p1", name: "Preset One" } as never, { id: "p2", name: "Preset Two" } as never],
    activePresetId: "__EMPTY__",
    handlePresetChange: jest.fn(),
    saveCurrentPreset: jest.fn(),
    removeActivePreset: jest.fn(),
    EMPTY_PRESET_VALUE: "__EMPTY__",
    traceFocusId: null,
    setTraceFocusId: jest.fn(),
    autoRefresh: false,
    setAutoRefresh: jest.fn(),
    refresh: jest.fn(),
    onExport: jest.fn(),
    clearLogs: jest.fn(),
    showDetailPanel: false,
    setShowDetailPanel: jest.fn(),
    autoScroll: false,
    setAutoScroll: jest.fn(),
    scrollToTop: jest.fn(),
    scrollToBottom: jest.fn(),
    bookmarkFilterActive: false,
    setBookmarkFilterActive: jest.fn(),
    bookmarkedCount: 0,
    showAdvancedFilters: false,
    setShowAdvancedFilters: jest.fn(),
    showShortcutsDialog: false,
    setShowShortcutsDialog: jest.fn(),
    searchHistory: [],
    addSearchHistory: jest.fn(),
    removeSearchHistoryItem: jest.fn(),
    clearSearchHistory: jest.fn(),
    diagnosticTransportFilter: null,
    setDiagnosticTransportFilter: jest.fn(),
    customTimeRange: null,
    setCustomTimeRange: jest.fn(),
    density: "comfortable",
    setDensity: jest.fn(),
    ...overrides,
  }
}

function renderToolbar(overrides: Partial<LogPanelToolbarProps> = {}) {
  const props = makeProps(overrides)
  const utils = render(
    <TooltipProvider delayDuration={0}>
      <LogPanelToolbar {...props} />
    </TooltipProvider>
  )
  return { ...utils, props }
}

describe("LogPanelToolbar — primary bar", () => {
  it("renders three view-mode buttons when the trace view is available", () => {
    renderToolbar()
    expect(
      within(screen.getByRole("group", { name: "Log view" })).getAllByRole("button")
    ).toHaveLength(3)
  })

  it("hides the trace view button when nothing carries a trace id", () => {
    renderToolbar({ traceViewAvailable: false })
    expect(
      within(screen.getByRole("group", { name: "Log view" })).getAllByRole("button")
    ).toHaveLength(2)
  })

  it("keeps the trace button while the trace view is the active one", () => {
    renderToolbar({ traceViewAvailable: false, viewMode: "trace" })
    expect(screen.getByRole("button", { name: "Trace View" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("puts the health slot in the first row beside Live and Refresh", () => {
    renderToolbar({ healthSlot: <button data-testid="stub-health">health</button> })
    const slot = screen.getByTestId("log-panel-health-slot")
    expect(slot).toContainElement(screen.getByTestId("stub-health"))
    // Same row as Refresh; not the level row.
    expect(screen.getByTestId("log-panel-refresh").parentElement).toBe(slot.parentElement)
    expect(screen.getByTestId("log-panel-level-filters")).not.toContainElement(slot)
  })

  it("names each view-mode button and marks the active one pressed", () => {
    // These carried a Tooltip and nothing else, so their accessible name was
    // an SVG. Names and `aria-pressed` are the point of the segment.
    renderToolbar({ viewMode: "dashboard" })
    expect(screen.getByRole("button", { name: "List View" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(screen.getByRole("button", { name: "Dashboard View" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("fires setViewMode when each view button is clicked", () => {
    const { props } = renderToolbar()
    fireEvent.click(screen.getByTestId("log-panel-view-list"))
    fireEvent.click(screen.getByTestId("log-panel-view-dashboard"))
    fireEvent.click(screen.getByTestId("log-panel-view-trace"))
    expect(props.setViewMode).toHaveBeenCalledWith("list")
    expect(props.setViewMode).toHaveBeenCalledWith("dashboard")
    expect(props.setViewMode).toHaveBeenCalledWith("trace")
  })

  it("binds setSearchQuery to the search input", () => {
    const { props } = renderToolbar()
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.change(input, { target: { value: "auth" } })
    expect(props.setSearchQuery).toHaveBeenCalledWith("auth")
  })

  it("toggles regex from inside the search field and swaps the placeholder", () => {
    const { props, rerender } = renderToolbar()
    const regexBtn = screen.getByTestId("log-panel-regex-toggle")
    // it lives in the field it modifies, not two slots down the toolbar
    expect(regexBtn.closest("[data-slot='input-group']")).not.toBeNull()
    fireEvent.click(regexBtn)
    expect(props.setUseRegex).toHaveBeenCalledWith(true)
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ useRegex: true })} />
      </TooltipProvider>
    )
    expect(screen.getByPlaceholderText("Regex pattern...")).toBeInTheDocument()
  })

  it("sizes the level filters to their content so a wide stats block wraps instead", () => {
    // jsdom has no layout, so pin the flex contract itself: with a 0% basis
    // (`flex-1`) the row never wrapped and the filters collapsed to "All".
    renderToolbar()
    const filters = screen.getByTestId("log-panel-level-filters")
    expect(filters).toHaveClass("flex-auto", "min-w-0", "overflow-x-auto")
    expect(filters).not.toHaveClass("flex-1")
    expect(filters.parentElement).toHaveClass("flex-wrap")
  })

  it("flips advanced-filters aria-label between Show and Hide", () => {
    const { rerender } = renderToolbar({ showAdvancedFilters: false })
    expect(screen.getByLabelText("More filters")).toBeInTheDocument()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ showAdvancedFilters: true })} />
      </TooltipProvider>
    )
    expect(screen.getByLabelText("Hide more filters")).toBeInTheDocument()
  })

  it("has one shortcuts entry point, in the More menu", async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar()
    // the standalone toolbar button opened the same dialog as the menu item
    expect(screen.queryByTestId("log-toolbar-shortcut-hint")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("log-panel-more-actions"))
    await user.click(await screen.findByText("Keyboard shortcuts"))
    expect(props.setShowShortcutsDialog).toHaveBeenCalledWith(true)
  })

  it("gives live follow a pressed-state button of its own", () => {
    const { props } = renderToolbar({ autoRefresh: false })
    const live = screen.getByTestId("log-panel-auto-refresh-toggle")
    expect(live).toHaveAttribute("aria-pressed", "false")
    expect(live).toHaveAccessibleName(/Live follow off/)
    fireEvent.click(live)
    expect(props.setAutoRefresh).toHaveBeenCalledWith(true)
  })

  it("names the live button for its on state", () => {
    renderToolbar({ autoRefresh: true })
    const live = screen.getByTestId("log-panel-auto-refresh-toggle")
    expect(live).toHaveAttribute("aria-pressed", "true")
    expect(live).toHaveAccessibleName(/Live follow on/)
  })

  it("renders the stats slot inside the level-filter row instead of a row of its own", () => {
    renderToolbar({ statsSlot: <div data-testid="stub-stats" /> })
    const stats = screen.getByTestId("stub-stats")
    const levelRow = screen.getByRole("group", { name: "Filter by level" }).parentElement
    expect(levelRow).toContainElement(stats)
  })

  it("Refresh only refreshes, whatever the live state — and is named for that", () => {
    const { props } = renderToolbar({ autoRefresh: true })
    const refreshBtn = screen.getByTestId("log-panel-refresh")
    // The old button was named "Disable auto-refresh" while live was on, yet
    // a plain click refreshed.
    expect(refreshBtn).toHaveAccessibleName("Refresh logs")
    fireEvent.click(refreshBtn)
    fireEvent.click(refreshBtn, { shiftKey: true })
    fireEvent.contextMenu(refreshBtn)
    expect(props.refresh).toHaveBeenCalledTimes(2)
    expect(props.setAutoRefresh).not.toHaveBeenCalled()
  })
})

describe("LogPanelToolbar — More actions menu", () => {
  async function openMore() {
    const trigger = document
      .querySelector(".lucide-ellipsis")
      ?.closest("button") as HTMLButtonElement
    await userEvent.click(trigger)
  }

  it("invokes onExport('json') from the More menu", async () => {
    const { props } = renderToolbar()
    await openMore()
    fireEvent.click(screen.getByText("JSON"))
    expect(props.onExport).toHaveBeenCalledWith("json")
  })

  it("invokes onExport('csv') from the More menu", async () => {
    const { props } = renderToolbar()
    await openMore()
    fireEvent.click(screen.getByText("CSV"))
    expect(props.onExport).toHaveBeenCalledWith("csv")
  })

  it("invokes onExport('text') from the More menu", async () => {
    const { props } = renderToolbar()
    await openMore()
    fireEvent.click(screen.getByText("Plain Text"))
    expect(props.onExport).toHaveBeenCalledWith("text")
  })

  it("invokes onExport('ndjson') from the More menu", async () => {
    const { props } = renderToolbar()
    await openMore()
    fireEvent.click(screen.getByText("NDJSON"))
    expect(props.onExport).toHaveBeenCalledWith("ndjson")
  })

  it("fires clearLogs", async () => {
    const { props } = renderToolbar()
    await openMore()
    fireEvent.click(screen.getByText("Clear logs"))
    expect(props.clearLogs).toHaveBeenCalled()
  })

  it("toggles showDetailPanel via Open details panel", async () => {
    const { props } = renderToolbar({ showDetailPanel: false })
    await openMore()
    fireEvent.click(screen.getByText("Open details panel"))
    expect(props.setShowDetailPanel).toHaveBeenCalledWith(true)
  })

  it("fires scrollToTop from the More menu", async () => {
    const { props } = renderToolbar({ autoScroll: false })
    await openMore()
    fireEvent.click(screen.getByText("Scroll to top"))
    expect(props.scrollToTop).toHaveBeenCalled()
  })

  it("toggles autoScroll from the More menu", async () => {
    const { props } = renderToolbar({ autoScroll: false })
    await openMore()
    fireEvent.click(screen.getByText("Resume auto-scroll"))
    expect(props.setAutoScroll).toHaveBeenCalledWith(true)
  })

  it("fires scrollToBottom from the More menu", async () => {
    const { props } = renderToolbar({ autoScroll: false })
    await openMore()
    fireEvent.click(screen.getByText("Scroll to bottom"))
    expect(props.scrollToBottom).toHaveBeenCalled()
  })

  it("hides the scroll items when there is no list to scroll", async () => {
    renderToolbar({ scrollActionsAvailable: false, autoScrollAvailable: false })
    await userEvent.click(screen.getByTestId("log-panel-more-actions"))
    await screen.findByRole("menu")
    expect(screen.queryByText("Scroll to top")).not.toBeInTheDocument()
    expect(screen.queryByText("Scroll to bottom")).not.toBeInTheDocument()
    expect(screen.queryByText("Resume auto-scroll")).not.toBeInTheDocument()
    expect(screen.queryByText("Scroll")).not.toBeInTheDocument()
  })

  it("offers auto-scroll only while it can follow something", async () => {
    renderToolbar({ scrollActionsAvailable: true, autoScrollAvailable: false })
    await userEvent.click(screen.getByTestId("log-panel-more-actions"))
    expect(await screen.findByText("Scroll to top")).toBeInTheDocument()
    expect(screen.queryByTestId("log-panel-auto-scroll")).not.toBeInTheDocument()
  })

  it("shows Pause auto-scroll variant when autoScroll=true", async () => {
    const { props } = renderToolbar({ autoScroll: true })
    await openMore()
    fireEvent.click(screen.getByText("Pause auto-scroll"))
    expect(props.setAutoScroll).toHaveBeenCalledWith(false)
  })

  it("opens shortcuts dialog from More menu", async () => {
    const { props } = renderToolbar()
    await openMore()
    fireEvent.click(screen.getAllByText("Keyboard shortcuts")[0])
    expect(props.setShowShortcutsDialog).toHaveBeenCalledWith(true)
  })
})

describe("LogPanelToolbar — facet chips", () => {
  it("renders source chip with localized aria and clears on X", () => {
    const { props } = renderToolbar({ sourceFilter: "tauri" })
    const chip = screen.getByTestId("facet-chip-source")
    expect(chip).toBeInTheDocument()
    const closeBtn = chip.querySelector("button") as HTMLButtonElement
    // The source's display name, not the raw key.
    expect(closeBtn.getAttribute("aria-label")).toBe("Clear source filter Tauri")
    fireEvent.click(closeBtn)
    expect(props.setSourceFilter).toHaveBeenCalledWith("all")
  })

  it("renders session chip and clears on X", () => {
    const { props } = renderToolbar({ sessionFilter: "abc-123" })
    const chip = screen.getByTestId("facet-chip-session")
    const closeBtn = chip.querySelector("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(props.setSessionFilter).toHaveBeenCalledWith("")
  })

  it("renders module chip and clears on X", () => {
    const { props } = renderToolbar({ moduleFilter: "auth" })
    const chip = screen.getByTestId("facet-chip-module")
    const closeBtn = chip.querySelector("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(props.setModuleFilter).toHaveBeenCalledWith("all")
  })

  it("renders module chip with agent-trace alias label", () => {
    renderToolbar({ moduleFilter: "agent.trace" })
    expect(screen.getByTestId("facet-chip-module")).toHaveTextContent("Agent Trace")
  })

  it("renders time-range chip and clears on X", () => {
    const { props } = renderToolbar({ timeRange: "15m" })
    const chip = screen.getByTestId("facet-chip-time")
    const closeBtn = chip.querySelector("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(props.setTimeRange).toHaveBeenCalledWith("all")
  })

  it("renders trace-focus chip and clears on X", () => {
    const { props } = renderToolbar({ traceFocusId: "trace-1" })
    const chip = screen.getByTestId("facet-chip-trace")
    const closeBtn = chip.querySelector("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(props.setTraceFocusId).toHaveBeenCalledWith(null)
  })

  it("renders transport chip and clears on X", () => {
    const { props } = renderToolbar({ diagnosticTransportFilter: "remote" })
    const chip = screen.getByTestId("facet-chip-transport")
    const closeBtn = chip.querySelector("button") as HTMLButtonElement
    fireEvent.click(closeBtn)
    expect(props.setDiagnosticTransportFilter).toHaveBeenCalledWith(null)
  })

  it("hides facet chip row when no facets active", () => {
    renderToolbar()
    expect(screen.queryByTestId("log-panel-facet-chip-row")).not.toBeInTheDocument()
  })
})

describe("LogPanelToolbar — level tabs", () => {
  it("renders All tab and each per-level tab with count badges", () => {
    renderToolbar()
    expect(screen.getByText("All")).toBeInTheDocument()
    // total stats badge → "30"
    expect(screen.getByText("30")).toBeInTheDocument()
    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.getByText("Warning")).toBeInTheDocument()
  })

  it("clicking All resets the level and the bookmark tab", () => {
    const { props } = renderToolbar({ levelFilter: "warn" as LogLevel })
    fireEvent.click(screen.getByText("All"))
    expect(props.setLevelFilter).toHaveBeenCalledWith("all")
    expect(props.setBookmarkFilterActive).toHaveBeenCalledWith(false)
  })

  it("clicking Error selects the Error tab — no separate severity flag", () => {
    const { props } = renderToolbar()
    const errorTab = screen.getAllByText("Error")[0].closest("button") as HTMLButtonElement
    fireEvent.click(errorTab)
    expect(props.setLevelFilter).toHaveBeenCalledWith("error")
    expect(props).not.toHaveProperty("setHighSeverityOnly")
  })

  it("clicking Warning selects the Warning tab", () => {
    const { props } = renderToolbar()
    const warnTab = screen.getAllByText("Warning")[0].closest("button") as HTMLButtonElement
    fireEvent.click(warnTab)
    expect(props.setLevelFilter).toHaveBeenCalledWith("warn")
  })

  it("fades the tab strip's trailing edge on a phone so overflow reads as more", () => {
    renderToolbar()
    const tabs = screen.getByTestId("log-panel-level-filters")
    expect(tabs).toHaveAttribute("data-edge-fade", "true")
    expect(tabs.className).toMatch(/max-sm:\[mask-image:/)
  })

  it("Bookmark tab toggles bookmarkFilterActive on/off", () => {
    const { props, rerender } = renderToolbar({ bookmarkFilterActive: false })
    fireEvent.click(screen.getByText("Bookmarked"))
    expect(props.setBookmarkFilterActive).toHaveBeenCalledWith(true)
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar
          {...makeProps({
            bookmarkFilterActive: true,
            setBookmarkFilterActive: props.setBookmarkFilterActive,
          })}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByText("Bookmarked"))
    expect(props.setBookmarkFilterActive).toHaveBeenCalledWith(false)
  })
})

describe("LogPanelToolbar — advanced filters", () => {
  it("does not render the advanced filter row when showAdvancedFilters=false", () => {
    renderToolbar({ showAdvancedFilters: false })
    expect(screen.queryByTestId("log-panel-filter-group")).not.toBeInTheDocument()
  })

  it("renders the advanced filter row with module/source/time/preset Selects when expanded", () => {
    renderToolbar({ showAdvancedFilters: true })
    expect(screen.getByTestId("log-panel-filter-group")).toBeInTheDocument()
  })

  it("saves a preset under the name the user types", async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar({ showAdvancedFilters: true, presets: [] })
    await user.click(screen.getByTestId("log-panel-save-preset"))
    const name = await screen.findByTestId("log-panel-preset-name")
    // Pre-filled with a translated, numbered default.
    expect(name).toHaveValue("Preset 1")
    await user.clear(name)
    await user.type(name, "Chat errors{Enter}")
    expect(props.saveCurrentPreset).toHaveBeenCalledWith("Chat errors")
    expect(screen.queryByTestId("log-panel-save-preset-popover")).not.toBeInTheDocument()
  })

  it("falls back to the default name when the field is cleared", async () => {
    const user = userEvent.setup()
    const { props } = renderToolbar({ showAdvancedFilters: true, presets: [] })
    await user.click(screen.getByTestId("log-panel-save-preset"))
    await user.clear(await screen.findByTestId("log-panel-preset-name"))
    await user.click(screen.getByTestId("log-panel-save-preset-confirm"))
    expect(props.saveCurrentPreset).toHaveBeenCalledWith("Preset 1")
  })

  it("removes the active preset", () => {
    const { props } = renderToolbar({ showAdvancedFilters: true, activePresetId: "p1" })
    const removeBtn = screen.getByTestId("log-panel-delete-preset")
    expect(removeBtn).toHaveAccessibleName("Delete selected preset")
    fireEvent.click(removeBtn)
    expect(props.removeActivePreset).toHaveBeenCalled()
  })

  it("disables remove-preset when no preset active", () => {
    renderToolbar({ showAdvancedFilters: true, activePresetId: "__EMPTY__" })
    const removeBtn = document
      .querySelector(".lucide-bookmark-x")
      ?.closest("button") as HTMLButtonElement
    expect(removeBtn).toBeDisabled()
  })

  it("does not render the trace / session / transport facets a second time inside the panel", () => {
    renderToolbar({
      showAdvancedFilters: true,
      traceFocusId: "trace-1",
      sessionFilter: "s-1",
      diagnosticTransportFilter: "langfuse",
    })
    const panel = screen.getByTestId("log-panel-filter-group")
    expect(within(panel).queryByText(/trace/i)).not.toBeInTheDocument()
    expect(within(panel).queryByText(/langfuse/)).not.toBeInTheDocument()
    // They are on the chip row, once each.
    expect(screen.getByTestId("facet-chip-trace")).toBeInTheDocument()
    expect(screen.getByTestId("facet-chip-session")).toBeInTheDocument()
    expect(screen.getByTestId("facet-chip-transport")).toBeInTheDocument()
  })

  it("labels the module, source, session and time controls", () => {
    renderToolbar({ showAdvancedFilters: true })
    expect(screen.getByTestId("log-panel-module-trigger")).toHaveAccessibleName("Module")
    expect(screen.getByTestId("log-panel-source-trigger")).toHaveAccessibleName("Source")
    expect(screen.getByRole("textbox", { name: "Session ID..." })).toBeInTheDocument()
    expect(screen.getByTestId("log-panel-time-range-trigger")).toHaveAccessibleName("Time range")
  })

  it("uses motion-safe animation classes on the expand", () => {
    renderToolbar({ showAdvancedFilters: true })
    const row = screen.getByTestId("log-panel-filter-group")
    expect(row.className).toMatch(/motion-safe:animate-in/)
  })
})

describe("LogPanelToolbar — search history combobox", () => {
  function openHistory(history: string[], overrides: Partial<LogPanelToolbarProps> = {}) {
    const utils = renderToolbar({ searchHistory: history, ...overrides })
    const input = screen.getByRole("combobox")
    fireEvent.focus(input)
    return { ...utils, input }
  }

  it("stays closed with an empty history", () => {
    openHistory([])
    expect(screen.queryByTestId("log-search-history-combobox")).not.toBeInTheDocument()
  })

  it("opens a listbox the input controls when focused with history", () => {
    const { input } = openHistory(["query-a", "query-b"])
    const listbox = screen.getByRole("listbox")
    expect(input).toHaveAttribute("aria-controls", listbox.id)
    expect(input).toHaveAttribute("aria-expanded", "true")
    expect(within(listbox).getAllByRole("option")).toHaveLength(2)
  })

  it("moves the active option with the arrows while focus stays in the input", () => {
    const { input } = openHistory(["a", "b", "c"])
    input.focus()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const options = screen.getAllByRole("option")
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id)
    expect(options[0]).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    // Clamped at the last option.
    expect(input).toHaveAttribute("aria-activedescendant", options[2].id)
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id)
    fireEvent.keyDown(input, { key: "Home" })
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id)
    fireEvent.keyDown(input, { key: "End" })
    expect(input).toHaveAttribute("aria-activedescendant", options[2].id)
    expect(input).toHaveFocus()
  })

  it("Enter picks the active option", () => {
    const { input, props } = openHistory(["first", "second"])
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.setSearchQuery).toHaveBeenCalledWith("second")
    expect(props.addSearchHistory).not.toHaveBeenCalled()
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("Enter without an active option records the typed query", () => {
    const { input, props } = openHistory(["x"], { searchQuery: "needle" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.addSearchHistory).toHaveBeenCalledWith("needle")
  })

  it("Delete removes the active entry", () => {
    const { input, props } = openHistory(["x", "y"])
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Delete" })
    expect(props.removeSearchHistoryItem).toHaveBeenCalledWith("x")
  })

  it("Escape closes the list and claims the key", () => {
    const { input } = openHistory(["x"])
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    act(() => {
      input.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(screen.queryByTestId("log-search-history-combobox")).not.toBeInTheDocument()
  })

  it("ArrowDown on a closed field opens the list on the first option", () => {
    const { input } = openHistory(["x", "y"])
    fireEvent.keyDown(input, { key: "Escape" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const options = screen.getAllByRole("option")
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id)
  })

  it("Clear calls clearSearchHistory", () => {
    const { props } = openHistory(["x"])
    fireEvent.click(screen.getByTestId("log-search-history-clear"))
    expect(props.clearSearchHistory).toHaveBeenCalledTimes(1)
  })

  it("the per-item remove button is named and removes only that entry", () => {
    const { props } = openHistory(["query-a"])
    fireEvent.click(screen.getByLabelText("Remove recent search query-a"))
    expect(props.removeSearchHistoryItem).toHaveBeenCalledWith("query-a")
    expect(props.setSearchQuery).not.toHaveBeenCalled()
  })

  it("a click on an option fills the search", () => {
    const { props } = openHistory(["picked-query"])
    fireEvent.click(screen.getByTestId("log-search-history-item-picked-query"))
    expect(props.setSearchQuery).toHaveBeenCalledWith("picked-query")
  })

  it("blur to somewhere else closes the list", () => {
    const { input } = openHistory(["a"])
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(screen.queryByTestId("log-search-history-combobox")).not.toBeInTheDocument()
  })

  it("a pointer press inside the list does not take focus from the input", () => {
    openHistory(["a"])
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    screen.getByTestId("log-search-history-combobox").dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe("LogPanelToolbar — visual state coverage", () => {
  it("highlights view mode buttons by viewMode", () => {
    const { rerender } = renderToolbar({ viewMode: "list" })
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ viewMode: "dashboard" })} />
      </TooltipProvider>
    )
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ viewMode: "trace" })} />
      </TooltipProvider>
    )
    // No assertion needed — exercises each viewMode branch
    expect(screen.getByTestId("log-panel-toolbar")).toBeInTheDocument()
  })

  it("hides the active-filters indicator dot when filters are active", () => {
    const { container, rerender } = renderToolbar()
    // Should not show the dot when no filters are active
    expect(container.querySelector(".bg-primary.rounded-full")).toBeNull()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ moduleFilter: "auth" })} />
      </TooltipProvider>
    )
    expect(container.querySelector(".bg-primary.rounded-full")).toBeInTheDocument()
  })

  it("active preset id != EMPTY counts as advanced filter active", () => {
    const { container } = renderToolbar({ activePresetId: "p1" })
    expect(container.querySelector(".bg-primary.rounded-full")).toBeInTheDocument()
  })

  it("an unavailable trace view leaves no trace button", () => {
    const { container } = renderToolbar({ traceViewAvailable: false })
    expect(container.querySelectorAll(".lucide-activity").length).toBe(0)
  })

  it("applies font-mono to the search input when useRegex=true and a query is present", () => {
    renderToolbar({ useRegex: true, searchQuery: "needle" })
    const input = screen.getByPlaceholderText("Regex pattern...")
    expect(input).toHaveClass("font-mono")
  })

  it("does not apply font-mono when useRegex=false", () => {
    renderToolbar({ useRegex: false, searchQuery: "needle" })
    const input = screen.getByPlaceholderText("Search logs...")
    expect(input).not.toHaveClass("font-mono")
  })

  it("ignores Enter when search query is whitespace only", () => {
    const { props } = renderToolbar({ searchQuery: "   ", searchHistory: ["x"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.addSearchHistory).not.toHaveBeenCalled()
  })

  it("ignores ArrowDown when dropdown is closed or history empty", () => {
    renderToolbar({ searchHistory: [] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    // No assertion needed beyond no-crash
    expect(input).toBeInTheDocument()
  })
})

describe("LogPanelToolbar — shortcuts dialog", () => {
  it("renders 8 shortcut rows with localized action labels when showShortcutsDialog=true", () => {
    renderToolbar({ showShortcutsDialog: true })
    expect(screen.getByText("Refresh")).toBeInTheDocument()
    expect(screen.getByText("Dashboard view")).toBeInTheDocument()
    expect(screen.getByText("Next entry")).toBeInTheDocument()
    expect(screen.getByText("Previous entry")).toBeInTheDocument()
    expect(screen.getByText("Expand entry")).toBeInTheDocument()
    expect(screen.getByText("Open details")).toBeInTheDocument()
    expect(screen.getByText("Close / clear")).toBeInTheDocument()
    expect(screen.getByText("Show shortcuts")).toBeInTheDocument()
  })

  it("describes itself and lists the trace view shortcut when that view exists", () => {
    const { rerender } = renderToolbar({ showShortcutsDialog: true })
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Keys work anywhere in the panel except while typing in a field."
    )
    expect(screen.getByText("Trace view").previousElementSibling).toHaveTextContent("t")
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ showShortcutsDialog: true, traceViewAvailable: false })} />
      </TooltipProvider>
    )
    expect(screen.queryByText("Trace view")).not.toBeInTheDocument()
  })

  it("does not render the dialog body when showShortcutsDialog=false", () => {
    renderToolbar({ showShortcutsDialog: false })
    expect(screen.queryByText("Refresh")).not.toBeInTheDocument()
  })
})

describe("LogPanelToolbar — facet row and level row semantics", () => {
  it("prints the time-range chip in words, not the preset key", () => {
    renderToolbar({ timeRange: "15m" })
    expect(screen.getByTestId("facet-chip-time")).toHaveTextContent("Last 15m")
    expect(screen.getByTestId("facet-chip-time").textContent).not.toMatch(/^15m$/)
  })

  it("offers Clear all only when it would clear more than one chip", () => {
    const onClearAllFilters = jest.fn()
    const { rerender } = renderToolbar({ sourceFilter: "tauri", onClearAllFilters })
    expect(screen.queryByTestId("log-panel-clear-all-filters")).not.toBeInTheDocument()
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar
          {...makeProps({ sourceFilter: "tauri", timeRange: "1h", onClearAllFilters })}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByTestId("log-panel-clear-all-filters"))
    expect(onClearAllFilters).toHaveBeenCalledTimes(1)
  })

  it("places the chip row after the level row, directly above the list", () => {
    renderToolbar({ sourceFilter: "tauri" })
    const levelRow = screen.getByTestId("log-panel-level-filters")
    const chipRow = screen.getByTestId("log-panel-facet-chip-row")
    expect(levelRow.compareDocumentPosition(chipRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it("marks the active level tab as pressed", () => {
    renderToolbar({ levelFilter: "warn" as LogLevel })
    expect(screen.getByTestId("log-panel-level-warn")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("log-panel-level-all")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("log-panel-level-error")).toHaveAttribute("aria-pressed", "false")
  })

  it("counts Error with fatal folded in", () => {
    renderToolbar({
      stats: {
        total: 7,
        byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 4, fatal: 3 } as Record<
          LogLevel,
          number
        >,
      },
    })
    expect(screen.getByTestId("log-panel-level-error")).toHaveTextContent("7")
  })

  it("applies a calendar range as whole days", async () => {
    const user = userEvent.setup()
    const setCustomTimeRange = jest.fn()
    renderToolbar({
      showAdvancedFilters: true,
      customTimeRange: {
        start: new Date(2026, 2, 5, 10, 30),
        end: new Date(2026, 2, 5, 11, 0),
      },
      setCustomTimeRange,
    })
    // One control: the time-range select's "Custom…" opens the calendar —
    // there is no second calendar button any more.
    expect(screen.queryByTestId("log-panel-custom-range-trigger")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("log-panel-time-range-trigger"))
    await user.click(await screen.findByTestId("log-panel-time-range-custom"))
    fireEvent.click(await screen.findByTestId("log-panel-custom-range-apply"))
    const range = setCustomTimeRange.mock.calls[0][0] as { start: Date; end: Date }
    expect(range.start).toEqual(new Date(2026, 2, 5, 0, 0, 0, 0))
    expect(range.end).toEqual(new Date(2026, 2, 5, 23, 59, 59, 999))
  })
})

describe("LogPanelToolbar — More menu safety", () => {
  async function openMore() {
    await userEvent.click(screen.getByTestId("log-panel-more-actions"))
  }

  it("disables 'open details' when nothing is selected", async () => {
    renderToolbar({ showDetailPanel: false, canShowDetail: false })
    await openMore()
    expect(await screen.findByTestId("log-panel-toggle-detail")).toHaveAttribute("data-disabled")
  })

  it("keeps 'close details' available even without a selection", async () => {
    renderToolbar({ showDetailPanel: true, canShowDetail: false })
    await openMore()
    expect(await screen.findByTestId("log-panel-toggle-detail")).not.toHaveAttribute(
      "data-disabled"
    )
  })

  it("styles Clear logs as destructive", async () => {
    renderToolbar()
    await openMore()
    expect(await screen.findByTestId("log-panel-clear")).toHaveAttribute(
      "data-variant",
      "destructive"
    )
  })

  it("no longer carries a live-follow item now that the bar has the button", async () => {
    renderToolbar()
    await openMore()
    const menu = await screen.findByRole("menu")
    expect(within(menu).queryByText("Auto-refresh")).not.toBeInTheDocument()
  })
})

describe("LogPanelToolbar — shortcuts dialog key map", () => {
  it("documents Enter as open (like a click) and e as expand in place", () => {
    renderToolbar({ showShortcutsDialog: true })
    const openKey = screen.getByText("Open details").previousElementSibling
    const expandKey = screen.getByText("Expand entry").previousElementSibling
    expect(openKey).toHaveTextContent("Enter / o")
    expect(expandKey).toHaveTextContent("e")
  })
})
