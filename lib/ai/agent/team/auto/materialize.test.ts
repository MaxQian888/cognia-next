import { materializeProposal } from "./materialize"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AutoOrchestrationProposal } from "./types"
import type { TeamRoutingAssessment } from "@/types/agent/agent-team"

const assessment: TeamRoutingAssessment = {
  recommendedPattern: "parallel_specialists",
  confidence: 0.8,
  reason: "Independent angles benefit from specialists.",
  factors: {
    taskComplexity: "moderate",
    specializationNeeded: true,
    contextIsolationNeeded: false,
    delegationCandidate: false,
    budgetPressure: "low",
  },
  createdAt: new Date("2026-06-14T00:00:00Z"),
}

const proposal: AutoOrchestrationProposal = {
  objective: "Review the billing module",
  assessment,
  roster: [
    {
      name: "Coordinator",
      role: "lead",
      description: "Coordinates",
      specialization: "coordination",
      capabilities: { skillIds: { add: ["web-research"] } },
    },
    { name: "Bug Hunter", role: "teammate", description: "Finds bugs", specialization: "bugs" },
    { name: "Doc Writer", role: "teammate", description: "Writes docs", specialization: "docs" },
  ],
  tasks: [
    {
      title: "Scan",
      description: "scan code",
      assignedTo: 1,
      dependencies: [],
      expectedOutput: "list",
    },
    { title: "Document", description: "write docs", assignedTo: 2, dependencies: [0] },
  ],
}

beforeEach(() => {
  useAgentTeamStore.setState({ teams: {}, teammates: {}, tasks: {}, activeTeamId: null })
})

describe("materializeProposal", () => {
  it("creates a team with the lead reusing roster[0] and adds the rest", () => {
    const result = materializeProposal(proposal)
    const state = useAgentTeamStore.getState()
    const team = state.teams[result.teamId]

    expect(team).toBeDefined()
    expect(result.teammateIds).toHaveLength(3)
    expect(result.teammateIds[0]).toBe(team.leadId)

    const lead = state.teammates[team.leadId]
    expect(lead.name).toBe("Coordinator")
    expect(lead.role).toBe("lead")
    expect(lead.specialization).toBe("coordination")
    expect(lead.config.capabilities?.skillIds?.add).toEqual(["web-research"])

    const hunter = state.teammates[result.teammateIds[1]]
    expect(hunter.name).toBe("Bug Hunter")
    expect(hunter.role).toBe("teammate")
    expect(hunter.config.specialization).toBe("bugs")
  })

  it("maps task assignedTo / dependency indices onto real store ids", () => {
    const result = materializeProposal(proposal)
    const state = useAgentTeamStore.getState()

    const scan = state.tasks[result.taskIds[0]]
    const doc = state.tasks[result.taskIds[1]]
    expect(scan.assignedTo).toBe(result.teammateIds[1])
    expect(scan.expectedOutput).toBe("list")
    expect(doc.assignedTo).toBe(result.teammateIds[2])
    expect(doc.dependencies).toEqual([result.taskIds[0]])
  })

  it("stamps the routing assessment + selected pattern onto the team", () => {
    const result = materializeProposal(proposal)
    const team = useAgentTeamStore.getState().teams[result.teamId]
    expect(team.routingAssessment).toEqual(assessment)
    expect(team.selectedExecutionPattern).toBe("parallel_specialists")
    expect(team.config.preferredExecutionPattern).toBe("parallel_specialists")
  })

  it("uses the provided name, falling back to the objective", () => {
    const named = materializeProposal(proposal, { name: "Billing Review" })
    expect(useAgentTeamStore.getState().teams[named.teamId].name).toBe("Billing Review")

    const unnamed = materializeProposal(proposal)
    expect(useAgentTeamStore.getState().teams[unnamed.teamId].name).toBe(
      "Review the billing module"
    )
  })

  it("falls back to 'Auto team' when objective and name are both empty", () => {
    const blank: AutoOrchestrationProposal = {
      ...proposal,
      objective: "",
      roster: [{ name: "Lead", role: "lead", description: "l" }],
      tasks: [],
    }
    const result = materializeProposal(blank)
    expect(useAgentTeamStore.getState().teams[result.teamId].name).toBe("Auto team")
  })

  it("adds a plain teammate with no specialization or capabilities", () => {
    const plain: AutoOrchestrationProposal = {
      ...proposal,
      roster: [
        { name: "Lead", role: "lead", description: "l" },
        { name: "Plain", role: "teammate", description: "p" },
      ],
      tasks: [],
    }
    const result = materializeProposal(plain)
    const plainMate = useAgentTeamStore.getState().teammates[result.teammateIds[1]]
    expect(plainMate.config).toEqual({})
    expect(plainMate.specialization).toBeUndefined()
  })

  it("drops a dependency index that resolves to no task", () => {
    const dangling: AutoOrchestrationProposal = {
      ...proposal,
      tasks: [{ title: "Only", description: "x", assignedTo: 0, dependencies: [99] }],
    }
    const result = materializeProposal(dangling)
    expect(useAgentTeamStore.getState().tasks[result.taskIds[0]].dependencies).toEqual([])
  })

  it("handles a lead-only roster", () => {
    const solo: AutoOrchestrationProposal = {
      ...proposal,
      roster: [{ name: "Solo", role: "lead", description: "alone" }],
      tasks: [{ title: "Do it", description: "the work", assignedTo: 0, dependencies: [] }],
    }
    const result = materializeProposal(solo)
    const state = useAgentTeamStore.getState()
    expect(result.teammateIds).toHaveLength(1)
    expect(state.tasks[result.taskIds[0]].assignedTo).toBe(result.leadId)
  })
})
