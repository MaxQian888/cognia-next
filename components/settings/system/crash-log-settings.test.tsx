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

import { CrashLogSettings } from "./crash-log-settings"

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
      <CrashLogSettings />
    </TooltipProvider>
  )
  return result
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("toolbar stats strip", () => {
  it("shows total, non-zero level counts, native status, and auto-refresh state", () => {
    setup()
    expect(screen.getByText("Visible Incidents")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("Fatal")).toBeInTheDocument()
    expect(screen.getByText("Error")).toBeInTheDocument()
    // warn count is zero — its chip is omitted
    expect(screen.queryByText("Warning")).not.toBeInTheDocument()
    expect(screen.getByText("healthy")).toBeInTheDocument()
    expect(screen.getByText("On")).toBeInTheDocument()
  })

  it("shows the paused indicator and N/A when auto-refresh is off with no update stamp", () => {
    setup({ autoRefresh: false, lastUpdatedAt: null })
    expect(screen.getByText("Off")).toBeInTheDocument()
    expect(screen.getByText("N/A")).toBeInTheDocument()
  })
})

describe("toolbar actions", () => {
  it("refreshes on demand", async () => {
    const result = setup()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(result.refresh).toHaveBeenCalled())
    // busy state releases once the action settles
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled())
  })

  it("toggles auto-refresh", () => {
    const result = setup()
    fireEvent.click(screen.getByRole("button", { name: "Pause Refresh" }))
    expect(result.setAutoRefresh).toHaveBeenCalledWith(false)
  })

  it("exports the selected format from the export menu", async () => {
    const user = userEvent.setup()
    const result = setup()
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByText("Export JSON"))
    expect(result.exportBundle).toHaveBeenCalledWith("json")
  })

  it("disables export when there are no items", () => {
    setup({ items: [], selectedItem: null })
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled()
  })

  it("clears recent and persisted logs from the clear menu", async () => {
    const user = userEvent.setup()
    const result = setup()
    await user.click(screen.getByRole("button", { name: "Clear" }))
    await user.click(await screen.findByText("Clear Recent"))
    expect(result.clearRecent).toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Clear" }))
    await user.click(await screen.findByText("Clear Stored"))
    await waitFor(() => expect(result.clearPersisted).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear" })).not.toBeDisabled())
  })

  it("opens the notes popover with the four sharing notes", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole("button", { name: "Before you share" }))
    expect(await screen.findByText("Before You Share")).toBeInTheDocument()
    expect(screen.getByText(/Exports are sanitized by default/)).toBeInTheDocument()
    expect(screen.getByText(/Desktop-only diagnostics/)).toBeInTheDocument()
    expect(screen.getByText(/Clearing recent errors/)).toBeInTheDocument()
    expect(screen.getByText(/Exported bundles help triage/)).toBeInTheDocument()
  })
})

describe("filters", () => {
  it("forwards search input changes", () => {
    const result = setup()
    fireEvent.change(screen.getByPlaceholderText("Search crash logs..."), {
      target: { value: "renderer" },
    })
    expect(result.setSearchQuery).toHaveBeenCalledWith("renderer")
  })

  it("changes the source filter and shows per-source counts", () => {
    const result = setup()
    const [sourceTrigger] = screen.getAllByRole("combobox")
    fireEvent.click(sourceTrigger)
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Stored (1)"))
    expect(result.setSourceFilter).toHaveBeenCalledWith("persisted")
  })

  it("changes the level filter", () => {
    const result = setup()
    const [, levelTrigger] = screen.getAllByRole("combobox")
    fireEvent.click(levelTrigger)
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Fatal"))
    expect(result.setLevelFilter).toHaveBeenCalledWith("fatal")
  })
})

