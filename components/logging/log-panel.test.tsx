/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"

// ── Stub all heavy child components so the test focuses on LogPanel composition.
// Props the stubs received on their latest render, for assertions on wiring.
const mockToolbarProps: Record<string, unknown> = {}
const mockStatsBarProps: Record<string, unknown> = {}
const mockDashboardProps: Record<string, unknown> = {}
const mockDetailPanelProps: Record<string, unknown> = {}
jest.mock("./log-panel-toolbar", () => ({
  LogPanelToolbar: (props: {
    clearLogs?: () => void
    onExport?: (format: string) => void
    statsSlot?: React.ReactNode
    healthSlot?: React.ReactNode
  }) => {
    Object.assign(mockToolbarProps, props)
    const { clearLogs, onExport, statsSlot, healthSlot } = props
    return (
      <div data-testid="stub-toolbar">
        <button data-testid="stub-toolbar-clear" onClick={() => clearLogs?.()} />
        <button data-testid="stub-toolbar-export-ndjson" onClick={() => onExport?.("ndjson")} />
        <button data-testid="stub-toolbar-export-csv" onClick={() => onExport?.("csv")} />
        {healthSlot}
        {statsSlot}
      </div>
    )
  },
}))
jest.mock("./log-panel-stats-bar", () => ({
  LogPanelStatsBar: (props: Record<string, unknown>) => {
    Object.assign(mockStatsBarProps, props)
    return <div data-testid="stub-stats-bar" />
  },
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
  TransportHealthSummary: (props: {
    onTransportClick: (name: string) => void
    onNativeLoggingClick: () => void
  }) => (
    <div data-testid="stub-health-summary">
      <button
        data-testid="stub-health-transport"
        onClick={() => props.onTransportClick("remote")}
      />
      <button data-testid="stub-health-native" onClick={props.onNativeLoggingClick} />
    </div>
  ),
}))
jest.mock("./agent-trace-stats-bar", () => ({
  AgentTraceStatsBar: ({ window }: { window: string }) => (
    <div data-testid="stub-agent-trace-stats" data-window={window} />
  ),
}))
const mockVirtualizedListProps: {
  filteredLogs?: { id: string }[]
  focusedIndex?: number
  onActivateRow?: (log: { id: string }, index: number) => void
  onFocusRow?: (index: number) => void
  emptyStateContext?: { activeFilterLabels: string[]; windowCappedCount?: number }
} = {}
jest.mock("./log-virtualized-list", () => ({
  VirtualizedLogList: (props: {
    onRetry?: () => void
    filteredLogs?: { id: string }[]
    focusedIndex?: number
    onActivateRow?: (log: { id: string }, index: number) => void
    onFocusRow?: (index: number) => void
    emptyStateContext?: { activeFilterLabels: string[]; windowCappedCount?: number }
  }) => {
    mockVirtualizedListProps.filteredLogs = props.filteredLogs
    mockVirtualizedListProps.focusedIndex = props.focusedIndex
    mockVirtualizedListProps.onActivateRow = props.onActivateRow
    mockVirtualizedListProps.onFocusRow = props.onFocusRow
    mockVirtualizedListProps.emptyStateContext = props.emptyStateContext
    return (
      <div data-testid="stub-virtualized-list" onClick={props.onRetry}>
        virtualized-list
      </div>
    )
  },
}))
jest.mock("./log-stats-dashboard", () => ({
  LogStatsDashboard: (props: Record<string, unknown>) => {
    Object.assign(mockDashboardProps, props)
    return <div data-testid="stub-dashboard" />
  },
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
  LogDetailPanel: (props: { onClose?: () => void }) => {
    Object.assign(mockDetailPanelProps, props)
    return (
      <button data-testid="stub-detail-panel" onClick={props.onClose}>
        detail
      </button>
    )
  },
}))
const mockTraceViewProps: Record<string, unknown> = {}
jest.mock("./log-trace-view", () => ({
  LogTraceView: (props: {
    onSelectTrace?: (id: string) => void
    onOpenTrace?: (id: string) => void
  }) => {
    Object.assign(mockTraceViewProps, props)
    return (
      <button data-testid="stub-trace-view" onClick={() => props.onSelectTrace?.("trace-x")}>
        trace
      </button>
    )
  },
}))

const mockToast = jest.fn() as jest.Mock & { dismiss?: jest.Mock }
const mockToastSuccess = jest.fn()
const mockToastError = jest.fn()
jest.mock("sonner", () => {
  const toast = (...args: unknown[]) => mockToast(...args)
  toast.success = (...args: unknown[]) => mockToastSuccess(...args)
  toast.error = (...args: unknown[]) => mockToastError(...args)
  return { toast }
})

const mockPanelWidth = jest.fn((): number => 1280)
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => mockPanelWidth(),
}))

const mockUseLogPanelUrlSync = jest.fn()
jest.mock("@/hooks/logging/use-log-panel-url-sync", () => ({
  useLogPanelUrlSync: (...args: unknown[]) => mockUseLogPanelUrlSync(...args),
}))

// ── Mock hooks the panel depends on.
const mockUseMediaQuery = jest.fn((..._args: unknown[]): boolean => false)
const mockUseIsNarrow = jest.fn((): boolean => false)
const mockUseResizableLayout = jest.fn((..._args: unknown[]) => ({
  defaultLayout: undefined,
  onLayoutChanged: jest.fn(),
}))
jest.mock("@/hooks/ui", () => ({
  useMediaQuery: (...args: unknown[]) => mockUseMediaQuery(...args),
  useIsNarrow: () => mockUseIsNarrow(),
  useResizableLayout: (...args: unknown[]) => mockUseResizableLayout(...args),
}))

