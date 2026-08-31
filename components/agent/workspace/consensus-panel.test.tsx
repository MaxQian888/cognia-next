/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { ConsensusRequest } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const castVoteMock = jest.fn()
const cancelConsensusMock = jest.fn()
const resolveConsensusMock = jest.fn()
jest.mock("@/lib/ai/agent/team/consensus-orchestrator", () => ({
  castVote: (...args: unknown[]) => castVoteMock(...args),
  cancelConsensus: (...args: unknown[]) => cancelConsensusMock(...args),
  resolveConsensus: (...args: unknown[]) => resolveConsensusMock(...args),
}))

let mockConsensus: ConsensusRequest[] = []
let mockTeammateId: string | null = "v1"

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({
      consensus: {},
      teams: {},
      activeTeamId: null,
      selectedTeammateId: mockTeammateId,
    }),
}))

let namedTeamIds: (string | undefined)[] = []
jest.mock("@/stores/agent/agent-team-store/selectors", () => ({
  selectActiveTeamConsensus: () => mockConsensus,
  // Records what the panel asked for, so a test can prove it named its team
  // rather than falling back to whatever the store last selected.
  selectTeamConsensus: (_state: unknown, teamId: string | undefined) => {
    namedTeamIds.push(teamId)
    return mockConsensus
  },
  selectSelectedTeammateId: () => mockTeammateId,
}))

import { ConsensusPanel } from "./consensus-panel"

function makeConsensus(overrides: Partial<ConsensusRequest> = {}): ConsensusRequest {
  return {
    id: "c1",
    teamId: "team-1",
    initiatorId: "lead",
    question: "Pick a color",
    options: ["red", "blue"],
    type: "majority",
    status: "open",
    votes: [],
    createdAt: new Date("2026-01-01"),
    ...overrides,
  }
}

describe("ConsensusPanel", () => {
  beforeEach(() => {
    castVoteMock.mockReset()
    cancelConsensusMock.mockReset()
    resolveConsensusMock.mockReset()
    mockConsensus = []
    mockTeammateId = "v1"
  })

  it("shows the empty hint when there are no consensus rows", () => {
    render(<ConsensusPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders an open consensus with vote buttons enabled when a teammate is selected", () => {
    mockConsensus = [makeConsensus()]
    render(<ConsensusPanel />)
    expect(screen.getByText("Pick a color")).toBeInTheDocument()
    const voteButtons = screen.getAllByText("vote")
    expect(voteButtons).toHaveLength(2)
    fireEvent.click(voteButtons[0])
    expect(castVoteMock).toHaveBeenCalledWith({
      consensusId: "c1",
      voterId: "v1",
      optionIndex: 0,
    })
  })

  it("disables vote buttons when no teammate is selected", () => {
    mockConsensus = [makeConsensus()]
    mockTeammateId = null
    render(<ConsensusPanel />)
    for (const btn of screen.getAllByText("vote")) {
      expect(btn.closest("button")).toBeDisabled()
    }
  })

  it("shows the forceResolve button only for lead_override consensus", () => {
    mockConsensus = [makeConsensus({ type: "lead_override" })]
    render(<ConsensusPanel />)
    expect(screen.getByText("forceResolve")).toBeInTheDocument()
  })

  it("hides vote / cancel / forceResolve once the consensus is resolved", () => {
    mockConsensus = [makeConsensus({ status: "resolved", winningOption: 0, summary: "done" })]
    render(<ConsensusPanel />)
    expect(screen.queryByText("vote")).not.toBeInTheDocument()
    expect(screen.queryByText("cancel")).not.toBeInTheDocument()
    expect(screen.getByText("done")).toBeInTheDocument()
  })
})

/**
 * The `selectActiveTeam*` family reads whatever the store last selected, which
 * is right inside a workspace the user navigated into and wrong in the run
 * cockpit, which shows one run at a time and never selects a team. A panel
 * dropped there without a team would render the retired workspace's last
 * selection.
 */
describe("ConsensusPanel team scoping", () => {
  beforeEach(() => {
    namedTeamIds = []
    mockConsensus = [makeConsensus()]
  })

  it("reads the named team when given one", () => {
    render(<ConsensusPanel teamId="team-42" />)
    expect(namedTeamIds).toEqual(["team-42"])
  })

  it("falls back to the store's selection when no team is named", () => {
    render(<ConsensusPanel />)
    expect(namedTeamIds).toEqual([])
  })
})