describe("list and states", () => {
  it("renders a row per item with severity badge and module", () => {
    setup()
    const list = within(screen.getByTestId("crash-list-pane"))
    expect(list.getByText("Renderer crashed")).toBeInTheDocument()
    expect(list.getByText("Sidecar exited")).toBeInTheDocument()
    expect(list.getByText("renderer")).toBeInTheDocument()
    // multi-source badge on the second item
    expect(list.getByText("2 sources")).toBeInTheDocument()
  })

  it("shows the loading state", () => {
    setup({ isLoading: true, items: [], selectedItem: null })
    expect(screen.getByText("Loading crash logs...")).toBeInTheDocument()
  })

  it("shows the load error banner", () => {
    setup({ error: new Error("boom") })
    expect(screen.getByText("Failed to Load Crash Logs")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("shows empty states for the list and the detail pane", () => {
    setup({ items: [], selectedItem: null })
    expect(screen.getByText("No Crash Logs Found")).toBeInTheDocument()
    expect(screen.getByText("No Incident Selected")).toBeInTheDocument()
  })
})

describe("detail pane", () => {
  it("renders header badges, trace id, log detail stub, and diagnostics fields", () => {
    setup()
    const detail = screen.getByTestId("crash-detail-pane")
    expect(within(detail).getByText("fatal")).toBeInTheDocument()
    expect(within(detail).getByText(/trace-abc/)).toBeInTheDocument()
    expect(within(detail).getByTestId("log-detail-panel-stub")).toBeInTheDocument()
    expect(within(detail).getByText("degraded")).toBeInTheDocument()
    expect(within(detail).getByText("C:\\cognia\\logs")).toBeInTheDocument()
  })

  it("expands a collapsible diagnostics section to reveal its JSON", () => {
    setup()
    fireEvent.click(screen.getByText("Window Diagnostics"))
    expect(screen.getByText(/"totalWindows": 2/)).toBeInTheDocument()
  })

  it("copies the selected incident", async () => {
    const result = setup()
    fireEvent.click(screen.getByRole("button", { name: "Copy Selected" }))
    await waitFor(() => expect(result.copySelected).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy Selected" })).not.toBeDisabled()
    )
  })

  it("opens the native log directory", async () => {
    const result = setup()
    fireEvent.click(screen.getByRole("button", { name: "Open Directory" }))
    await waitFor(() => expect(result.openNativeLogDirectory).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled())
  })

  it("falls back to the unavailable label when an item has no diagnostics", () => {
    setup({ selectedItem: errorItem })
    const detail = screen.getByTestId("crash-detail-pane")
    expect(within(detail).getAllByText("Unavailable").length).toBeGreaterThan(0)
  })
})

describe("narrow-pane list/detail switch", () => {
  const hasToken = (testId: string, token: string) =>
    screen.getByTestId(testId).classList.contains(token)

  it("starts with the detail pane hidden in a narrow pane and the list visible", () => {
    setup()
    expect(hasToken("crash-detail-pane", "hidden")).toBe(true)
    // The pane's own width decides, not the viewport: this surface renders
    // inside the settings frame, which is the window minus the app rail minus
    // the settings sidebar, so a `md:` gate split the columns ~330px early.
    expect(hasToken("crash-detail-pane", "@[560px]/settings-pane:flex")).toBe(true)
    expect(hasToken("crash-detail-pane", "md:flex")).toBe(false)
    expect(hasToken("crash-list-pane", "hidden")).toBe(false)
    expect(hasToken("crash-list-pane", "flex")).toBe(true)
  })

  it("opens the detail pane when a row is selected and returns via the back button", () => {
    const result = setup()
    fireEvent.click(screen.getByText("Sidecar exited"))
    expect(result.selectItem).toHaveBeenCalledWith("item-error")
    expect(hasToken("crash-detail-pane", "hidden")).toBe(false)
    expect(hasToken("crash-list-pane", "hidden")).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Back to list" }))
    expect(hasToken("crash-detail-pane", "hidden")).toBe(true)
    expect(hasToken("crash-list-pane", "hidden")).toBe(false)
  })
})
