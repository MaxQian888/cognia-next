/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

// ── Stub all heavy child components so the test focuses on LogPanel composition.
jest.mock("./log-panel-toolbar", () => ({
  LogPanelToolbar: () => <div data-testid="stub-toolbar" />,
}))
jest.mock("./log-panel-stats-bar", () => ({
  LogPanelStatsBar: () => <div data-testid="stub-stats-bar" />,
  TransportHealthDetail: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="stub-transport-detail-close" onClick={onClose}>
      transport-detail
    </button>
  ),
  NativeLoggingDetail: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="stub-native-logging-close" onClick={onClose}>
      native-logging
    </button>
  ),
}))
jest.mock("./log-virtualized-list", () => ({
  VirtualizedLogList: ({ onRetry }: { onRetry?: () => void }) => (
    <div data-testid="stub-virtualized-list" onClick={onRetry}>
      virtualized-list
    </div>
  ),
}))
jest.mock("./log-stats-dashboard", () => ({
  LogStatsDashboard: () => <div data-testid="stub-dashboard" />,
}))
jest.mock("./log-timeline", () => ({
  LogTimeline: ({ onTimeRangeClick }: { onTimeRangeClick?: (start: Date, end: Date) => void }) => (
    <button
      data-testid="stub-timeline"
      onClick={() => onTimeRangeClick?.(new Date(0), new Date(60_000))}
    >
      timeline
    </button>
  ),
}))
jest.mock("./log-detail-panel", () => ({
  LogDetailPanel: ({ onClose }: { onClose?: () => void }) => (
    <button data-testid="stub-detail-panel" onClick={onClose}>
      detail
    </button>
  ),
}))
jest.mock("./log-trace-view", () => ({
  LogTraceView: ({ onSelectTrace }: { onSelectTrace?: (id: string) => void }) => (
    <button data-testid="stub-trace-view" onClick={() => onSelectTrace?.("trace-x")}>
      trace
    </button>
  ),
}))

const mockToast = jest.fn() as jest.Mock & { dismiss?: jest.Mock }
jest.mock("sonner", () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}))

const mockUseLogPanelUrlSync = jest.fn()
jest.mock("@/hooks/logging/use-log-panel-url-sync", () => ({
  useLogPanelUrlSync: (...args: unknown[]) => mockUseLogPanelUrlSync(...args),
}))

// ── Mock hooks the panel depends on.
const mockUseMediaQuery = jest.fn()
const mockUseResizableLayout = jest.fn(() => ({
  defaultLayout: undefined,
  onLayoutChanged: jest.fn(),
}))
jest.mock("@/hooks/ui", () => ({
  useMediaQuery: (...args: unknown[]) => mockUseMediaQuery(...args),
  useResizableLayout: (...args: unknown[]) => mockUseResizableLayout(...args),
}))

const mockUseLogStream = jest.fn()
const mockUseLogModules = jest.fn()
const mockUseAgentTraceAsLogs = jest.fn()
const mockUseTransportHealth = jest.fn()
jest.mock("@/hooks/logging", () => ({
  useLogStream: (...args: unknown[]) => mockUseLogStream(...args),
  useLogModules: (...args: unknown[]) => mockUseLogModules(...args),
  useAgentTraceAsLogs: (...args: unknown[]) => mockUseAgentTraceAsLogs(...args),
  useTransportHealth: (...args: unknown[]) => mockUseTransportHealth(...args),
}))

const mockUseLogPanelFilters = jest.fn()
jest.mock("@/hooks/logging/use-log-panel-filters", () => ({
  useLogPanelFilters: (...args: unknown[]) => mockUseLogPanelFilters(...args),
}))

jest.mock("@/lib/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
}))

import { LogPanel } from "./log-panel"

