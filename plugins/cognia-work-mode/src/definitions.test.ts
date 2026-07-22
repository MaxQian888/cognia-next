import { WORK_MODE } from "./mode"
import { WORK_SKILLS } from "./skills"
import { WORK_SUBAGENTS } from "./subagents"
import { KNOWLEDGE_WORK_TEAM } from "./team"

describe("cognia-work-mode contributions", () => {
  it("defines a selectable Work mode without narrowing the host tool surface", () => {
    expect(WORK_MODE).toMatchObject({
      id: "work",
      name: "Work",
      outputFormat: "markdown",
    })
    expect(WORK_MODE.tools).toBeUndefined()
    expect(WORK_MODE.systemPrompt).toContain("finished deliverable")
    expect(WORK_MODE.systemPrompt).toContain("review criteria")
    expect(WORK_MODE.systemPrompt).toContain("work_create_deliverable")
  })

  it("bundles portable skills for research and the major knowledge-work outputs", () => {
    expect(WORK_SKILLS.map((skill) => skill.id)).toEqual([
      "cognia-work-mode:source-grounded-research",
      "cognia-work-mode:document-deliverable",
      "cognia-work-mode:spreadsheet-deliverable",
      "cognia-work-mode:presentation-deliverable",
      "cognia-work-mode:deliverable-qa",
    ])
    for (const skill of WORK_SKILLS) {
      expect(skill.source.kind).toBe("inline")
      if (skill.source.kind === "inline") {
        expect(skill.source.markdown).toMatch(/^---\nname:/)
      }
    }
  })

  it("ships bounded specialist roles and a review-gated team template", () => {
    expect(WORK_SUBAGENTS.map((agent) => agent.id)).toEqual([
      "researcher",
      "analyst",
      "deliverable-reviewer",
    ])
    expect(WORK_SUBAGENTS.every((agent) => agent.maxTurns && agent.maxTurns <= 12)).toBe(true)
    expect(WORK_SUBAGENTS.find((agent) => agent.id === "researcher")?.tools).toEqual([
      "WebSearch",
      "WebFetch",
    ])
    expect(WORK_SUBAGENTS.find((agent) => agent.id === "analyst")?.tools).toEqual([])
    expect(WORK_SUBAGENTS.find((agent) => agent.id === "deliverable-reviewer")?.tools).toEqual([])
    expect(KNOWLEDGE_WORK_TEAM.teammates).toHaveLength(4)
    expect(KNOWLEDGE_WORK_TEAM.taskTemplates?.at(-1)?.title).toMatch(/review/i)
    expect(KNOWLEDGE_WORK_TEAM.config?.governancePolicy?.approval.requirePlanApproval).toBe(true)
    expect(KNOWLEDGE_WORK_TEAM.requires?.subagentIds).toEqual(
      expect.arrayContaining([
        "cognia-work-mode:researcher",
        "cognia-work-mode:analyst",
        "cognia-work-mode:deliverable-reviewer",
      ])
    )
  })
})
