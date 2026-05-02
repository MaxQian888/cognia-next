/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { AgentTeamOverview } from "./overview"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

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

  it("shows the lead name and teammate count", () => {
    render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} />)
    expect(screen.getByText("Lead Bot")).toBeInTheDocument()
    // 1 worker (excluding lead)
    expect(screen.getByText("1")).toBeInTheDocument()
  })

  it("shows 'noLead' fallback when lead isn't in the list", () => {
    render(<AgentTeamOverview team={baseTeam} teammates={[teammate]} />)
    expect(screen.getByText("noLead")).toBeInTheDocument()
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

  it("calls onStart when the team is idle and Run is clicked", () => {
    const onStart = jest.fn()
    render(<AgentTeamOverview team={baseTeam} teammates={[lead, teammate]} onStart={onStart} />)
    fireEvent.click(screen.getByTestId("start-team"))
    expect(onStart).toHaveBeenCalledTimes(1)
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

  it("does not mount the plan-approval panel when requirePlanApproval is off", () => {
    render(
      <AgentTeamOverview
        team={baseTeam}
        teammates={[{ ...lead, status: "awaiting_approval" }, teammate]}
      />
    )
    expect(screen.queryByTestId("plan-approval-panel")).not.toBeInTheDocument()
  })
})