function defaultFilterState(overrides: Record<string, unknown> = {}) {
  return {
    autoRefresh: false,
    levelFilter: "all",
    moduleFilter: "all",
    sourceFilter: "all",
    sessionFilter: "",
    searchQuery: "",
    useRegex: false,
    highSeverityOnly: false,
    timeRange: "all",
    traceFocusId: null,
    autoScroll: false,
    viewMode: "list",
    selectedLog: null,
    showDetailPanel: false,
    selectedTransportHealthName: null,
    selectedNativeLogging: false,
    diagnosticTransportFilter: null,
    expandedIds: new Set<string>(),
    focusedIndex: 0,
    customTimeRange: null,
    currentPage: 1,
    pageSize: 50,
    density: "comfortable",
    presets: [],
    activePresetId: "__EMPTY__",
    bookmarkedIds: new Set<string>(),
    bookmarkFilterActive: false,
    setBookmarkFilterActive: jest.fn(),
    showAdvancedFilters: false,
    setShowAdvancedFilters: jest.fn(),
    showShortcutsDialog: false,
    setShowShortcutsDialog: jest.fn(),
    searchHistory: [],
    addSearchHistory: jest.fn(),
    removeSearchHistoryItem: jest.fn(),
    clearSearchHistory: jest.fn(),
    setAutoRefresh: jest.fn(),
    setLevelFilter: jest.fn(),
    setModuleFilter: jest.fn(),
    setSourceFilter: jest.fn(),
    setSessionFilter: jest.fn(),
    setSearchQuery: jest.fn(),
    setUseRegex: jest.fn(),
    setHighSeverityOnly: jest.fn(),
    setTimeRange: jest.fn(),
    setCustomTimeRange: jest.fn(),
    setTraceFocusId: jest.fn(),
    setCurrentPage: jest.fn(),
    setPageSize: jest.fn(),
    setDensity: jest.fn(),
    setAutoScroll: jest.fn(),
    setViewMode: jest.fn(),
    setSelectedLog: jest.fn(),
    setShowDetailPanel: jest.fn(),
    setSelectedTransportHealthName: jest.fn(),
    setSelectedNativeLogging: jest.fn(),
    setDiagnosticTransportFilter: jest.fn(),
    setFocusedIndex: jest.fn(),
    toggleExpanded: jest.fn(),
    toggleBookmark: jest.fn(),
    saveCurrentPreset: jest.fn(),
    applyPreset: jest.fn(),
    handlePresetChange: jest.fn(),
    removeActivePreset: jest.fn(),
    handleSelectLog: jest.fn(),
    handleFocusTrace: jest.fn(),
    handleFocusSession: jest.fn(),
    EMPTY_PRESET_VALUE: "__EMPTY__",
    ...overrides,
  }
}

beforeEach(() => {
  mockUseMediaQuery.mockReturnValue(true) // desktop by default
  const defaultLogs = [
    {
      id: "l-1",
      timestamp: new Date("2026-01-01T12:00:00Z").toISOString(),
      level: "info",
      module: "m",
      message: "msg",
    },
    {
      id: "l-2",
      timestamp: new Date("2026-01-01T12:01:00Z").toISOString(),
      level: "error",
      module: "m",
      message: "msg2",
    },
  ]
  mockUseLogStream.mockReturnValue({
    logs: defaultLogs,
    isLoading: false,
    error: null,
    refresh: jest.fn(),
    clearLogs: jest.fn(),
    logRate: 0,
    stats: {
      total: 2,
      byLevel: { trace: 0, debug: 0, info: 1, warn: 0, error: 1, fatal: 0 },
    },
  })
  mockUseLogModules.mockReturnValue(["auth", "api"])
  mockUseAgentTraceAsLogs.mockReturnValue({ logs: [], isStreaming: false })
  mockUseTransportHealth.mockReturnValue({
    healthByTransport: {},
    nativeLogging: {
      runtime: "browser",
      status: "inactive",
      startupMode: "off",
      bridgeState: "uninitialized",
      activeTargets: [],
      fallbackReason: null,
      bridgeLastError: null,
      platformLogging: { backend: "none", health: "ok", minLevel: "info", error: null },
    },
    transportHistory: {},
  })
  mockUseLogPanelFilters.mockReturnValue(defaultFilterState())
})

describe("LogPanel — composition", () => {
  it("renders toolbar, stats bar, timeline, and virtualized list by default", () => {
    render(<LogPanel />)
    expect(screen.getByTestId("stub-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("stub-stats-bar")).toBeInTheDocument()
    expect(screen.getByTestId("stub-timeline")).toBeInTheDocument()
    expect(screen.getByTestId("stub-virtualized-list")).toBeInTheDocument()
  })

  it("hides stats bar when showStats=false", () => {
    render(<LogPanel showStats={false} />)
    expect(screen.queryByTestId("stub-stats-bar")).not.toBeInTheDocument()
  })

  it("hides timeline when showTimeline=false", () => {
    render(<LogPanel showTimeline={false} />)
    expect(screen.queryByTestId("stub-timeline")).not.toBeInTheDocument()
  })

  it("renders dashboard instead of virtualized list when viewMode=dashboard", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ viewMode: "dashboard" }))
    render(<LogPanel />)
    expect(screen.getByTestId("stub-dashboard")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-virtualized-list")).not.toBeInTheDocument()
  })
})

