/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { CrashLogItem } from "@/lib/logging/crash-log"
import type { UseCrashLogsResult } from "@/types/logging/crash-log"

const useCrashLogsMock = jest.fn<UseCrashLogsResult, []>()
jest.mock("@/hooks/logging/use-crash-logs", () => ({
  useCrashLogs: () => useCrashLogsMock(),
}))

jest.mock("@/components/logging/log-detail-panel", () => ({
  LogDetailPanel: () => <div data-testid="log-detail-panel-stub" />,
}))

import { CrashDiagnosticsWorkspace } from "./crash-diagnostics-workspace"

const fatalItem: CrashLogItem = {
  id: "item-fatal",
  title: "Renderer crashed",
  summary: "Unhandled exception in the renderer process",
  timestamp: "2026-06-01T10:00:00Z",
  level: "fatal",
  module: "renderer",
  sources: ["recent"],
  traceId: "trace-abc",
  logEntry: { id: "log-1" } as unknown as CrashLogItem["logEntry"],
  diagnostics: {
    capturedAt: "2026-06-01T10:00:01Z",
    nativeLogging: { status: "degraded" } as never,
    windowDiagnostics: { totalWindows: 2 },
    localRuntimeDiagnostics: { status: "ok" },
    logDirectoryPath: "C:\\cognia\\logs",
    diagnosticsError: null,
  },
}

const errorItem: CrashLogItem = {
  id: "item-error",
  title: "Sidecar exited",
  summary: "The sidecar process exited unexpectedly",
  timestamp: "2026-06-01T09:00:00Z",
  level: "error",
  module: "sidecar",
  sources: ["persisted", "recent"],
}

function buildResult(overrides: Partial<UseCrashLogsResult> = {}): UseCrashLogsResult {
  return {
    isLoading: false,
    isRefreshing: false,
    error: null,
    autoRefresh: true,
    setAutoRefresh: jest.fn(),
    lastUpdatedAt: "2026-06-01T10:05:00Z",
    filters: { source: "all", level: "all", search: "" },
    setSourceFilter: jest.fn(),
    setLevelFilter: jest.fn(),
    setSearchQuery: jest.fn(),
    items: [fatalItem, errorItem],
    selectedItem: fatalItem,
    relatedLogs: [],
    selectItem: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
    clearRecent: jest.fn(),
    clearPersisted: jest.fn().mockResolvedValue(undefined),
    copySelected: jest.fn().mockResolvedValue(true),
    exportBundle: jest.fn(),
    openNativeLogDirectory: jest.fn().mockResolvedValue(true),
    summary: {
      total: 2,
      byLevel: { trace: 0, debug: 0, info: 0, warn: 0, error: 1, fatal: 1 },
      bySource: { recent: 2, persisted: 1, diagnostic: 0 },
      nativeLoggingStatus: "healthy",
    },
    ...overrides,
  }
}

function setup(overrides: Partial<UseCrashLogsResult> = {}) {
  const result = buildResult(overrides)
  useCrashLogsMock.mockReturnValue(result)
  render(
    <TooltipProvider>
      <CrashDiagnosticsWorkspace />
    </TooltipProvider>
  )
  return result
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("counts strip", () => {
  it("reports the total, the poll state and the native status", () => {
    setup()
    const strip = within(screen.getByTestId("crash-summary-strip"))
    expect(strip.getByText("Visible Incidents")).toBeInTheDocument()
    expect(strip.getByText("2")).toBeInTheDocument()
    expect(strip.getByText("healthy")).toBeInTheDocument()
    expect(strip.getByText(/^On/)).toBeInTheDocument()
  })

  it("is the level filter: a chip applies its level, and the active one clears it", () => {
    const result = setup()
    fireEvent.click(screen.getByTestId("crash-level-chip-fatal"))
    expect(result.setLevelFilter).toHaveBeenCalledWith("fatal")
  })

  it("clears back to all when the active level chip is pressed again", () => {
    const result = setup({ filters: { source: "all", level: "error", search: "" } })
    const chip = screen.getByTestId("crash-level-chip-error")
    expect(chip).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(chip)
    expect(result.setLevelFilter).toHaveBeenCalledWith("all")
  })
})

describe("toolbar", () => {
  it("refreshes and releases the busy state", async () => {
    const result = setup()
    fireEvent.click(screen.getByTestId("crash-refresh"))
    await waitFor(() => expect(result.refresh).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId("crash-refresh")).not.toBeDisabled())
  })

  it("toggles auto-refresh", () => {
    const result = setup()
    fireEvent.click(screen.getByTestId("crash-auto-refresh"))
    expect(result.setAutoRefresh).toHaveBeenCalledWith(false)
  })

  it("forwards the search query and the source filter", () => {
    const result = setup()
    fireEvent.change(screen.getByPlaceholderText("Search crash logs..."), {
      target: { value: "renderer" },
    })
    expect(result.setSearchQuery).toHaveBeenCalledWith("renderer")

    fireEvent.click(screen.getByRole("combobox", { name: "Source filter" }))
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Stored (1)"))
    expect(result.setSourceFilter).toHaveBeenCalledWith("persisted")
  })

  it("exports the chosen format and disables export with nothing to export", async () => {
    const user = userEvent.setup()
    const result = setup()
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByText("Export JSON"))
    expect(result.exportBundle).toHaveBeenCalledWith("json")

    setup({ items: [], selectedItem: null })
    expect(screen.getAllByRole("button", { name: "Export" }).at(-1)).toBeDisabled()
  })
})

describe("list and detail", () => {
  it("renders a row per item and selects one", () => {
    const result = setup()
    const rows = screen.getAllByTestId("crash-row")
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).getByText("Sidecar exited")).toBeInTheDocument()
    fireEvent.click(rows[1])
    expect(result.selectItem).toHaveBeenCalledWith("item-error")
  })

  it("shows the selected crash with its native diagnostics", () => {
    setup()
    const detail = within(screen.getByTestId("crash-detail-pane"))
    expect(detail.getByText("Renderer crashed")).toBeInTheDocument()
    expect(detail.getByText("Unhandled exception in the renderer process")).toBeInTheDocument()
    expect(detail.getByTestId("log-detail-panel-stub")).toBeInTheDocument()
    expect(detail.getByText("C:\\cognia\\logs")).toBeInTheDocument()
    expect(detail.getByText("degraded")).toBeInTheDocument()
  })

  it("copies the selection and opens the native log directory", async () => {
    const result = setup()
    fireEvent.click(screen.getByRole("button", { name: "Copy Selected" }))
    await waitFor(() => expect(result.copySelected).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "Open Directory" }))
    await waitFor(() => expect(result.openNativeLogDirectory).toHaveBeenCalled())
  })

  it("renders the empty state instead of a list when nothing matches", () => {
    setup({ items: [], selectedItem: null })
    expect(screen.getByTestId("crash-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("crash-list")).not.toBeInTheDocument()
  })

  it("surfaces a load failure above the list", () => {
    setup({ error: new Error("indexeddb unavailable") })
    expect(screen.getByText("Failed to Load Crash Logs")).toBeInTheDocument()
    expect(screen.getByText("indexeddb unavailable")).toBeInTheDocument()
  })
})
