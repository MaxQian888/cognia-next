import { renderProposalDoc } from "./preview-doc"
import type { AutoOrchestrationProposal } from "./types"
import type { TeamRoutingAssessment } from "@/types/agent/agent-team"

const assessment: TeamRoutingAssessment = {
  recommendedPattern: "ultracode_orchestration",
  confidence: 0.85,
  reason: "Complex audit benefits from find→verify→synthesize.",
  factors: {
    taskComplexity: "complex",
    specializationNeeded: true,
    contextIsolationNeeded: true,
    delegationCandidate: false,
    budgetPressure: "medium",
  },
  createdAt: new Date("2026-06-14T00:00:00Z"),
}

const proposal: AutoOrchestrationProposal = {
  objective: "Audit the auth layer",
  assessment,
  roster: [
    { name: "Lead", role: "lead", description: "Coordinates" },
    {
      name: "Security",
      role: "teammate",
      description: "Reviews security",
      specialization: "security",
      capabilities: {
        skillIds: { add: ["web-research"] },
        subagentIds: { add: ["workflow-debugger"] },
      },
    },
  ],
  tasks: [
    { title: "Find issues", description: "scan auth", assignedTo: 1, dependencies: [] },
    {
      title: "Synthesize",
      description: "write report",
      assignedTo: 0,
      dependencies: [0],
      expectedOutput: "report",
    },
  ],
}

describe("renderProposalDoc", () => {
  it("renders objective, assessment, roster and tasks", () => {
    const doc = renderProposalDoc(proposal)
    expect(doc).toContain("# Auto-composed team")
    expect(doc).toContain("Audit the auth layer")
    expect(doc).toContain("Ultracode orchestration")
    expect(doc).toContain("85%")
    expect(doc).toContain("complex")
    expect(doc).toContain("## Roster (2)")
    expect(doc).toContain("## Tasks (2)")
  })

  it("marks the lead with a crown and shows specialization", () => {
    const doc = renderProposalDoc(proposal)
    expect(doc).toMatch(/\*\*Lead\*\* 👑/)
    expect(doc).toContain("_(security)_")
  })

  it("summarizes capability overlay ids", () => {
    const doc = renderProposalDoc(proposal)
    expect(doc).toContain("caps: web-research, workflow-debugger")
  })

  it("renders task assignees, dependencies and expected output", () => {
    const doc = renderProposalDoc(proposal)
    expect(doc).toContain("**Find issues** → Security")
    expect(doc).toContain("**Synthesize** → Lead · after #0")
    expect(doc).toContain("_Expected:_ report")
  })

  it("omits the dependency / caps suffixes when there are none", () => {
    const doc = renderProposalDoc({
      ...proposal,
      roster: [{ name: "Solo", role: "lead", description: "alone" }],
      tasks: [{ title: "Work", description: "do it", assignedTo: 0, dependencies: [] }],
    })
    expect(doc).not.toContain("after #")
    expect(doc).not.toContain("caps:")
  })

  it("omits the caps suffix for empty overlay buckets and the spec when none", () => {
    const doc = renderProposalDoc({
      ...proposal,
      roster: [
        { name: "Lead", role: "lead", description: "Coordinates" },
        {
          name: "Generalist",
          role: "teammate",
          description: "no spec, empty caps",
          capabilities: { skillIds: {} },
        },
      ],
      tasks: [{ title: "Work", description: "do it", assignedTo: 1, dependencies: [] }],
    })
    expect(doc).not.toContain("caps:")
    expect(doc).not.toContain("_(")
  })

  it("renders an assignee fallback when the index is out of range", () => {
    const doc = renderProposalDoc({
      ...proposal,
      roster: [{ name: "Lead", role: "lead", description: "l" }],
      tasks: [{ title: "Orphan", description: "x", assignedTo: 7, dependencies: [] }],
    })
    expect(doc).toContain("**Orphan** → #7")
  })
})