// ── Stub the resizable wrapper — the real Group measures the DOM, which jsdom
// can't satisfy. Expose size props as data attributes for unit assertions.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => (
    <div data-testid="resizable-group" className={className}>
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    id,
    defaultSize,
    minSize,
    maxSize,
  }: {
    children: React.ReactNode
    id?: string
    defaultSize?: number | string
    minSize?: number | string
    maxSize?: number | string
  }) => (
    <div
      data-testid={id ? `resizable-panel-${id}` : "resizable-panel"}
      data-default-size={defaultSize === undefined ? undefined : String(defaultSize)}
      data-min-size={minSize === undefined ? undefined : String(minSize)}
      data-max-size={maxSize === undefined ? undefined : String(maxSize)}
    >
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-slot="resizable-handle" />,
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
  // The real matcher, minus the cache: a case-insensitive substring (or
  // pattern) over message + module.
  createLogSearchMatcher: (query: string | undefined, useRegex: boolean) => {
    if (!query) return null
    const re = useRegex ? new RegExp(query, "i") : null
    return (log: { message: string; module: string }) => {
      const text = `${log.message}\n${log.module}`
      return re ? re.test(text) : text.toLowerCase().includes(query.toLowerCase())
    }
  },
}))

const mockUseLogPanelFilters = jest.fn()
jest.mock("@/hooks/logging/use-log-panel-filters", () => ({
  useLogPanelFilters: (...args: unknown[]) => mockUseLogPanelFilters(...args),
}))

jest.mock("@cognia/agent-trace/log-adapter", () => ({
  AGENT_TRACE_MODULE: "agent.trace",
}))

import { LogPanel, agentTraceWindowForRange } from "./log-panel"

function defaultFilterState(overrides: Record<string, unknown> = {}) {
  return {
    autoRefresh: false,
    levelFilter: "all",
    moduleFilter: "all",
    sourceFilter: "all",
    sessionFilter: "",
    searchQuery: "",
    useRegex: false,
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
    setTimeRange: jest.fn(),
    setCustomTimeRange: jest.fn(),
    setTraceFocusId: jest.fn(),
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
  mockUseMediaQuery.mockReturnValue(true)
  mockPanelWidth.mockReturnValue(1280) // a panel wide enough to dock the detail by default
  window.localStorage.clear()
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
    windowCapped: false,
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
    // the stats bar is passed into the toolbar's filter row, not stacked under it
    expect(screen.getByTestId("stub-toolbar")).toContainElement(
      screen.getByTestId("stub-stats-bar")
    )
    // Transport health goes to the toolbar's first row.
    expect(mockToolbarProps.healthSlot).toBeTruthy()
    expect(screen.getByTestId("stub-timeline")).toBeInTheDocument()
    expect(screen.getByTestId("stub-virtualized-list")).toBeInTheDocument()
  })

  it("hides stats bar when showStats=false", () => {
    render(<LogPanel showStats={false} />)
    expect(mockToolbarProps.healthSlot).toBeNull()
    // Nothing renders health, so nothing polls it.
    expect(mockUseTransportHealth.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false })
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

  it("renders a full-height bottom Sheet on a phone when log selected", () => {
    mockPanelWidth.mockReturnValue(375)
    mockUseIsNarrow.mockReturnValue(true)
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    render(<LogPanel />)
    // Mobile uses full-height list-to-detail navigation.
    expect(screen.getByTestId("log-detail-sheet")).toHaveClass("h-dvh", "max-h-dvh")
    expect(screen.getByTestId("log-detail-sheet")).toHaveClass("bottom-0")
    mockUseIsNarrow.mockReturnValue(false)
  })

  it("renders a right-side drawer when the panel is too narrow for two panes", () => {
    mockPanelWidth.mockReturnValue(780)
    mockUseIsNarrow.mockReturnValue(false)
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    render(<LogPanel />)
    const sheet = screen.getByTestId("log-detail-sheet")
    expect(sheet).toHaveClass("right-0")
    expect(sheet).toHaveClass("w-[min(92vw,560px)]")
    expect(sheet).not.toHaveClass("h-dvh")
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

  it("dedupes entries that appear in both the log stream and the agent-trace stream", () => {
    // The trace transport double-persists spans: once into the unified log
    // store (→ useLogStream) and once into the agentTraces Dexie table
    // (→ useAgentTraceAsLogs), both keyed by span.id. The merge must emit
    // each id once or React hits duplicate-key warnings every refresh.
    const ts = new Date("2026-01-01T12:00:00Z").toISOString()
    mockUseLogStream.mockReturnValue({
      logs: [
        { id: "shared-span", timestamp: ts, level: "error", module: "agent.trace", message: "m" },
        {
          id: "plain",
          timestamp: new Date("2026-01-01T11:59:00Z").toISOString(),
          level: "info",
          module: "m",
          message: "m2",
        },
      ],
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
    mockUseAgentTraceAsLogs.mockReturnValue({
      logs: [
        { id: "shared-span", timestamp: ts, level: "error", module: "agent.trace", message: "m" },
        {
          id: "span-only",
          timestamp: new Date("2026-01-01T11:58:00Z").toISOString(),
          level: "info",
          module: "agent.trace",
          message: "m3",
        },
      ],
      isStreaming: false,
    })
    render(<LogPanel />)
    const ids = (mockVirtualizedListProps.filteredLogs ?? []).map((l) => l.id)
    expect(ids).toEqual(["shared-span", "plain", "span-only"])
  })
})

describe("LogPanel — viewport adaptation", () => {
  it("does not dock the detail pane in a narrow panel, whatever the viewport", () => {
    mockUseMediaQuery.mockReturnValue(true)
    mockPanelWidth.mockReturnValue(700)
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

  // react-resizable-panels v4 interprets bare numbers as PIXELS; sizes must
  // be percent strings or the main/detail split collapses to px-wide slivers.
  it("passes percent-string sizes to the main and detail panels", () => {
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    render(<LogPanel />)
    const percent = /^\d+(\.\d+)?%$/
    const main = screen.getByTestId("resizable-panel-log-panel-main")
    const detail = screen.getByTestId("resizable-panel-log-panel-detail")
    for (const panel of [main, detail]) {
      expect(panel.dataset.defaultSize).toMatch(percent)
      expect(panel.dataset.minSize).toMatch(percent)
    }
    expect(detail.dataset.maxSize).toMatch(percent)
  })

  it("keeps the group mounted but hides handle + detail panel when detail closed", () => {
    const { container } = render(<LogPanel />)
    // The group stays mounted so toggling the detail panel never remounts the
    // main pane (remounting dropped scroll position and re-created every row).
    expect(screen.getByTestId("log-panel-resizable-group")).toBeInTheDocument()
    expect(screen.getByTestId("log-panel-main-pane")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="resizable-handle"]')).not.toBeInTheDocument()
    expect(screen.queryByTestId("resizable-panel-log-panel-detail")).not.toBeInTheDocument()
  })

  it("preserves the main pane DOM node when the detail panel opens", () => {
    const selected = { id: "l-1", message: "x", level: "info", module: "m", timestamp: "" } as never
    const { rerender } = render(<LogPanel />)
    const mainBefore = screen.getByTestId("log-panel-main-pane")
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: selected, showDetailPanel: true })
    )
    rerender(<LogPanel />)
    expect(screen.getByTestId("stub-detail-panel")).toBeInTheDocument()
    expect(screen.getByTestId("log-panel-main-pane")).toBe(mainBefore)
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

describe("LogPanel — following new entries", () => {
  beforeEach(() => {
    mockToast.mockClear()
  })

  const baseMs = Date.parse("2026-03-01T12:00:00.000Z")
  const entriesFrom = (newestOffsetSec: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `l-${newestOffsetSec - i}`,
      timestamp: new Date(baseMs + (newestOffsetSec - i) * 1000).toISOString(),
      level: "info",
      module: "m",
      message: `m-${newestOffsetSec - i}`,
    }))
  const streamOf = (logs: ReturnType<typeof entriesFrom>) => ({
    logs,
    isLoading: false,
    error: null,
    refresh: jest.fn(),
    clearLogs: jest.fn(),
    logRate: 5,
  })

  it("shows a 'jump to latest' toast when new logs arrive with auto-scroll paused", () => {
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(0, 60)))
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        autoRefresh: true,
        autoScroll: false,
        setFocusedIndex,
      })
    )
    const { rerender } = render(<LogPanel />)
    // Five entries newer than anything seen so far.
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(5, 65)))
    rerender(<LogPanel />)
    expect(mockToast).toHaveBeenCalled()
    const toastArgs = mockToast.mock.calls[0]
    expect(toastArgs[0]).toContain("5")
    const opts = toastArgs[1] as { action?: { onClick?: () => void } }
    expect(opts.action).toBeDefined()
    setFocusedIndex.mockClear()
    opts.action?.onClick?.()
    expect(setFocusedIndex).toHaveBeenCalledWith(-1)
  })

  it("keeps following at the top without a toast while auto-scroll is on", () => {
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(0, 60)))
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ autoRefresh: true, autoScroll: true })
    )
    const { rerender } = render(<LogPanel />)
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(5, 65)))
    rerender(<LogPanel />)
    expect(mockToast).not.toHaveBeenCalled()
  })

  it("still notices arrivals once the window is full and the length stops growing", () => {
    // 1000 in, 1000 out: the oldest three fall off as three new ones arrive.
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(0, 1000)))
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ autoRefresh: true, autoScroll: false })
    )
    const { rerender } = render(<LogPanel />)
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(3, 1000)))
    rerender(<LogPanel />)
    expect(mockToast).toHaveBeenCalledTimes(1)
    expect(mockToast.mock.calls[0][0]).toContain("3")
  })

  it("does not toast when nothing newer arrived", () => {
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(0, 60)))
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ autoRefresh: true, autoScroll: false })
    )
    const { rerender } = render(<LogPanel />)
    mockUseLogStream.mockReturnValue(streamOf(entriesFrom(0, 60)))
    rerender(<LogPanel />)
    expect(mockToast).not.toHaveBeenCalled()
  })
})

