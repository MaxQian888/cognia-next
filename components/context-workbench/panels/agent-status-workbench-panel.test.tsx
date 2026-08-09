import { render, screen } from "@testing-library/react"
import { AgentStatusWorkbenchPanel } from "./agent-status-workbench-panel"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const keys: Record<string, string> = {
      "contextWorkbench.agentStatusPanel.noTeam": "No agent team",
      "contextWorkbench.agentStatusPanel.noTeamDescription": "Start an agent team session.",
      "contextWorkbench.agentStatusPanel.active": "{count} active",
      "contextWorkbench.agentStatusPanel.emptyTitle": "No teammates",
      "contextWorkbench.agentStatusPanel.emptyDescription": "Add teammates to the team.",
      "contextWorkbench.agentStatusPanel.openFullPage": "Open agent workspace",
      "contextWorkbench.agentStatusPanel.title": "Agent Status",
      "contextWorkbench.agentStatusPanel.statuses.idle": "Idle",
      "contextWorkbench.agentStatusPanel.statuses.executing": "Executing",
      "contextWorkbench.agentStatusPanel.statuses.planning": "Planning",
      "contextWorkbench.agentStatusPanel.statuses.completed": "Completed",
      "contextWorkbench.agentStatusPanel.statuses.failed": "Failed",
    }
    return (key: string, params?: Record<string, unknown>) => {
      const fullKey = `${namespace}.${key}`
      const value = keys[fullKey] ?? key
      if (params && "count" in params) return value.replace("{count}", String(params.count))
      return value
    }
  },
}))

// Mock agent team store
let mockTeam: { name: string; id: string } | undefined
let mockTeammates: Array<{
  id: string
  name: string
  status: string
  progress: number
  lastActivity?: string
}> = []

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) => selector({}),
  selectActiveTeam: () => mockTeam,
  selectActiveTeammates: () => mockTeammates,
}))

// Mock ScrollArea and Progress
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/progress", () => ({
  Progress: ({ value, className }: { value: number; className?: string }) => (
    <div data-testid="progress" className={className} role="progressbar" aria-valuenow={value} />
  ),
}))

describe("AgentStatusWorkbenchPanel", () => {
  beforeEach(() => {
    mockTeam = undefined
    mockTeammates = []
  })

  it("shows empty state when no team is active", () => {
    render(<AgentStatusWorkbenchPanel />)
    expect(screen.getByText("No agent team")).toBeInTheDocument()
  })

  it("shows empty teammates state when team exists but no teammates", () => {
    mockTeam = { id: "team-1", name: "Dev Team" }
    mockTeammates = []
    render(<AgentStatusWorkbenchPanel />)
    expect(screen.getByText("Dev Team")).toBeInTheDocument()
    expect(screen.getByText("No teammates")).toBeInTheDocument()
  })

  it("renders teammate rows with status", () => {
    mockTeam = { id: "team-1", name: "Dev Team" }
    mockTeammates = [
      {
        id: "tm-1",
        name: "Researcher",
        status: "executing",
        progress: 45,
        lastActivity: "Searching docs",
      },
      { id: "tm-2", name: "Coder", status: "idle", progress: 0 },
    ]
    render(<AgentStatusWorkbenchPanel />)
    expect(screen.getByTestId("teammate-row-tm-1")).toBeInTheDocument()
    expect(screen.getByTestId("teammate-row-tm-2")).toBeInTheDocument()
    expect(screen.getByText("Researcher")).toBeInTheDocument()
    expect(screen.getByText("Coder")).toBeInTheDocument()
    expect(screen.getByText("Executing")).toBeInTheDocument()
    expect(screen.getByText("Idle")).toBeInTheDocument()
  })

  it("shows progress bar for executing teammates", () => {
    mockTeam = { id: "team-1", name: "Dev Team" }
    mockTeammates = [{ id: "tm-1", name: "Worker", status: "executing", progress: 60 }]
    render(<AgentStatusWorkbenchPanel />)
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60")
  })

  it("shows last activity text", () => {
    mockTeam = { id: "team-1", name: "Dev Team" }
    mockTeammates = [
      {
        id: "tm-1",
        name: "Worker",
        status: "executing",
        progress: 30,
        lastActivity: "Writing tests",
      },
    ]
    render(<AgentStatusWorkbenchPanel />)
    expect(screen.getByText("Writing tests")).toBeInTheDocument()
  })

  it("shows active count badge", () => {
    mockTeam = { id: "team-1", name: "Dev Team" }
    mockTeammates = [
      { id: "tm-1", name: "A", status: "executing", progress: 0 },
      { id: "tm-2", name: "B", status: "planning", progress: 0 },
      { id: "tm-3", name: "C", status: "idle", progress: 0 },
    ]
    render(<AgentStatusWorkbenchPanel />)
    expect(screen.getByText("2 active")).toBeInTheDocument()
  })

  it("renders link to agent workspace", () => {
    mockTeam = { id: "team-1", name: "Dev Team" }
    render(<AgentStatusWorkbenchPanel />)
    const link = screen.getByText("Open agent workspace").closest("a")
    expect(link).toHaveAttribute("href", "/agent-team")
  })
})
