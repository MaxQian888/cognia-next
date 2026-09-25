import { act, renderHook } from "@testing-library/react"

import { registerSkill, unregisterSkillsByPlugin } from "@/lib/plugin/registries/skill-registry"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

import { selectPluginSkills, usePluginSkills, usePluginSkillsById } from "./use-plugin-skills"

const skill = (id: string, name: string, scope?: PluginSkillDef["scope"]): PluginSkillDef => ({
  id,
  name,
  description: `${name} description`,
  source: { kind: "inline", markdown: "# body" },
  ...(scope ? { scope } : {}),
})

afterEach(() => {
  unregisterSkillsByPlugin("acme")
})

describe("selectPluginSkills", () => {
  const entries = [
    { id: "acme:review", entry: skill("acme:review", "Review"), pluginId: "acme" },
    { id: "acme:global", entry: skill("acme:global", "Anywhere", "global"), pluginId: "acme" },
    { id: "acme:persona", entry: skill("acme:persona", "Persona", "character"), pluginId: "acme" },
    { id: "acme:squad", entry: skill("acme:squad", "Squad", "team"), pluginId: "acme" },
  ]

  it("offers unscoped and global skills in the composer, sorted by name", () => {
    expect(selectPluginSkills(entries, "session").map((s) => s.id)).toEqual([
      "acme:global",
      "acme:review",
    ])
  })

  it("adds character-scoped skills only to the character picker", () => {
    expect(selectPluginSkills(entries, "character").map((s) => s.id)).toEqual([
      "acme:global",
      "acme:persona",
      "acme:review",
    ])
    expect(selectPluginSkills(entries, "team").map((s) => s.id)).toContain("acme:squad")
  })
})

describe("usePluginSkills", () => {
  it("follows plugins registering and unregistering skills", () => {
    const { result } = renderHook(() => usePluginSkills("session"))
    expect(result.current).toEqual([])

    act(() => {
      registerSkill("acme:review", skill("acme:review", "Review"), { pluginId: "acme" })
    })
    expect(result.current).toEqual([
      { id: "acme:review", name: "Review", description: "Review description", pluginId: "acme" },
    ])

    act(() => {
      unregisterSkillsByPlugin("acme")
    })
    expect(result.current).toEqual([])
  })

  it("reads nothing while the picker is closed", () => {
    registerSkill("acme:review", skill("acme:review", "Review"), { pluginId: "acme" })
    const { result } = renderHook(() => usePluginSkills("session", false))
    expect(result.current).toEqual([])
  })

  it("looks up any registered skill by id for chips", () => {
    registerSkill("acme:persona", skill("acme:persona", "Persona", "character"), {
      pluginId: "acme",
    })
    const { result } = renderHook(() => usePluginSkillsById())
    expect(result.current.get("acme:persona")?.name).toBe("Persona")
  })
})