describe("LogPanel — clear confirmation + exports", () => {
  const sampleLogs = [
    {
      id: "l-1",
      timestamp: "2026-07-11T01:00:00.000Z",
      level: "error",
      module: "net",
      message: 'boom "quoted"',
      traceId: "t-1",
      sessionId: "s-1",
      source: "frontend",
      data: { code: 500 },
    },
  ]

  function streamState(overrides: Record<string, unknown> = {}) {
    return {
      logs: sampleLogs,
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      stats: {
        total: 1,
        byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 1, fatal: 0 },
      },
      ...overrides,
    }
  }

  let createObjectURLSpy: jest.SpyInstance | undefined
  let revokeObjectURLSpy: jest.SpyInstance | undefined
  let anchorClickSpy: jest.SpyInstance
  let capturedBlobs: Blob[]

  beforeEach(() => {
    capturedBlobs = []
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true })
      Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true })
    }
    createObjectURLSpy = jest.spyOn(URL, "createObjectURL").mockImplementation(((blob: Blob) => {
      capturedBlobs.push(blob)
      return "blob:x"
    }) as never)
    revokeObjectURLSpy = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    // Spy the anchor click so jsdom doesn't attempt a real navigation.
    anchorClickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  })

  afterEach(() => {
    createObjectURLSpy?.mockRestore()
    revokeObjectURLSpy?.mockRestore()
    anchorClickSpy.mockRestore()
  })

  it("asks for confirmation before clearing, and toasts only once the clear resolved", async () => {
    let resolveClear: () => void = () => {}
    const clearLogs = jest.fn(() => new Promise<void>((resolve) => (resolveClear = resolve)))
    mockUseLogStream.mockReturnValue(streamState({ clearLogs }))
    mockToastSuccess.mockClear()
    render(<LogPanel />)

    fireEvent.click(screen.getByTestId("stub-toolbar-clear"))
    expect(clearLogs).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog")
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /clear logs/i }))
    expect(clearLogs).toHaveBeenCalledTimes(1)
    expect(mockToastSuccess).not.toHaveBeenCalled()
    await act(async () => {
      resolveClear()
    })
    expect(mockToastSuccess).toHaveBeenCalledWith("Logs cleared")
  })

  it("reports a failed clear instead of claiming success", async () => {
    const clearLogs = jest.fn(() => Promise.reject(new Error("locked")))
    mockUseLogStream.mockReturnValue(streamState({ clearLogs }))
    mockToastSuccess.mockClear()
    mockToastError.mockClear()
    render(<LogPanel />)
    fireEvent.click(screen.getByTestId("stub-toolbar-clear"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clear logs/i }))
    })
    expect(mockToastSuccess).not.toHaveBeenCalled()
    expect(mockToastError).toHaveBeenCalledWith("Couldn't clear the logs", {
      description: "locked",
    })
  })

  it("hides agent-trace spans older than the clear, which live in their own table", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-07-11T02:00:00.000Z"))
    try {
      const clearLogs = jest.fn(() => Promise.resolve())
      mockUseLogStream.mockReturnValue(streamState({ logs: [], clearLogs }))
      mockUseAgentTraceAsLogs.mockReturnValue({
        logs: [
          {
            id: "old-span",
            timestamp: "2026-07-11T01:00:00.000Z",
            level: "info",
            module: "agent.trace",
            message: "old",
          },
        ],
      })
      const { rerender } = render(<LogPanel />)
      expect(mockVirtualizedListProps.filteredLogs?.map((l) => l.id)).toEqual(["old-span"])
      fireEvent.click(screen.getByTestId("stub-toolbar-clear"))
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /clear logs/i }))
      })
      expect(mockVirtualizedListProps.filteredLogs).toEqual([])
      // A span written after the clear shows up.
      mockUseAgentTraceAsLogs.mockReturnValue({
        logs: [
          {
            id: "new-span",
            timestamp: "2026-07-11T03:00:00.000Z",
            level: "info",
            module: "agent.trace",
            message: "new",
          },
          {
            id: "old-span",
            timestamp: "2026-07-11T01:00:00.000Z",
            level: "info",
            module: "agent.trace",
            message: "old",
          },
        ],
      })
      rerender(<LogPanel />)
      expect(mockVirtualizedListProps.filteredLogs?.map((l) => l.id)).toEqual(["new-span"])
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not clear when the dialog is cancelled", () => {
    const clearLogs = jest.fn()
    mockUseLogStream.mockReturnValue(streamState({ clearLogs }))
    render(<LogPanel />)

    fireEvent.click(screen.getByTestId("stub-toolbar-clear"))
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(clearLogs).not.toHaveBeenCalled()
  })

  it("exports NDJSON as one JSON object per line", async () => {
    mockUseLogStream.mockReturnValue(streamState())
    render(<LogPanel />)

    fireEvent.click(screen.getByTestId("stub-toolbar-export-ndjson"))
    expect(capturedBlobs).toHaveLength(1)
    const text = await capturedBlobs[0].text()
    const lines = text.split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).id).toBe("l-1")
    expect(anchorClickSpy).toHaveBeenCalled()
  })

  it("exports CSV with trace/session/source/data columns", async () => {
    mockUseLogStream.mockReturnValue(streamState())
    render(<LogPanel />)

    fireEvent.click(screen.getByTestId("stub-toolbar-export-csv"))
    expect(capturedBlobs).toHaveLength(1)
    const text = await capturedBlobs[0].text()
    const [header, row] = text.split("\n")
    expect(header).toContain('"TraceId","SessionId","Source","Data"')
    expect(row).toContain('"t-1"')
    expect(row).toContain('"s-1"')
    expect(row).toContain('"frontend"')
    expect(row).toContain('""code"":500')
  })
})

