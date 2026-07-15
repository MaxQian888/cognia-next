/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { AgentTeamOverview } from "./overview"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
  MotionReveal: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

let usageMode = "standard"
jest.mock("@/hooks/usage/use-usage-display-mode", () => ({
  useUsageDisplayMode: () => ({ mode: usageMode, setMode: jest.fn() }),
}))

// useTeamLiveStatus derives status from the durable workflowRuns row. Mock it as
// a pass-through of the store status by default (so existing assertions hold),
// with an override to exercise the "run row wins over stale store status" path.
let liveStatusOverride: AgentTeam["status"] | undefined
jest.mock("@/hooks/agent-runs/use-team-live-status", () => ({
  useTeamLiveStatus: (team: { status: AgentTeam["status"] }) => liveStatusOverride ?? team.status,
}))

beforeEach(() => {
  usageMode = "standard"
  liveStatusOverride = undefined
})

const baseTeam: AgentTeam = {
  id: "t1",
  name: "Squad Alpha",
  description: "Primary research team",
  task: "investigate",
  status: "idle",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 2,
    executionMode: "coordinated",
    displayMode: "compact",
  },
  leadId: "lead-1",
  teammateIds: ["lead-1", "tm-1"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  createdAt: new Date(),
}

const lead: AgentTeammate = {
  id: "lead-1",
  teamId: "t1",
  name: "Lead Bot",
  description: "",
  role: "lead",
  status: "idle",
  config: {},
  completedTaskIds: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  progress: 0,
  createdAt: new Date(),
}

const teammate: AgentTeammate = { ...lead, id: "tm-1", name: "TM-1", role: "teammate" }

