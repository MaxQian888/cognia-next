import { SKILL_TEMPLATES, templateToSkillSeed } from "./templates"

describe("SKILL_TEMPLATES", () => {
  it("ships a non-empty catalog with unique ids", () => {
    expect(SKILL_TEMPLATES.length).toBeGreaterThan(0)
    const ids = SKILL_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every template has a name, body, and category", () => {
    for (const t of SKILL_TEMPLATES) {
      expect(t.name).toBeTruthy()
      expect(t.content).toBeTruthy()
      expect(t.category).toBeTruthy()
    }
  })
})

describe("templateToSkillSeed", () => {
  it("maps content fields and marks the source custom/enabled", () => {
    const tpl = SKILL_TEMPLATES.find((t) => t.id === "code-review")!
    const seed = templateToSkillSeed(tpl)
    expect(seed.name).toBe(tpl.name)
    expect(seed.content).toBe(tpl.content)
    expect(seed.category).toBe(tpl.category)
    expect(seed.tags).toEqual(tpl.tags)
    expect(seed.source).toBe("custom")
    expect(seed.status).toBe("enabled")
  })

  it("leaves the name blank for the blank template", () => {
    const blank = SKILL_TEMPLATES.find((t) => t.id === "blank")!
    expect(templateToSkillSeed(blank).name).toBe("")
  })
})