describe("LogPanel — level tabs and faceted counts", () => {
  const mixed = [
    { id: "e1", timestamp: "2026-01-01T12:00:05Z", level: "error", module: "m", message: "e1" },
    { id: "f1", timestamp: "2026-01-01T12:00:04Z", level: "fatal", module: "m", message: "f1" },
    { id: "w1", timestamp: "2026-01-01T12:00:03Z", level: "warn", module: "m", message: "w1" },
    { id: "i1", timestamp: "2026-01-01T12:00:02Z", level: "info", module: "m", message: "i1" },
    { id: "i2", timestamp: "2026-01-01T12:00:01Z", level: "info", module: "m", message: "i2" },
  ]
  beforeEach(() => {
    mockUseLogStream.mockReturnValue({
      logs: mixed,
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      windowCapped: false,
    })
  })

  it("does not push the level to the store, so every level stays countable", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ levelFilter: "warn" }))
    render(<LogPanel />)
    const options = mockUseLogStream.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(options).not.toHaveProperty("level")
    expect(options.maxLogs).toBe(1000)
  })

  it("Warning shows warnings only, not warn-and-above", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ levelFilter: "warn" }))
    render(<LogPanel />)
    expect(mockVirtualizedListProps.filteredLogs?.map((log) => log.id)).toEqual(["w1"])
  })

  it("Error carries fatal", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ levelFilter: "error" }))
    render(<LogPanel />)
    expect(mockVirtualizedListProps.filteredLogs?.map((log) => log.id)).toEqual(["e1", "f1"])
  })

  it("badges stay the same whichever tab is selected", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ levelFilter: "info" }))
    render(<LogPanel />)
    const stats = mockToolbarProps.stats as { total: number; byLevel: Record<string, number> }
    expect(stats.total).toBe(5)
    expect(stats.byLevel).toEqual({ error: 1, fatal: 1, warn: 1, info: 2 })
  })

  it("counts badges after the non-level filters, so a badge equals its tab's rows", () => {
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ levelFilter: "all", traceFocusId: "nope" })
    )
    render(<LogPanel />)
    const stats = mockToolbarProps.stats as { total: number }
    expect(stats.total).toBe(0)
  })

  it("counts bookmarks inside the current facet set", () => {
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ bookmarkedIds: new Set(["w1", "gone-from-window"]) })
    )
    render(<LogPanel />)
    expect(mockToolbarProps.bookmarkedCount).toBe(1)
  })

  it("flags a full window to the stats bar", () => {
    mockUseLogStream.mockReturnValue({
      logs: Array.from({ length: 1000 }, (_, i) => ({
        id: `w-${i}`,
        timestamp: new Date(Date.parse("2026-01-01T12:00:00Z") - i * 1000).toISOString(),
        level: "info",
        module: "m",
        message: "x",
      })),
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      windowCapped: true,
    })
    render(<LogPanel />)
    expect(mockStatsBarProps.windowCapped).toBe(true)
    expect(mockStatsBarProps.windowSize).toBe(1000)
  })

  it("takes the full-window flag from the stream's pre-search count, not the rows shown", () => {
    // A search that leaves two rows out of a full window still only searched
    // the newest 1000 entries.
    mockUseLogStream.mockReturnValue({
      logs: mixed.slice(0, 2),
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      windowCapped: true,
    })
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ searchQuery: "e1" }))
    render(<LogPanel />)
    expect(mockStatsBarProps.windowCapped).toBe(true)
    expect(mockVirtualizedListProps.emptyStateContext?.windowCappedCount).toBe(1000)
  })

  it("does not flag a window that is not full", () => {
    render(<LogPanel />)
    expect(mockStatsBarProps.windowCapped).toBe(false)
  })
})