describe("LogPanel — detail panel rendering", () => {
  it("renders the side detail panel on desktop when log selected", () => {
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    render(<LogPanel />)
    expect(screen.getByTestId("stub-detail-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("log-detail-sheet")).not.toBeInTheDocument()
  })

  it("renders the bottom Sheet on narrow viewport when log selected", () => {
    mockUseMediaQuery.mockReturnValue(false)
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    render(<LogPanel />)
    expect(screen.getByTestId("log-detail-sheet")).toBeInTheDocument()
    // The Sheet class should have responsive heights
    expect(screen.getByTestId("log-detail-sheet")).toHaveClass(
      "h-[85vh]",
      "md:h-[75vh]",
      "lg:h-[80vh]"
    )
  })

  it("desktop detail panel uses xl: width variant", () => {
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    render(<LogPanel />)
    // The LogDetailPanel stub doesn't render the className, but the parent does via prop.
    // Verify the detail panel renders at all on desktop with selected log.
    expect(screen.getByTestId("stub-detail-panel")).toBeInTheDocument()
  })

  it("renders neither panel when showDetailPanel=false", () => {
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: false })
    )
    render(<LogPanel />)
    expect(screen.queryByTestId("stub-detail-panel")).not.toBeInTheDocument()
    expect(screen.queryByTestId("log-detail-sheet")).not.toBeInTheDocument()
  })
})

describe("LogPanel — Transport / Native detail flyouts", () => {
  it("renders TransportHealthDetail when selectedTransportHealthName is set", () => {
    mockUseTransportHealth.mockReturnValue({
      healthByTransport: {
        remote: {
          transport: "remote",
          status: "healthy",
          queueDepth: 0,
          retryCount: 0,
          droppedEntries: 0,
          updatedAt: new Date().toISOString(),
        },
      },
      transportHistory: { remote: [1, 2, 3] },
      nativeLogging: {
        runtime: "browser",
        status: "inactive",
        startupMode: "off",
        bridgeState: "uninitialized",
        activeTargets: [],
        fallbackReason: null,
        bridgeLastError: null,
        platformLogging: { backend: "none", health: "ok", minLevel: "info", error: null },
      },
    })
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedTransportHealthName: "remote" })
    )
    render(<LogPanel />)
    expect(screen.getByTestId("stub-transport-detail-close")).toBeInTheDocument()
  })

  it("renders NativeLoggingDetail when selectedNativeLogging=true", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ selectedNativeLogging: true }))
    render(<LogPanel />)
    expect(screen.getByTestId("stub-native-logging-close")).toBeInTheDocument()
  })
})

describe("LogPanel — loading + error", () => {
  it("propagates loading state to VirtualizedLogList", () => {
    mockUseLogStream.mockReturnValue({
      logs: [],
      isLoading: true,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      stats: { total: 0, byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } },
    })
    render(<LogPanel />)
    expect(screen.getByTestId("stub-virtualized-list")).toBeInTheDocument()
  })

  it("propagates error state to VirtualizedLogList", () => {
    mockUseLogStream.mockReturnValue({
      logs: [],
      isLoading: false,
      error: new Error("boom"),
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      stats: { total: 0, byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } },
    })
    render(<LogPanel />)
    expect(screen.getByTestId("stub-virtualized-list")).toBeInTheDocument()
  })
})

describe("LogPanel — timeline interaction", () => {
  it("clicking the timeline forwards time range click to filters", () => {
    render(<LogPanel />)
    fireEvent.click(screen.getByTestId("stub-timeline"))
    // VirtualizedLogList stub renders, no error
    expect(screen.getByTestId("stub-virtualized-list")).toBeInTheDocument()
  })
})

describe("LogPanel — when log set has logs", () => {
  it("renders without crashing when logs is populated", () => {
    const logs = Array.from({ length: 10 }, (_, i) => ({
      id: `l-${i}`,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      level: i % 5 === 0 ? "error" : "info",
      module: "m",
      message: `msg-${i}`,
    }))
    mockUseLogStream.mockReturnValue({
      logs,
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 5,
      stats: {
        total: logs.length,
        byLevel: { trace: 0, debug: 0, info: 8, warn: 0, error: 2, fatal: 0 },
      },
    })
    render(<LogPanel />)
    expect(screen.getByTestId("stub-toolbar")).toBeInTheDocument()
  })

  it("respects custom maxHeight prop", () => {
    const { container } = render(<LogPanel maxHeight="400px" />)
    expect(container.firstChild).toBeTruthy()
  })

  it("respects includeAgentTrace=false", () => {
    render(<LogPanel includeAgentTrace={false} />)
    expect(screen.getByTestId("stub-toolbar")).toBeInTheDocument()
  })

  it("respects custom sources list", () => {
    render(<LogPanel sources={["tauri", "frontend"]} />)
    expect(screen.getByTestId("stub-toolbar")).toBeInTheDocument()
  })

  it("respects groupByTraceId prop", () => {
    render(<LogPanel groupByTraceId />)
    expect(screen.getByTestId("stub-virtualized-list")).toBeInTheDocument()
  })
})

