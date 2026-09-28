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
    // Native deliverables are edited and read with their owner's tools.
    for (const tool of [
      "office_apply_operations",
      "office_read_range",
      "documents_apply_operations",
      "documents_read_markdown",
    ])
      expect(WORK_MODE.systemPrompt).toContain(tool)
  })

  it("points the document and spreadsheet skills at their owners' edit and export tools", () => {
    const markdown = (id: string) => {
      const skill = WORK_SKILLS.find((candidate) => candidate.id === `cognia-work-mode:${id}`)!
      return skill.source.kind === "inline" ? skill.source.markdown : ""
    }
    expect(markdown("document-deliverable")).toContain('format "docx"')
    expect(markdown("document-deliverable")).toContain("documents_apply_operations")
    expect(markdown("document-deliverable")).toContain("documents_export_docx")
    expect(markdown("spreadsheet-deliverable")).toContain("office_apply_operations")
    expect(markdown("spreadsheet-deliverable")).toContain("office_read_range")
    expect(markdown("spreadsheet-deliverable")).toContain("office_export_xlsx")
    expect(WORK_MODE.systemPrompt).toContain("office_export_xlsx")
    expect(WORK_MODE.systemPrompt).toContain("documents_export_docx")
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