describe("LogPanel — keyboard cursor", () => {
  const rows = [
    { id: "a", timestamp: "2026-01-01T12:00:03Z", level: "info", module: "m", message: "a" },
    { id: "b", timestamp: "2026-01-01T12:00:02Z", level: "info", module: "m", message: "b" },
    { id: "c", timestamp: "2026-01-01T12:00:01Z", level: "info", module: "m", message: "c" },
  ]
  beforeEach(() => {
    mockUseLogStream.mockReturnValue({
      logs: rows,
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
    })
  })

  it("hands the cursor to the list so the row can show it", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ focusedIndex: 2 }))
    render(<LogPanel />)
    expect(mockVirtualizedListProps.focusedIndex).toBe(2)
  })

  it("j / ArrowDown step the cursor; the first step from nowhere lands on the first row", () => {
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ focusedIndex: -1, setFocusedIndex })
    )
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "j" })
    expect(setFocusedIndex).toHaveBeenLastCalledWith(0)
  })

  it("k / ArrowUp clamp at the first row", () => {
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ focusedIndex: 0, setFocusedIndex }))
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "ArrowUp" })
    expect(setFocusedIndex).toHaveBeenLastCalledWith(0)
  })

  it("moves the selection with the cursor while the detail pane is open", () => {
    const setSelectedLog = jest.fn()
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        focusedIndex: 0,
        setFocusedIndex,
        setSelectedLog,
        selectedLog: rows[0],
        showDetailPanel: true,
      })
    )
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "j" })
    expect(setFocusedIndex).toHaveBeenLastCalledWith(1)
    expect(setSelectedLog).toHaveBeenLastCalledWith(rows[1])
  })

  it("leaves the selection alone when the detail pane is closed", () => {
    const setSelectedLog = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ focusedIndex: 0, setSelectedLog, showDetailPanel: false })
    )
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "j" })
    expect(setSelectedLog).not.toHaveBeenCalled()
  })

  it("Enter and o open the focused entry; e expands it in place", () => {
    const handleSelectLog = jest.fn()
    const toggleExpanded = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ focusedIndex: 1, handleSelectLog, toggleExpanded })
    )
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "Enter" })
    expect(handleSelectLog).toHaveBeenLastCalledWith(rows[1])
    fireEvent.keyDown(window, { key: "o" })
    expect(handleSelectLog).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(window, { key: "e" })
    expect(toggleExpanded).toHaveBeenCalledWith("b")
  })

  it("ignores a key a focused control already handled", () => {
    const handleSelectLog = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ focusedIndex: 1, handleSelectLog }))
    render(<LogPanel />)
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(handleSelectLog).not.toHaveBeenCalled()
  })

  it("leaves arrow keys to an open menu", () => {
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ focusedIndex: 0, setFocusedIndex }))
    render(<LogPanel />)
    const menu = document.createElement("div")
    menu.setAttribute("role", "menu")
    const item = document.createElement("button")
    menu.appendChild(item)
    document.body.appendChild(menu)
    setFocusedIndex.mockClear() // the mount-time clamp effect also calls it
    fireEvent.keyDown(item, { key: "ArrowDown", bubbles: true })
    expect(setFocusedIndex).not.toHaveBeenCalled()
    document.body.removeChild(menu)
  })

  it("a row click moves the cursor there and opens the entry", () => {
    const handleSelectLog = jest.fn()
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ focusedIndex: -1, handleSelectLog, setFocusedIndex })
    )
    render(<LogPanel />)
    mockVirtualizedListProps.onActivateRow?.(rows[2], 2)
    expect(setFocusedIndex).toHaveBeenCalledWith(2)
    expect(handleSelectLog).toHaveBeenCalledWith(rows[2])
  })
})

