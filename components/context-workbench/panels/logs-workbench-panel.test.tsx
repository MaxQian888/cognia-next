import { render, screen } from "@testing-library/react"
import { LogsWorkbenchPanel } from "./logs-workbench-panel"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const keys: Record<string, string> = {
      "contextWorkbench.logsPanel.count": "{count} entries",
      "contextWorkbench.logsPanel.filterLabel": "Filter by level",
      "contextWorkbench.logsPanel.levels.all": "All",
      "contextWorkbench.logsPanel.levels.error": "Error",
      "contextWorkbench.logsPanel.levels.warn": "Warn",
      "contextWorkbench.logsPanel.levels.info": "Info",
      "contextWorkbench.logsPanel.levels.debug": "Debug",
      "contextWorkbench.logsPanel.levels.trace": "Trace",
      "contextWorkbench.logsPanel.loading": "Loading logs…",
      "contextWorkbench.logsPanel.emptyTitle": "No logs",
      "contextWorkbench.logsPanel.emptyDescription": "No log entries match the current filter.",
      "contextWorkbench.logsPanel.openFullPage": "Open full log viewer",
    }
    return (key: string, params?: Record<string, unknown>) => {
      const fullKey = `${namespace}.${key}`
      const value = keys[fullKey] ?? key
      if (params && "count" in params) return value.replace("{count}", String(params.count))
      return value
    }
  },
}))

// Mock useLogStream
const mockLogs = [
  {
    id: "log-1",
    timestamp: new Date().toISOString(),
    level: "error" as const,
    message: "Connection failed",
    module: "network",
  },
  {
    id: "log-2",
    timestamp: new Date().toISOString(),
    level: "info" as const,
    message: "Server started",
    module: "app",
  },
]

let mockStreamResult = { logs: mockLogs, isLoading: false, error: null }

jest.mock("@/hooks/logging/use-log-stream", () => ({
  useLogStream: () => mockStreamResult,
}))

// Mock ScrollArea
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

describe("LogsWorkbenchPanel", () => {
  beforeEach(() => {
    mockStreamResult = { logs: mockLogs, isLoading: false, error: null }
  })

  it("renders log entries", () => {
    render(<LogsWorkbenchPanel />)
    expect(screen.getByTestId("log-entry-log-1")).toBeInTheDocument()
    expect(screen.getByTestId("log-entry-log-2")).toBeInTheDocument()
    expect(screen.getByText("Connection failed")).toBeInTheDocument()
    expect(screen.getByText("Server started")).toBeInTheDocument()
  })

  it("shows entry count", () => {
    render(<LogsWorkbenchPanel />)
    expect(screen.getByText(/2 entries/)).toBeInTheDocument()
  })

  it("shows loading state", () => {
    mockStreamResult = { logs: [], isLoading: true, error: null }
    render(<LogsWorkbenchPanel />)
    expect(screen.getByText("Loading logs…")).toBeInTheDocument()
  })

  it("shows empty state when no logs", () => {
    mockStreamResult = { logs: [], isLoading: false, error: null }
    render(<LogsWorkbenchPanel />)
    expect(screen.getByText("No logs")).toBeInTheDocument()
  })

  it("renders the level filter dropdown", () => {
    render(<LogsWorkbenchPanel />)
    expect(screen.getByRole("combobox", { name: "Filter by level" })).toBeInTheDocument()
  })

  it("renders link to full logging page", () => {
    render(<LogsWorkbenchPanel />)
    expect(screen.getByText("Open full log viewer")).toBeInTheDocument()
    const link = screen.getByText("Open full log viewer").closest("a")
    expect(link).toHaveAttribute("href", "/logging")
  })

  it("shows error badge when errors are present", () => {
    render(<LogsWorkbenchPanel />)
    // 1 error log entry → badge with "1"
    expect(screen.getByText("1")).toBeInTheDocument()
  })
})
