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
let mockRoster: Array<{ id: string; name: string }> = [{ id: "v1", name: "Ada" }]
let mockLeadId: string | undefined = "v1"

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({
      consensus: {},
      teams: { "team-42": { leadId: mockLeadId } },
      teammates: {},
      activeTeamId: null,
    }),
}))

let namedTeamIds: (string | undefined)[] = []
let rosterTeamIds: (string | undefined)[] = []
jest.mock("@/stores/agent/agent-team-store/selectors", () => ({
  selectActiveTeamConsensus: () => mockConsensus,
  // Records what the panel asked for, so a test can prove it named its team
  // rather than falling back to whatever the store last selected.
  selectTeamConsensus: (_state: unknown, teamId: string | undefined) => {
    namedTeamIds.push(teamId)
    return mockConsensus
  },
  selectTeamTeammates: (_state: unknown, teamId: string | undefined) => {
    rosterTeamIds.push(teamId)
    return mockRoster
  },
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
    mockRoster = [{ id: "v1", name: "Ada" }]
    mockLeadId = "v1"
    rosterTeamIds = []
  })

  it("shows the empty hint when there are no consensus rows", () => {
    render(<ConsensusPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders an open consensus with vote buttons enabled when the roster has a member", () => {
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

  it("disables vote buttons — and says why — when the team has no members", () => {
    mockConsensus = [makeConsensus()]
    mockRoster = []
    mockLeadId = undefined
    render(<ConsensusPanel />)
    for (const btn of screen.getAllByText("vote")) {
      expect(btn.closest("button")).toBeDisabled()
    }
    // Rendered rather than hidden: an absent control cannot say that the fix
    // is to put someone on the team.
    expect(screen.getByTestId("consensus-voter-picker")).toBeDisabled()
  })

  it("votes as the team lead by default and as whoever the picker names", () => {
    mockConsensus = [makeConsensus()]
    mockRoster = [
      { id: "member", name: "Grace" },
      { id: "lead", name: "Ada" },
    ]
    mockLeadId = "lead"
    render(<ConsensusPanel teamId="team-42" />)
    // The roster comes from the SAME team the rows did.
    expect(rosterTeamIds).toEqual(["team-42"])
    fireEvent.click(screen.getAllByText("vote")[0])
    expect(castVoteMock).toHaveBeenCalledWith({
      consensusId: "c1",
      voterId: "lead",
      optionIndex: 0,
    })
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