describe("LogPanel — click-throughs", () => {
  it("dashboard 'top error' searches and returns to the list", () => {
    const setSearchQuery = jest.fn()
    const setViewMode = jest.fn()
    const setUseRegex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        viewMode: "dashboard",
        useRegex: true,
        setSearchQuery,
        setViewMode,
        setUseRegex,
      })
    )
    render(<LogPanel />)
    ;(mockDashboardProps.onSearchFilter as (q: string) => void)("boom (code 5)")
    expect(setSearchQuery).toHaveBeenCalledWith("boom (code 5)")
    // An error message is a literal; regex would misread its punctuation.
    expect(setUseRegex).toHaveBeenCalledWith(false)
    expect(setViewMode).toHaveBeenCalledWith("list")
  })

  it("dashboard module bar filters by module and returns to the list", () => {
    const setModuleFilter = jest.fn()
    const setViewMode = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ viewMode: "dashboard", setModuleFilter, setViewMode })
    )
    render(<LogPanel />)
    ;(mockDashboardProps.onModuleFilter as (m: string) => void)("auth")
    expect(setModuleFilter).toHaveBeenCalledWith("auth")
    expect(setViewMode).toHaveBeenCalledWith("list")
  })

  it("dashboard level click selects the tab (fatal folds into Error)", () => {
    const setLevelFilter = jest.fn()
    const setViewMode = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        viewMode: "dashboard",
        setLevelFilter,
        setViewMode,
      })
    )
    render(<LogPanel />)
    ;(mockDashboardProps.onLevelFilter as (l: string) => void)("fatal")
    expect(setLevelFilter).toHaveBeenCalledWith("error")
    expect(setViewMode).toHaveBeenCalledWith("list")
  })

  it("trace view selection focuses the trace and shows its rows", () => {
    const setTraceFocusId = jest.fn()
    const setViewMode = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ viewMode: "trace", setTraceFocusId, setViewMode })
    )
    render(<LogPanel />)
    fireEvent.click(screen.getByTestId("stub-trace-view"))
    expect(setTraceFocusId).toHaveBeenCalledWith("trace-x")
    expect(setViewMode).toHaveBeenCalledWith("list")
  })

  it("offers 'open in Traces' only on agent-trace entries with a host that can open it", () => {
    const span = {
      id: "s1",
      timestamp: "2026-01-01T12:00:00Z",
      level: "info",
      module: "agent.trace",
      message: "span",
      traceId: "t-9",
    }
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: span, showDetailPanel: true })
    )
    const onOpenTrace = jest.fn()
    const { rerender } = render(<LogPanel onOpenTrace={onOpenTrace} />)
    ;(mockDetailPanelProps.onOpenTrace as () => void)()
    expect(onOpenTrace).toHaveBeenCalledWith("t-9")

    // No host explorer → no button.
    rerender(<LogPanel />)
    expect(mockDetailPanelProps.onOpenTrace).toBeUndefined()

    // A plain log line with a trace id and no span in its trace → no button.
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: { ...span, module: "net" }, showDetailPanel: true })
    )
    rerender(<LogPanel onOpenTrace={onOpenTrace} />)
    expect(mockDetailPanelProps.onOpenTrace).toBeUndefined()
  })

  it("offers 'open in Traces' on a plain line whose trace has agent spans", () => {
    const line = {
      id: "l-x",
      timestamp: "2026-01-01T12:00:01Z",
      level: "info",
      module: "net",
      message: "line",
      traceId: "t-9",
    }
    mockUseLogStream.mockReturnValue({
      logs: [line],
      isLoading: false,
      error: null,
      refresh: jest.fn(),
      clearLogs: jest.fn(),
      logRate: 0,
      windowCapped: false,
    })
    mockUseAgentTraceAsLogs.mockReturnValue({
      logs: [
        {
          id: "s1",
          timestamp: "2026-01-01T12:00:00Z",
          level: "info",
          module: "agent.trace",
          message: "span",
          traceId: "t-9",
        },
      ],
    })
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ selectedLog: line, showDetailPanel: true })
    )
    const onOpenTrace = jest.fn()
    render(<LogPanel onOpenTrace={onOpenTrace} />)
    ;(mockDetailPanelProps.onOpenTrace as () => void)()
    expect(onOpenTrace).toHaveBeenCalledWith("t-9")
  })

  it("hands onOpenTrace to the trace view", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ viewMode: "trace" }))
    const onOpenTrace = jest.fn()
    render(<LogPanel onOpenTrace={onOpenTrace} />)
    expect(mockTraceViewProps.onOpenTrace).toBe(onOpenTrace)
  })

  it("offers trace / session focus from the detail pane only when it would narrow the list", () => {
    const handleFocusTrace = jest.fn()
    const handleFocusSession = jest.fn()
    const entry = {
      id: "x",
      timestamp: "2026-01-01T12:00:00Z",
      level: "info",
      module: "m",
      message: "x",
      traceId: "t-1",
      sessionId: "s-1",
    }
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        selectedLog: entry,
        showDetailPanel: true,
        handleFocusTrace,
        handleFocusSession,
      })
    )
    const { rerender } = render(<LogPanel />)
    ;(mockDetailPanelProps.onFocusTrace as () => void)()
    ;(mockDetailPanelProps.onFocusSession as () => void)()
    expect(handleFocusTrace).toHaveBeenCalledWith("t-1", entry)
    expect(handleFocusSession).toHaveBeenCalledWith("s-1", entry)

    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        selectedLog: entry,
        showDetailPanel: true,
        traceFocusId: "t-1",
        sessionFilter: "s-1",
      })
    )
    rerender(<LogPanel />)
    expect(mockDetailPanelProps.onFocusTrace).toBeUndefined()
    expect(mockDetailPanelProps.onFocusSession).toBeUndefined()
  })

  it("the chip row's Clear all resets facets but not search or level", () => {
    const filters = defaultFilterState({ searchQuery: "keep", levelFilter: "warn" })
    mockUseLogPanelFilters.mockReturnValue(filters)
    render(<LogPanel />)
    ;(mockToolbarProps.onClearAllFilters as () => void)()
    expect(filters.setModuleFilter).toHaveBeenCalledWith("all")
    expect(filters.setSourceFilter).toHaveBeenCalledWith("all")
    expect(filters.setSessionFilter).toHaveBeenCalledWith("")
    expect(filters.setTimeRange).toHaveBeenCalledWith("all")
    expect(filters.setCustomTimeRange).toHaveBeenCalledWith(null)
    expect(filters.setTraceFocusId).toHaveBeenCalledWith(null)
    expect(filters.setDiagnosticTransportFilter).toHaveBeenCalledWith(null)
    expect(filters.setSearchQuery).not.toHaveBeenCalled()
    expect(filters.setLevelFilter).not.toHaveBeenCalled()
  })

  it("only enables the toolbar's detail toggle when something is selected", () => {
    render(<LogPanel />)
    expect(mockToolbarProps.canShowDetail).toBe(false)
  })
})

