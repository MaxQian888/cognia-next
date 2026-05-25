import { REFACTOR_SKILLS } from "./definitions"
import { REFACTOR_ROLE_PACK } from "../characters/pack"
import { PLUGIN_ID } from "../ids"

describe("REFACTOR_SKILLS", () => {
  it("ships five self-namespaced inline skills", () => {
    expect(REFACTOR_SKILLS).toHaveLength(5)
    for (const skill of REFACTOR_SKILLS) {
      expect(skill.id.startsWith(`${PLUGIN_ID}:`)).toBe(true)
      expect(skill.scope).toBe("character")
      expect(skill.source.kind).toBe("inline")
      if (skill.source.kind === "inline") {
        expect(skill.source.markdown.length).toBeGreaterThan(80)
        expect(skill.source.markdown).toMatch(/^# /m)
      }
      expect(skill.name.length).toBeGreaterThan(0)
      expect(skill.description.length).toBeGreaterThan(0)
    }
  })

  it("has unique ids", () => {
    const ids = REFACTOR_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("provides every skill the role pack references via pluginSkillIds", () => {
    const provided = new Set(REFACTOR_SKILLS.map((s) => s.id))
    for (const id of REFACTOR_ROLE_PACK.requires?.pluginSkillIds ?? []) {
      expect(provided.has(id)).toBe(true)
    }
    for (const ch of REFACTOR_ROLE_PACK.characters) {
      for (const id of ch.pluginSkillIds ?? []) {
        expect(provided.has(id)).toBe(true)
      }
    }
  })
})
