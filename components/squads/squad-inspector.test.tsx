/** @jest-environment jsdom */

// One Squad's identity and its run controls, shared by the desktop right pane
// and the phone sheet. The point of the extraction is that neither surface can
// end up able to stop a run while the other can only pause it, so the cases
// are about the control wiring.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadInspector } from "./squad-inspector"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"

const start = jest.fn(async () => {})
const pause = jest.fn(async () => {})
const resume = jest.fn(async () => {})
const shutdown = jest.fn(async () => {})
jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({ ready: true, loading: false, blockers: [], evaluatedAt: 1 }),
}))
jest.mock("@/components/squads/squad-readiness-card", () => ({
  SquadReadinessCard: ({ squadId }: { squadId: string }) => (
    <div data-testid="squad-readiness" data-squad={squadId} />
  ),
}))
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: (...a: unknown[]) => start(...(a as [])),
    pause: (...a: unknown[]) => pause(...(a as [])),
    resume: (...a: unknown[]) => resume(...(a as [])),
    shutdown: (...a: unknown[]) => shutdown(...(a as [])),
  },
}))

function seed(status: TeamStatus = "idle", over: Partial<AgentTeam> = {}) {
  const squad = {
    id: "a",
    name: "Review Crew",
    description: "Reads the diff",
    status,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
    ...over,
  } as unknown as AgentTeam
  useAgentTeamStore.setState({ teams: { a: squad } as never })
}

beforeEach(() => {
  jest.clearAllMocks()
  seed()
})

it("names the Squad and its description", () => {
  render(<SquadInspector squadId="a" />)
  expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Review Crew")
  expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Reads the diff")
})

/** A deleted Squad must not leave a header with a blank name behind. */
it("renders nothing for a Squad that is gone", () => {
  render(<SquadInspector squadId="ghost" />)
  expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
})

it("renders whatever body the host composes in", () => {
  render(
    <SquadInspector squadId="a">
      <div data-testid="body">runs</div>
    </SquadInspector>
  )
  expect(screen.getByTestId("body")).toBeInTheDocument()
})

/**
 * These controls only ever existed on a tab of the retired
 * `/agent-teams/workspace`. A fleet view that says what every Squad is doing
 * and can do nothing about any of it is a report, not a console.
 */
it("starts an idle Squad", async () => {
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("start-team"))
  expect(start).toHaveBeenCalledWith("a")
})

it("pauses and stops a live one", async () => {
  seed("executing")
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("pause-team"))
  expect(pause).toHaveBeenCalledWith("a")
})

it("resumes a paused one", async () => {
  seed("paused")
  render(<SquadInspector squadId="a" />)
  await userEvent.click(screen.getByTestId("resume-team"))
  expect(resume).toHaveBeenCalledWith("a")
})

it("sends configuration to Settings, deep-linked to this Squad", () => {
  render(<SquadInspector squadId="a" />)
  const link = screen.getByTestId("squad-fleet-configure")
  expect(link).toHaveAttribute("href", expect.stringContaining("section=squads"))
  expect(link).toHaveAttribute("href", expect.stringContaining("squadTab=squad%3Aa"))
})
