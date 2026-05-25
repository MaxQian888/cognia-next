import { WRITING_CREW_TEMPLATE } from "./template"
import { ROLE_PACK_ID, packSkillId } from "../ids"

describe("WRITING_CREW_TEMPLATE", () => {
  const t = WRITING_CREW_TEMPLATE

  it("is a 3-member research team with a stable id", () => {
    expect(t.id).toBe("zhihu-writing-crew")
    expect(t.category).toBe("research")
    expect(t.teammates).toHaveLength(3)
  })

  it("gives every teammate a system prompt and a plugin-skill overlay", () => {
    for (const m of t.teammates) {
      expect(m.systemPrompt?.length ?? 0).toBeGreaterThan(40)
      const added = m.capabilities?.skillIds?.add ?? []
      expect(added.length).toBeGreaterThan(0)
      for (const id of added) expect(id.startsWith("zhihu-content-pipeline:")).toBe(true)
    }
  })

  it("attaches the writer's zhihu-answer-writer and the polisher's two skills", () => {
    const writer = t.teammates[1]
    const polisher = t.teammates[2]
    expect(writer.capabilities?.skillIds?.add).toContain(packSkillId("zhihu-answer-writer"))
    expect(polisher.capabilities?.skillIds?.add).toEqual(
      expect.arrayContaining([packSkillId("de-ai-humanizer"), packSkillId("zhihu-illustration")])
    )
  })

  it("has one task per teammate with valid assignment indices", () => {
    expect(t.taskTemplates).toHaveLength(3)
    for (const task of t.taskTemplates ?? []) {
      expect(task.assignedToIndex).toBeGreaterThanOrEqual(0)
      expect(task.assignedToIndex).toBeLessThan(t.teammates.length)
    }
  })

  it("requires the role pack and the four backing skills", () => {
    expect(t.requires?.characterPackIds).toEqual([ROLE_PACK_ID])
    expect(t.requires?.skillIds).toEqual(
      expect.arrayContaining([
        packSkillId("deep-research"),
        packSkillId("zhihu-answer-writer"),
        packSkillId("de-ai-humanizer"),
        packSkillId("zhihu-illustration"),
      ])
    )
  })
})
