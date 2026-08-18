import { render, screen, fireEvent } from "@testing-library/react"
import { AgentRunsPanel } from "./agent-runs-panel"
import type { AgentRun } from "@/types/agent-runs/agent-run"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))
jest.mock("@/lib/scheduler/format-utils", () => ({
  formatRelativeTime: () => "just now",
  formatDuration: () => "1s",
}))

let mockRuns: AgentRun[] = []
let mockLoading = false
jest.mock("@/hooks/agent-runs/use-agent-runs", () => ({
  useAgentRuns: () => ({ runs: mockRuns, isLoading: mockLoading }),
}))

const mockPlan: { current: unknown } = { current: undefined }
jest.mock("@/hooks/agent/use-session-plan", () => ({
  usePlanById: (id?: string) => (id ? mockPlan.current : undefined),
}))

const abort = jest.fn()
const pause = jest.fn()
const resume = jest.fn()
const can = { abort: true, pause: true, resume: false }
jest.mock("@/hooks/agent-runs/use-agent-run-actions", () => ({
  useAgentRunActions: () => ({
    canAbort: () => can.abort,
    canPause: () => can.pause,
    canResume: () => can.resume,
    abort: (...a: unknown[]) => abort(...a),
    pause: (...a: unknown[]) => pause(...a),
    resume: (...a: unknown[]) => resume(...a),
  }),
}))

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    unifiedId: "goal:g1",
    kind: "goal",
    title: "Ship feature",
    status: "running",
    startedAt: 1000,
    isLive: true,
    origin: { tableName: "chatGoals", nativeId: "g1", goalId: "g1" },
    ...over,
  } as AgentRun
}

beforeEach(() => {
  mockRuns = []
  mockLoading = false
  abort.mockReset()
  pause.mockReset()
  resume.mockReset()
  can.abort = true
  can.pause = true
  can.resume = false
})

describe("AgentRunsPanel", () => {
  it("shows the empty state when there are no runs", () => {
    render(<AgentRunsPanel onSelect={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists runs and fires onSelect with the unified id", () => {
    mockRuns = [run()]
    const onSelect = jest.fn()
    render(<AgentRunsPanel onSelect={onSelect} />)
    fireEvent.click(screen.getByText("Ship feature"))
    expect(onSelect).toHaveBeenCalledWith("goal:g1")
  })

  it("renders the detail + a working abort action for the selected run", () => {
    mockRuns = [run()]
    render(<AgentRunsPanel selectedId="goal:g1" onSelect={jest.fn()} />)
    // Abort button present (canAbort=true); pause present; resume hidden.
    fireEvent.click(screen.getByText("actions.abort"))
    expect(abort).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("actions.resume")).toBeNull()
  })

  it("fires the kind filter callback", () => {
    const onFilterKind = jest.fn()
    render(<AgentRunsPanel onSelect={jest.fn()} onFilterKind={onFilterKind} />)
    fireEvent.click(screen.getByText("filters.team"))
    expect(onFilterKind).toHaveBeenCalledWith("team")
  })
})

// A plan run's steps ARE the run. Before this the detail pane showed a bare
// percentage for a plan started headlessly (scheduler / workflow / bridge) and
// the step list was reachable only from the chat session that owned it.
describe("plan run detail", () => {
  const planRun = () =>
    run({
      unifiedId: "plan:p1",
      kind: "plan",
      title: "Ship v2",
      origin: { tableName: "agentPlans", nativeId: "p1", planId: "p1" },
    })

  it("renders the live step tracker for a plan run", () => {
    mockPlan.current = {
      id: "p1",
      title: "Ship v2",
      status: "executing",
      steps: [
        {
          id: "s1",
          title: "Build",
          kind: "agent_turn",
          status: "completed",
          order: 0,
          dependencies: [],
        },
      ],
      totalSteps: 1,
      completedSteps: 1,
      config: {},
    }
    mockRuns = [planRun()]
    render(<AgentRunsPanel selectedId="plan:p1" onSelect={jest.fn()} />)
    expect(screen.getByTestId("plan-tracker-panel")).toBeInTheDocument()
    expect(screen.getByTestId("plan-tracker-steps")).toBeInTheDocument()
  })

  it("renders no tracker for a non-plan run", () => {
    mockPlan.current = undefined
    mockRuns = [run()]
    render(<AgentRunsPanel selectedId="goal:g1" onSelect={jest.fn()} />)
    expect(screen.queryByTestId("plan-tracker-panel")).not.toBeInTheDocument()
  })

  it("keeps the detail pane usable while the plan row has not loaded", () => {
    mockPlan.current = undefined
    mockRuns = [planRun()]
    render(<AgentRunsPanel selectedId="plan:p1" onSelect={jest.fn()} />)
    expect(screen.queryByTestId("plan-tracker-panel")).not.toBeInTheDocument()
    expect(screen.getByText("detail.status")).toBeInTheDocument()
  })
})