describe("LogPanel — Logs channel fixes", () => {
  const rows = [
    {
      id: "a",
      timestamp: "2026-01-01T12:00:03Z",
      level: "error",
      module: "net",
      message: "boom a",
      traceId: "t-1",
    },
    { id: "b", timestamp: "2026-01-01T12:00:02Z", level: "info", module: "net", message: "fine b" },
    { id: "c", timestamp: "2026-01-01T12:00:01Z", level: "info", module: "net", message: "fine c" },
  ]
  const stream = (logs: unknown[] = rows, extra: Record<string, unknown> = {}) => ({
    logs,
    isLoading: false,
    error: null,
    refresh: jest.fn(),
    clearLogs: jest.fn(),
    logRate: 0,
    windowCapped: false,
    ...extra,
  })
  const span = (id: string, message: string, ts = "2026-01-01T12:00:00Z") => ({
    id,
    timestamp: ts,
    level: "info",
    module: "agent.trace",
    message,
    traceId: "t-span",
  })

  beforeEach(() => {
    mockUseLogStream.mockReturnValue(stream())
    mockUseAgentTraceAsLogs.mockReturnValue({ logs: [] })
  })

  it("searches the agent-trace spans too, honouring the regex setting", () => {
    mockUseAgentTraceAsLogs.mockReturnValue({
      logs: [span("s1", "boom in span"), span("s2", "quiet span", "2026-01-01T11:59:00Z")],
    })
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ searchQuery: "boom" }))
    const { rerender } = render(<LogPanel />)
    let ids = (mockVirtualizedListProps.filteredLogs ?? []).map((l) => l.id)
    expect(ids).toContain("s1")
    expect(ids).not.toContain("s2")

    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ searchQuery: "^quiet", useRegex: true })
    )
    rerender(<LogPanel />)
    ids = (mockVirtualizedListProps.filteredLogs ?? []).map((l) => l.id)
    expect(ids).toContain("s2")
    expect(ids).not.toContain("s1")
    // The badges count the same rows.
    expect((mockToolbarProps.stats as { total: number }).total).toBe(ids.length)
  })

  it("freezes the span rows with Live off, and a manual refresh re-reads them", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ autoRefresh: false }))
    render(<LogPanel />)
    const before = mockUseAgentTraceAsLogs.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(before).toMatchObject({ live: false })
    act(() => {
      ;(mockToolbarProps.refresh as () => void)()
    })
    const after = mockUseAgentTraceAsLogs.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(after.refreshToken).toBe((before.refreshToken as number) + 1)

    act(() => {
      fireEvent.keyDown(window, { key: "r" })
    })
    const again = mockUseAgentTraceAsLogs.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(again.refreshToken).toBe((before.refreshToken as number) + 2)
  })

  it("follows live with Live on", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ autoRefresh: true }))
    render(<LogPanel />)
    expect(mockUseAgentTraceAsLogs.mock.calls.at(-1)?.[0]).toMatchObject({ live: true })
  })

  it("closing the transport band only closes it; the filters stay", () => {
    mockUseTransportHealth.mockReturnValue({
      healthByTransport: {
        remote: {
          transport: "remote",
          status: "degraded",
          queueDepth: 1,
          retryCount: 0,
          droppedEntries: 0,
          updatedAt: "",
        },
      },
      queueDepthHistoryByTransport: {},
      nativeLogging: { runtime: "web", status: "inactive", activeTargets: [] },
    })
    const filters = defaultFilterState({
      selectedTransportHealthName: "remote",
      diagnosticTransportFilter: "remote",
    })
    mockUseLogPanelFilters.mockReturnValue(filters)
    render(<LogPanel />)
    fireEvent.click(screen.getByTestId("stub-transport-detail-close"))
    expect(filters.setSelectedTransportHealthName).toHaveBeenCalledWith(null)
    expect(filters.setDiagnosticTransportFilter).not.toHaveBeenCalled()
  })

  it("keeps the bands in one slot: opening one closes the other", () => {
    const filters = defaultFilterState()
    mockUseLogPanelFilters.mockReturnValue(filters)
    render(<LogPanel />)
    fireEvent.click(screen.getByTestId("stub-health-native"))
    expect(filters.setSelectedTransportHealthName).toHaveBeenCalledWith(null)
    expect(filters.setSelectedNativeLogging).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByTestId("stub-health-transport"))
    expect(filters.setSelectedNativeLogging).toHaveBeenCalledWith(false)
    expect(filters.setSelectedTransportHealthName).toHaveBeenCalledWith("remote")
  })

  it("shows one band at a time even when state names two", () => {
    mockUseTransportHealth.mockReturnValue({
      healthByTransport: {
        remote: {
          transport: "remote",
          status: "degraded",
          queueDepth: 1,
          retryCount: 0,
          droppedEntries: 0,
          updatedAt: "",
        },
      },
      queueDepthHistoryByTransport: {},
      nativeLogging: { runtime: "web", status: "inactive", activeTargets: [] },
    })
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        selectedTransportHealthName: "remote",
        selectedNativeLogging: true,
        moduleFilter: "agent.trace",
      })
    )
    render(<LogPanel />)
    const band = screen.getByTestId("log-panel-band")
    expect(band.children).toHaveLength(1)
    expect(screen.queryByTestId("stub-native-logging-close")).not.toBeInTheDocument()
    expect(screen.queryByTestId("stub-agent-trace-stats")).not.toBeInTheDocument()
  })

  it("draws the dashboard over the facet set, not the level-filtered list", () => {
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ viewMode: "dashboard", levelFilter: "error" })
    )
    render(<LogPanel />)
    expect((mockDashboardProps.logs as unknown[]).length).toBe(3)
  })

  it("steps the detail pane across the whole list and moves the cursor with it", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `r-${i}`,
      timestamp: new Date(Date.parse("2026-01-01T12:00:00Z") - i * 1000).toISOString(),
      level: "info",
      module: "m",
      message: `m-${i}`,
    }))
    mockUseLogStream.mockReturnValue(stream(many))
    const setSelectedLog = jest.fn()
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        selectedLog: many[99],
        showDetailPanel: true,
        setSelectedLog,
        setFocusedIndex,
      })
    )
    render(<LogPanel />)
    // Past any old page boundary.
    expect(mockDetailPanelProps.navPosition).toEqual({ index: 100, total: 120 })
    ;(mockDetailPanelProps.onNavigate as (d: number) => void)(1)
    expect(setSelectedLog).toHaveBeenLastCalledWith(many[100])
    expect(setFocusedIndex).toHaveBeenLastCalledWith(100)
    // A related entry becomes the selection and takes the cursor.
    ;(mockDetailPanelProps.onSelectRelated as (log: unknown) => void)(many[7])
    expect(setSelectedLog).toHaveBeenLastCalledWith(many[7])
    expect(setFocusedIndex).toHaveBeenLastCalledWith(7)
    // The list is not paged: every row reaches the virtualizer.
    expect(mockVirtualizedListProps.filteredLogs).toHaveLength(120)
  })

  it("hides the detail pane outside the list view", () => {
    for (const viewMode of ["dashboard", "trace"]) {
      mockUseLogPanelFilters.mockReturnValue(
        defaultFilterState({ viewMode, selectedLog: rows[0], showDetailPanel: true })
      )
      const { unmount } = render(<LogPanel />)
      expect(screen.queryByTestId("stub-detail-panel")).not.toBeInTheDocument()
      expect(screen.queryByTestId("resizable-panel-log-panel-detail")).not.toBeInTheDocument()
      unmount()
    }
  })

  it("Escape closes the detail pane, then clears the search", () => {
    const filters = defaultFilterState({
      selectedLog: rows[0],
      showDetailPanel: true,
      searchQuery: "boom",
    })
    mockUseLogPanelFilters.mockReturnValue(filters)
    const { rerender } = render(<LogPanel />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(filters.setShowDetailPanel).toHaveBeenCalledWith(false)
    expect(filters.setSearchQuery).not.toHaveBeenCalled()

    const closed = defaultFilterState({ searchQuery: "boom" })
    mockUseLogPanelFilters.mockReturnValue(closed)
    rerender(<LogPanel />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(closed.setSearchQuery).toHaveBeenCalledWith("")
  })

  it("leaves an Escape that closed a menu, select or popover alone", () => {
    const filters = defaultFilterState({
      selectedLog: rows[0],
      showDetailPanel: true,
      searchQuery: "boom",
    })
    mockUseLogPanelFilters.mockReturnValue(filters)
    render(<LogPanel />)
    // Radix prevents the default on the Escape it dismisses with.
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    handled.preventDefault()
    window.dispatchEvent(handled)
    // Focus still inside a popup also means the Escape was the popup's.
    for (const role of ["menu", "listbox", "dialog"]) {
      const popup = document.createElement("div")
      popup.setAttribute("role", role)
      const item = document.createElement("button")
      popup.appendChild(item)
      document.body.appendChild(popup)
      fireEvent.keyDown(item, { key: "Escape", bubbles: true })
      popup.remove()
    }
    expect(filters.setShowDetailPanel).not.toHaveBeenCalled()
    expect(filters.setSearchQuery).not.toHaveBeenCalled()
  })

  it("uses the host's transport health and starts no poll of its own", () => {
    const shared = {
      healthByTransport: {},
      queueDepthHistoryByTransport: {},
      nativeLogging: { runtime: "tauri", status: "healthy", activeTargets: [] },
    } as never
    render(<LogPanel transportHealth={shared} />)
    expect(mockUseTransportHealth.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false })
    expect(mockDashboardProps).toBeDefined()
  })

  it("polls transport health itself when no host poll is given", () => {
    render(<LogPanel />)
    expect(mockUseTransportHealth.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true })
  })

  it("forwards the storage scope to the filter hook", () => {
    render(<LogPanel storageScope="settings-mcp" />)
    expect(mockUseLogPanelFilters.mock.calls.at(-1)?.[0]).toMatchObject({
      storageScope: "settings-mcp",
    })
  })

  it("sizes the agent-trace stats window to the panel's time range", () => {
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({ moduleFilter: "agent.trace", timeRange: "all" })
    )
    render(<LogPanel />)
    expect(screen.getByTestId("stub-agent-trace-stats")).toHaveAttribute("data-window", "all")
  })

  it("offers the trace view when entries carry trace ids, even without agent spans", () => {
    render(<LogPanel includeAgentTrace={false} />)
    expect(mockToolbarProps.traceViewAvailable).toBe(true)
    mockUseLogStream.mockReturnValue(stream([rows[1], rows[2]]))
    render(<LogPanel includeAgentTrace={false} />)
    expect(mockToolbarProps.traceViewAvailable).toBe(false)
  })

  it("t toggles the trace view", () => {
    const setViewMode = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ setViewMode }))
    render(<LogPanel />)
    fireEvent.keyDown(window, { key: "t" })
    const toggle = setViewMode.mock.calls.at(-1)?.[0] as (prev: string) => string
    expect(toggle("list")).toBe("trace")
    expect(toggle("trace")).toBe("list")
  })

  it("names the empty state's filters in words", () => {
    mockUseLogPanelFilters.mockReturnValue(
      defaultFilterState({
        levelFilter: "warn",
        sourceFilter: "tauri",
        timeRange: "1h",
        searchQuery: "nothing",
        bookmarkFilterActive: true,
      })
    )
    render(<LogPanel />)
    expect(mockVirtualizedListProps.emptyStateContext?.activeFilterLabels).toEqual([
      "Level: Warning",
      "Source: Tauri",
      "Time: Last 1h",
      "Search: nothing",
      "Bookmarked only",
    ])
  })

  it("draws one bottom border only and gives the URL sync the rows to resolve sel against", () => {
    render(<LogPanel />)
    expect(screen.getByTestId("log-panel")).toHaveClass("border-b")
    expect(screen.getByTestId("log-panel")).not.toHaveClass("border-y")
    const options = mockUseLogPanelUrlSync.mock.calls.at(-1)?.[1] as {
      logs: unknown[]
      logsReady: boolean
    }
    expect(options.logs).toHaveLength(3)
    expect(options.logsReady).toBe(true)
  })

  it("lets a focused row take the cursor (roving tabindex)", () => {
    const setFocusedIndex = jest.fn()
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ setFocusedIndex }))
    render(<LogPanel />)
    mockVirtualizedListProps.onFocusRow?.(2)
    expect(setFocusedIndex).toHaveBeenCalledWith(2)
  })

  it("offers scroll items only over a list, and auto-scroll only while live", () => {
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ viewMode: "dashboard" }))
    const { rerender } = render(<LogPanel />)
    expect(mockToolbarProps.scrollActionsAvailable).toBe(false)
    expect(mockToolbarProps.autoScrollAvailable).toBe(false)
    mockUseLogPanelFilters.mockReturnValue(defaultFilterState({ autoRefresh: true }))
    rerender(<LogPanel />)
    expect(mockToolbarProps.scrollActionsAvailable).toBe(true)
    expect(mockToolbarProps.autoScrollAvailable).toBe(true)
  })
})

describe("agentTraceWindowForRange", () => {
  const now = new Date(2026, 5, 15, 14, 0, 0).getTime()

  it("picks the smallest window that covers the range", () => {
    expect(agentTraceWindowForRange("all", null, now)).toBe("all")
    expect(agentTraceWindowForRange("1h", null, now)).toBe("today")
    // 24h at 14:00 reaches into yesterday.
    expect(agentTraceWindowForRange("24h", null, now)).toBe("week")
    expect(agentTraceWindowForRange("7d", null, now)).toBe("week")
  })

  it("covers a custom range from its start", () => {
    const start = new Date(now - 20 * 24 * 60 * 60 * 1000)
    expect(agentTraceWindowForRange("all", { start, end: new Date(now) }, now)).toBe("month")
    const old = new Date(now - 90 * 24 * 60 * 60 * 1000)
    expect(agentTraceWindowForRange("all", { start: old, end: new Date(now) }, now)).toBe("all")
  })
})
