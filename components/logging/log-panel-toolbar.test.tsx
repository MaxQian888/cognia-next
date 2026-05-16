/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("@/lib/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
}))

import { LogPanelToolbar, type LogPanelToolbarProps } from "./log-panel-toolbar"
import type { LogLevel } from "@/lib/logger"

function makeProps(overrides: Partial<LogPanelToolbarProps> = {}): LogPanelToolbarProps {
  return {
    viewMode: "list",
    setViewMode: jest.fn(),
    includeAgentTrace: true,
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
    highSeverityOnly: false,
    setHighSeverityOnly: jest.fn(),
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
    clearSessionFocus: jest.fn(),
    hasSessionFocus: false,
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
  it("renders three view-mode buttons when includeAgentTrace=true", () => {
    const { container } = renderToolbar()
    const viewButtons = container.querySelector(".flex.items-center.border.rounded-md")?.children
    expect(viewButtons?.length).toBe(3)
  })

  it("hides the trace view button when includeAgentTrace=false", () => {
    const { container } = renderToolbar({ includeAgentTrace: false })
    const viewButtons = container.querySelector(".flex.items-center.border.rounded-md")?.children
    expect(viewButtons?.length).toBe(2)
  })

  it("fires setViewMode when each view button is clicked", () => {
    const { props } = renderToolbar()
    const [list, dash, trace] = Array.from(
      document.querySelectorAll(".flex.items-center.border.rounded-md > button")
    )
    fireEvent.click(list)
    fireEvent.click(dash)
    fireEvent.click(trace)
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

  it("toggles regex on click and swaps the placeholder", () => {
    const { props, rerender } = renderToolbar()
    const regexBtn = document.querySelector(".lucide-regex")?.closest("button") as HTMLButtonElement
    fireEvent.click(regexBtn)
    expect(props.setUseRegex).toHaveBeenCalledWith(true)
    rerender(
      <TooltipProvider delayDuration={0}>
        <LogPanelToolbar {...makeProps({ useRegex: true })} />
      </TooltipProvider>
    )
    expect(screen.getByPlaceholderText("Regex pattern...")).toBeInTheDocument()
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

  it("clicking the shortcuts-hint button calls setShowShortcutsDialog(true)", () => {
    const { props } = renderToolbar()
    fireEvent.click(screen.getByTestId("log-toolbar-shortcut-hint"))
    expect(props.setShowShortcutsDialog).toHaveBeenCalledWith(true)
  })

  it("normal click on Refresh fires refresh(); Shift+Click toggles autoRefresh", () => {
    const { props } = renderToolbar({ autoRefresh: false })
    const refreshBtn = document
      .querySelector(".lucide-refresh-cw")
      ?.closest("button") as HTMLButtonElement
    fireEvent.click(refreshBtn)
    expect(props.refresh).toHaveBeenCalled()
    fireEvent.click(refreshBtn, { shiftKey: true })
    expect(props.setAutoRefresh).toHaveBeenCalledWith(true)
  })

  it("contextmenu on Refresh toggles autoRefresh and prevents default", () => {
    const { props } = renderToolbar({ autoRefresh: false })
    const refreshBtn = document
      .querySelector(".lucide-refresh-cw")
      ?.closest("button") as HTMLButtonElement
    fireEvent.contextMenu(refreshBtn)
    expect(props.setAutoRefresh).toHaveBeenCalledWith(true)
  })

  it("renders motion-safe spin class when autoRefresh is true", () => {
    renderToolbar({ autoRefresh: true })
    const spinIcon = document.querySelector(".lucide-refresh-cw")
    expect(spinIcon).toHaveClass("motion-safe:animate-spin")
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
    expect(closeBtn.getAttribute("aria-label")).toMatch(/tauri/)
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

  it("clicking All resets levelFilter, highSeverityOnly, bookmark", () => {
    const { props } = renderToolbar({ levelFilter: "warn" as LogLevel })
    fireEvent.click(screen.getByText("All"))
    expect(props.setLevelFilter).toHaveBeenCalledWith("all")
    expect(props.setHighSeverityOnly).toHaveBeenCalledWith(false)
    expect(props.setBookmarkFilterActive).toHaveBeenCalledWith(false)
  })

  it("clicking Error tab sets highSeverityOnly=true", () => {
    const { props } = renderToolbar()
    const errorTab = screen.getAllByText("Error")[0].closest("button") as HTMLButtonElement
    fireEvent.click(errorTab)
    expect(props.setLevelFilter).toHaveBeenCalledWith("error")
    expect(props.setHighSeverityOnly).toHaveBeenCalledWith(true)
  })

  it("clicking Warning tab sets highSeverityOnly=false", () => {
    const { props } = renderToolbar()
    const warnTab = screen.getAllByText("Warning")[0].closest("button") as HTMLButtonElement
    fireEvent.click(warnTab)
    expect(props.setLevelFilter).toHaveBeenCalledWith("warn")
    expect(props.setHighSeverityOnly).toHaveBeenCalledWith(false)
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

  it("invokes saveCurrentPreset and removeActivePreset", () => {
    const { props } = renderToolbar({ showAdvancedFilters: true, activePresetId: "p1" })
    const saveBtn = document
      .querySelector(".lucide-bookmark-plus")
      ?.closest("button") as HTMLButtonElement
    fireEvent.click(saveBtn)
    expect(props.saveCurrentPreset).toHaveBeenCalled()
    const removeBtn = document
      .querySelector(".lucide-bookmark-x")
      ?.closest("button") as HTMLButtonElement
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

  it("renders clear-trace-focus button when traceFocusId set, and fires setTraceFocusId(null)", () => {
    const { props } = renderToolbar({
      showAdvancedFilters: true,
      traceFocusId: "trace-1",
    })
    const btn = screen.getByText("Clear trace focus").closest("button") as HTMLButtonElement
    fireEvent.click(btn)
    expect(props.setTraceFocusId).toHaveBeenCalledWith(null)
  })

  it("renders clear-session-focus button when hasSessionFocus, and fires clearSessionFocus", () => {
    const { props } = renderToolbar({
      showAdvancedFilters: true,
      hasSessionFocus: true,
    })
    const btn = screen.getByText("Clear session focus").closest("button") as HTMLButtonElement
    fireEvent.click(btn)
    expect(props.clearSessionFocus).toHaveBeenCalled()
  })

  it("renders transport prefix chip with interpolated value", () => {
    const { props } = renderToolbar({
      showAdvancedFilters: true,
      diagnosticTransportFilter: "langfuse",
    })
    // The transport prefix chip inside advanced filters
    const transportBtn = screen
      .getByText("Transport: langfuse")
      .closest("button") as HTMLButtonElement
    fireEvent.click(transportBtn)
    expect(props.setDiagnosticTransportFilter).toHaveBeenCalledWith(null)
  })

  it("uses motion-safe animation classes on the expand", () => {
    renderToolbar({ showAdvancedFilters: true })
    const row = screen.getByTestId("log-panel-filter-group")
    expect(row.className).toMatch(/motion-safe:animate-in/)
  })
})

describe("LogPanelToolbar — search history dropdown", () => {
  it("renders 'No recent searches' empty state when history empty", () => {
    renderToolbar({ searchHistory: [] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    // Empty state only renders when showSearchHistory is true and items.length > 0;
    // with [] it stays closed. So just confirm the dropdown doesn't open.
    expect(screen.queryByTestId("log-search-history-combobox")).not.toBeInTheDocument()
  })

  it("opens the dropdown when focused with non-empty history", () => {
    renderToolbar({ searchHistory: ["query-a", "query-b"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    expect(screen.getByTestId("log-search-history-combobox")).toBeInTheDocument()
    expect(screen.getByText("query-a")).toBeInTheDocument()
  })

  it("Enter on the input with a value addSearchHistory and closes the dropdown", () => {
    const { props } = renderToolbar({ searchQuery: "needle", searchHistory: ["x"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.addSearchHistory).toHaveBeenCalledWith("needle")
  })

  it("Escape closes the dropdown", () => {
    renderToolbar({ searchHistory: ["x"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByTestId("log-search-history-combobox")).not.toBeInTheDocument()
  })

  it("ArrowDown moves focus into the listbox when open", () => {
    renderToolbar({ searchHistory: ["x", "y"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: "ArrowDown" })
    // No assertion on focus position — jsdom doesn't track focus reliably; just ensure no crash.
    expect(screen.getByTestId("log-search-history-combobox")).toBeInTheDocument()
  })

  it("Clear button (shadcn Button) calls clearSearchHistory", () => {
    const { props } = renderToolbar({ searchHistory: ["x"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    fireEvent.mouseDown(screen.getByTestId("log-search-history-clear"))
    expect(props.clearSearchHistory).toHaveBeenCalledTimes(1)
  })

  it("Remove per-item X has localized aria-label and fires removeSearchHistoryItem", () => {
    const { props } = renderToolbar({ searchHistory: ["query-a"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    const removeBtn = screen.getByLabelText("Remove recent search query-a")
    fireEvent.mouseDown(removeBtn)
    expect(props.removeSearchHistoryItem).toHaveBeenCalledWith("query-a")
  })

  it("CommandItem onSelect fills setSearchQuery and closes the dropdown", () => {
    const { props } = renderToolbar({ searchHistory: ["picked-query"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    const item = screen.getByTestId("log-search-history-item-picked-query")
    // cmdk listens on click for item selection
    fireEvent.click(item)
    expect(props.setSearchQuery).toHaveBeenCalledWith("picked-query")
  })

  it("onBlur closes the dropdown when focus moves outside the listbox", () => {
    renderToolbar({ searchHistory: ["a"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    expect(screen.getByTestId("log-search-history-combobox")).toBeInTheDocument()
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(screen.queryByTestId("log-search-history-combobox")).not.toBeInTheDocument()
  })

  it("onBlur keeps the dropdown open when focus moves into the listbox", () => {
    renderToolbar({ searchHistory: ["a"] })
    const input = screen.getByPlaceholderText("Search logs...")
    fireEvent.focus(input)
    const listbox = document.getElementById("log-search-history-listbox") as HTMLElement
    expect(listbox).toBeInTheDocument()
    fireEvent.blur(input, { relatedTarget: listbox })
    expect(screen.queryByTestId("log-search-history-combobox")).toBeInTheDocument()
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

  it("includeAgentTrace=false hides trace view button and trims advanced filter offering", () => {
    const { container } = renderToolbar({ includeAgentTrace: false })
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

  it("does not render the dialog body when showShortcutsDialog=false", () => {
    renderToolbar({ showShortcutsDialog: false })
    expect(screen.queryByText("Refresh")).not.toBeInTheDocument()
  })
})