describe("AgentTeamOverview", () => {
  it("renders team name + description + status badge", () => {
    render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    expect(screen.getByText("Squad Alpha")).toBeInTheDocument()
    expect(screen.getByText("Primary research team")).toBeInTheDocument()
    expect(screen.getByTestId("team-status").textContent).toContain("idle")
  })

  it("derives the badge + actions from the live run status, not a stale store status", () => {
    // Store still says "executing" (optimistic), but the durable run finished.
    liveStatusOverride = "completed"
    const staleTeam = { ...baseTeam, status: "executing" as const }
    render(<AgentTeamOverview team={staleTeam} teammates={[lead, teammate]} onAbort={jest.fn()} />)
    expect(screen.getByTestId("team-status").textContent).toContain("completed")
    // Completed → Start is offered, Abort is not.
    expect(screen.getByTestId("start-team")).toBeInTheDocument()
    expect(screen.queryByTestId("abort-team")).not.toBeInTheDocument()
  })

  it("offers Pause alongside Abort while the run is live", () => {
    liveStatusOverride = "executing"
    const onPause = jest.fn()
    render(
      <AgentTeamOverview
        team={baseTeam}
        teammates={[lead, teammate]}
        onPause={onPause}
        onAbort={jest.fn()}
      />
    )
    expect(screen.getByTestId("abort-team")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("pause-team"))
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("start-team")).not.toBeInTheDocument()
  })

  it("offers Resume + Stop while paused", () => {
    liveStatusOverride = "paused"
    const onResume = jest.fn()
    const onStop = jest.fn()
    render(
      <AgentTeamOverview
        team={{ ...baseTeam, status: "paused" }}
        teammates={[lead, teammate]}
        onResume={onResume}
        onStop={onStop}
      />
    )
    fireEvent.click(screen.getByTestId("resume-team"))
    expect(onResume).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("stop-team"))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("start-team")).not.toBeInTheDocument()
    expect(screen.queryByTestId("abort-team")).not.toBeInTheDocument()
  })

  it("shows the lead name and teammate count", () => {
    render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    expect(screen.getByText("Lead Bot")).toBeInTheDocument()
    // 1 worker (excluding lead) — surfaced in the metrics tile.
    expect(screen.getByTestId("overview-stat-teammates").textContent).toContain("1")
  })

  it("shows 'noLead' fallback when lead isn't in the list", () => {
    render(<AgentTeamOverview team={baseTeam} teammates={[teammate]} />)
    expect(screen.getByText("noLead")).toBeInTheDocument()
  })

  it("hides the routing-assessment card when there is no assessment", () => {
    render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    expect(screen.queryByTestId("routing-assessment")).not.toBeInTheDocument()
  })

  it("renders the routing-assessment card when an assessment is present", () => {
    const team: AgentTeam = {
      ...baseTeam,
      routingAssessment: {
        recommendedPattern: "parallel_specialists",
        confidence: 0.8,
        reason: "Several independent subtasks.",
        factors: {
          taskComplexity: "moderate",
          specializationNeeded: true,
          contextIsolationNeeded: false,
          delegationCandidate: false,
          budgetPressure: "low",
        },
        createdAt: new Date(),
      },
    }
    render(<AgentTeamOverview team={team} teammates={[lead, teammate]} />)
    expect(screen.getByTestId("routing-assessment")).toBeInTheDocument()
    expect(screen.getByText("Several independent subtasks.")).toBeInTheDocument()
  })

  it("renders the token-usage bar only when a budget is set", () => {
    const { rerender } = render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    expect(screen.queryByTestId("token-usage-bar")).not.toBeInTheDocument()
    rerender(
      <AgentTeamOverview
        team={{ ...baseTeam, config: { ...baseTeam.config, tokenBudget: 1000 } }}
        teammates={[lead, teammate]}
      />
    )
    expect(screen.getByTestId("token-usage-bar")).toBeInTheDocument()
  })

  it("shows the prompt/completion token split only in detailed mode", () => {
    const { rerender } = render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    // Standard mode keeps the split hidden.
    expect(screen.queryByTestId("token-usage-split")).not.toBeInTheDocument()
    usageMode = "detailed"
    rerender(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    const split = screen.getByTestId("token-usage-split")
    expect(split).toHaveTextContent("100")
    expect(split).toHaveTextContent("50")
  })

  it("calls onStart when the team is idle and Run is clicked", () => {
    const onStart = jest.fn()
    render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} onStart={onStart} />)
    fireEvent.click(screen.getByTestId("start-team"))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("shows the ultracode run button only when ultracode is enabled, and calls onStartUltracode", () => {
    const onStartUltracode = jest.fn()
    const { rerender } = render(
      <AgentTeamOverview
        team={baseTeam}
        teammates={[lead, teammate]}
        onStartUltracode={onStartUltracode}
      />
    )
    // Disabled by default → no ultracode button.
    expect(screen.queryByTestId("start-team-ultracode")).not.toBeInTheDocument()

    rerender(
      <AgentTeamOverview
        team={{ ...baseTeam, config: { ...baseTeam.config, ultracode: { enabled: true } } }}
        teammates={[lead, teammate]}
        onStartUltracode={onStartUltracode}
      />
    )
    fireEvent.click(screen.getByTestId("start-team-ultracode"))
    expect(onStartUltracode).toHaveBeenCalledTimes(1)
  })

  it("renders the final result card only when team.finalResult is set", () => {
    const { rerender } = render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    expect(screen.queryByTestId("team-final-result")).not.toBeInTheDocument()
    rerender(
      <AgentTeamOverview
        team={{ ...baseTeam, finalResult: "The synthesized report." }}
        teammates={[lead, teammate]}
      />
    )
    expect(screen.getByTestId("team-final-result")).toHaveTextContent("The synthesized report.")
  })

  it("renders Stop instead of Run when team is executing, calls onAbort", () => {
    const onAbort = jest.fn()
    render(
      <AgentTeamOverview
        team={{ ...baseTeam, status: "executing" }}
        teammates={[lead, teammate]}
        onAbort={onAbort}
      />
    )
    fireEvent.click(screen.getByTestId("abort-team"))
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it("mounts the plan-approval panel when lead is awaiting_approval and requirePlanApproval is on", () => {
    render(
      <AgentTeamOverview
        team={{ ...baseTeam, config: { ...baseTeam.config, requirePlanApproval: true } }}
        teammates={[{ ...lead, status: "awaiting_approval", proposedPlan: '{"x":1}' }, teammate]}
      />
    )
    expect(screen.getByTestId("plan-approval-panel")).toBeInTheDocument()
  })

  it("mounts the plan-approval panel for a risk-raised gate, with requirePlanApproval off", () => {
    // Regression: the panel used to also require `config.requirePlanApproval`,
    // but the runtime opens the gate on `requirePlanApproval || riskRaisedGate`
    // (ADR-0070). For a risk-raised gate the operator was asked to approve a
    // plan no surface rendered — a blind approval. The lead's status is set by
    // the runtime only while the gate is open, so it is sufficient on its own.
    render(
      <AgentTeamOverview
        team={{ ...baseTeam, config: { ...baseTeam.config, requirePlanApproval: false } }}
        teammates={[{ ...lead, status: "awaiting_approval", proposedPlan: '{"x":1}' }, teammate]}
      />
    )
    expect(screen.getByTestId("plan-approval-panel")).toBeInTheDocument()
  })

  it("does not mount the plan-approval panel when the lead is not awaiting approval", () => {
    render(
      <AgentTeamOverview
        team={{ ...baseTeam, config: { ...baseTeam.config, requirePlanApproval: true } }}
        teammates={[{ ...lead, status: "idle" }, teammate]}
      />
    )
    expect(screen.queryByTestId("plan-approval-panel")).not.toBeInTheDocument()
  })
})
