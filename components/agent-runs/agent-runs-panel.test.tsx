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
