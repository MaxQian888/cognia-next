/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { SquadContextPanel } from "./squad-context-panel"
import type { ChatExecutor } from "@/components/agent/composition/use-chat-executor"
import type { AgentTeammate } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"

const executorState: { current: ChatExecutor } = {
  current: {
    squadId: null,
    squadName: null,
    squads: [],
    select: jest.fn(async () => undefined),
    bindable: true,
  },
}
jest.mock("@/components/agent/composition/use-chat-executor", () => ({
  useChatExecutor: () => executorState.current,
}))

function member(over: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "m1",
    teamId: "sq-1",
    name: "Scout",
    status: "idle",
    progress: 0,
    ...over,
  } as AgentTeammate
}

function seed(members: AgentTeammate[]) {
  useAgentTeamStore.setState({
    teammates: Object.fromEntries(members.map((m) => [m.id, m])) as never,
  })
}

beforeEach(() => {
  executorState.current = {
    squadId: null,
    squadName: null,
    squads: [],
    select: jest.fn(async () => undefined),
    bindable: true,
  }
  seed([])
  usePendingGatesStore.setState({ gates: [] })
})

describe("SquadContextPanel", () => {
  it("says the conversation runs on a single agent, and where to change that", () => {
    // Naming the composer rather than offering a second control for the same
    // decision — one executor entry, not two.
    render(<SquadContextPanel sessionId="s1" />)
    expect(screen.getByTestId("squad-panel-unbound")).toBeInTheDocument()
    expect(screen.getByText(/executor control in the composer/i)).toBeInTheDocument()
  })

  it("flags a binding whose Squad is gone instead of rendering an empty roster", () => {
    executorState.current = { ...executorState.current, squadId: "deleted", squadName: null }
    render(<SquadContextPanel sessionId="s1" />)
    expect(screen.getByTestId("squad-panel-missing")).toBeInTheDocument()
  })

  it("lists the bound Squad's members, name-sorted", () => {
    executorState.current = { ...executorState.current, squadId: "sq-1", squadName: "Research" }
    seed([
      member({ id: "b", name: "Bravo" }),
      member({ id: "a", name: "Alpha" }),
      // A member of a DIFFERENT Squad must not leak in.
      member({ id: "x", name: "Zulu", teamId: "sq-2" }),
    ])
    render(<SquadContextPanel sessionId="s1" />)
    const rows = screen.getAllByTestId("squad-panel-member")
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Bravo"),
    ])
  })

  it("counts only the members that are working right now", () => {
    executorState.current = { ...executorState.current, squadId: "sq-1", squadName: "Research" }
    seed([
      member({ id: "a", name: "A", status: "executing" }),
      member({ id: "b", name: "B", status: "planning" }),
      member({ id: "c", name: "C", status: "completed" }),
      member({ id: "d", name: "D", status: "idle" }),
    ])
    render(<SquadContextPanel sessionId="s1" />)
    expect(screen.getByTestId("squad-panel")).toHaveTextContent("2 working")
  })

  it("says the Squad is idle rather than showing a bare zero", () => {
    executorState.current = { ...executorState.current, squadId: "sq-1", squadName: "Research" }
    seed([member({ status: "completed" })])
    render(<SquadContextPanel sessionId="s1" />)
    expect(screen.getByTestId("squad-panel")).toHaveTextContent("Idle")
  })

  it("marks the panel when the run is blocked on the user", () => {
    // Otherwise the panel looks idle while the run is actually waiting.
    executorState.current = { ...executorState.current, squadId: "sq-1", squadName: "Research" }
    seed([member()])
    usePendingGatesStore.setState({
      gates: [
        {
          key: { scope: "agent-team-budget", id: "run-1" },
          gateType: "budget",
          title: "Budget",
          teamId: "sq-1",
          openedAt: 1,
          status: "open",
        },
        // A gate for another Squad must not show here.
        {
          key: { scope: "agent-team-budget", id: "run-2" },
          gateType: "budget",
          title: "Other",
          teamId: "sq-2",
          openedAt: 1,
          status: "open",
        },
      ] as never,
    })
    render(<SquadContextPanel sessionId="s1" />)
    expect(screen.getByTestId("squad-panel-gates")).toHaveTextContent(/waiting on your decision/i)
  })

  it("says a Squad has no members rather than rendering an empty list", () => {
    executorState.current = { ...executorState.current, squadId: "sq-1", squadName: "Research" }
    render(<SquadContextPanel sessionId="s1" />)
    expect(screen.getByTestId("squad-panel-no-members")).toBeInTheDocument()
  })

  it("translates every teammate status, including the two the old panel lacked", () => {
    // `awaiting_approval` and `shutdown` were missing from `agentTeam.status`,
    // and StatusBadge falls back to the raw enum when a key is absent.
    executorState.current = { ...executorState.current, squadId: "sq-1", squadName: "Research" }
    seed([
      member({ id: "a", name: "A", status: "awaiting_approval" }),
      member({ id: "b", name: "B", status: "shutdown" }),
    ])
    render(<SquadContextPanel sessionId="s1" />)
    const panel = screen.getByTestId("squad-panel")
    expect(panel).toHaveTextContent("Awaiting approval")
    expect(panel).toHaveTextContent("Shut down")
    expect(panel).not.toHaveTextContent("awaiting_approval")
  })
})