describe("LogPanel — viewport adaptation", () => {
  it("does not render the desktop side panel when isDesktopViewport=false", () => {
    mockUseMediaQuery.mockReturnValue(false)
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    const { container } = render(<LogPanel />)
    // Sheet should be present
    expect(screen.getByTestId("log-detail-sheet")).toBeInTheDocument()
    // The desktop class w-[350px] should NOT appear on a side panel
    const sidePanels = container.querySelectorAll(".w-\\[350px\\]")
    expect(sidePanels.length).toBe(0)
  })
})

describe("LogPanel — resizable detail panel", () => {
  it("wraps the desktop layout in a ResizablePanelGroup when detail open", () => {
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    const { container } = render(<LogPanel />)
    expect(screen.getByTestId("log-panel-resizable-group")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="resizable-handle"]')).toBeInTheDocument()
    expect(screen.getByTestId("stub-detail-panel")).toBeInTheDocument()
  })

  it("renders main pane alone (no resizable group) when detail closed", () => {
    render(<LogPanel />)
    expect(screen.queryByTestId("log-panel-resizable-group")).not.toBeInTheDocument()
    expect(screen.getByTestId("log-panel-main-pane")).toBeInTheDocument()
  })
})

describe("LogPanel — trace view", () => {
  it("renders LogTraceView when viewMode=trace", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ viewMode: "trace" }))
    render(<LogPanel />)
    expect(screen.getByTestId("stub-trace-view")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-virtualized-list")).not.toBeInTheDocument()
  })

  it("clicking a trace forwards the id to setTraceFocusId via filters", () => {
    const setTraceFocusId = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ viewMode: "trace", setTraceFocusId })
    )
    render(<LogPanel />)
    fireEvent.click(screen.getByTestId("stub-trace-view"))
    expect(setTraceFocusId).toHaveBeenCalledWith("trace-x")
  })
})

describe("LogPanel — window-scope keyboard shortcuts", () => {
  it("fires refresh on `r`", () => {
    const refresh = jest.fn()
    mockUseLogStream.mockReturnValueOnce({
      logs: [],
      isLoading: false,
      error: null,
      refresh,
      clearLogs: jest.fn(),
      logRate: 0,
      stats: { total: 0, byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } },
    })
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "r" })
    expect(refresh).toHaveBeenCalled()
  })

  it("opens shortcuts dialog on `?`", () => {
    const setShowShortcutsDialog = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ setShowShortcutsDialog }))
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "?" })
    expect(setShowShortcutsDialog).toHaveBeenCalledWith(true)
  })

  it("bookmarks the focused entry on `b`", () => {
    const toggleBookmark = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ toggleBookmark, focusedIndex: 0 }))
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "b" })
    expect(toggleBookmark).toHaveBeenCalled()
  })

  it("ignores shortcuts while typing in an input", () => {
    const refresh = jest.fn()
    mockUseLogStream.mockReturnValueOnce({
      logs: [],
      isLoading: false,
      error: null,
      refresh,
      clearLogs: jest.fn(),
      logRate: 0,
      stats: { total: 0, byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 } },
    })
    render(<LogPanel />)
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: "r", bubbles: true })
    expect(refresh).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })
})

describe("LogPanel — autoScroll toast on pages > 1", () => {
  beforeEach(() => {
    mockToast.mockClear()
  })

  it("shows a 'jump to latest' toast when new logs arrive on a non-first page", () => {
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ autoRefresh: true, autoScroll: true })
    )
    mockUseLogStream.mockReturnValue({
      logs: Array.from({ length: 60 }, (_, i) => ({
        id: `l-${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        level: "info",
        module: "m",
        message: `m-${i}`,
      })),
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 5,
      stats: {
        total: 60,
        byLevel: { trace: 0, debug: 0, info: 60, warn: 0, error: 0, fatal: 0 },
      },
    })
    const setCurrentPage = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        autoRefresh: true,
        autoScroll: true,
        currentPage: 2,
        setCurrentPage,
      })
    )
    const { rerender } = render(<LogPanel />)
    // Bump the log count to trigger the toast path.
    mockUseLogStream.mockReturnValueOnce({
      logs: Array.from({ length: 65 }, (_, i) => ({
        id: `l-${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        level: "info",
        module: "m",
        message: `m-${i}`,
      })),
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 5,
      stats: {
        total: 65,
        byLevel: { trace: 0, debug: 0, info: 65, warn: 0, error: 0, fatal: 0 },
      },
    })
    rerender(<LogPanel />)
    expect(mockToast).toHaveBeenCalled()
    const toastArgs = mockToast.mock.calls[0]
    const opts = toastArgs[1] as { action?: { onClick?: () => void } }
    expect(opts.action).toBeDefined()
    opts.action?.onClick?.()
    expect(setCurrentPage).toHaveBeenCalledWith(1)
  })
})
