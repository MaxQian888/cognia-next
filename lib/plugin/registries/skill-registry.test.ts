import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import {
  __resetSkillsForTesting,
  getSkill,
  getSkillEntry,
  listSkillEntries,
  listSkillIds,
  registerSkill,
  unregisterSkillById,
  unregisterSkillsByPlugin,
} from "./skill-registry"

function makeSkill(id: string, overrides: Partial<PluginSkillDef> = {}): PluginSkillDef {
  return {
    id,
    name: `Skill ${id}`,
    description: `Test skill ${id}`,
    source: { kind: "local-folder", path: `/tmp/skills/${id}` },
    ...overrides,
  }
}

describe("skill-registry", () => {
  beforeEach(() => {
    __resetSkillsForTesting()
  })

  it("registers a skill and retrieves it via get / getEntry / list", () => {
    const skill = makeSkill("code-review")
    const previous = registerSkill("code-review", skill, { pluginId: "p1" })
    expect(previous).toBeUndefined()

    expect(getSkill("code-review")).toBe(skill)
    expect(getSkillEntry("code-review")).toEqual({
      entry: skill,
      pluginId: "p1",
    })
    expect(listSkillIds()).toEqual(["code-review"])
    expect(listSkillEntries()).toEqual([{ id: "code-review", entry: skill, pluginId: "p1" }])
  })

  it("unregisterByPlugin drops every skill from the given pluginId", () => {
    registerSkill("a", makeSkill("a"), { pluginId: "plug" })
    registerSkill("b", makeSkill("b"), { pluginId: "plug" })

    const removed = unregisterSkillsByPlugin("plug")
    expect(removed).toBe(2)
    expect(getSkill("a")).toBeUndefined()
    expect(getSkill("b")).toBeUndefined()
    expect(listSkillIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    const a = makeSkill("a")
    const b = makeSkill("b")
    registerSkill("a", a, { pluginId: "pluginA" })
    registerSkill("b", b, { pluginId: "pluginB" })

    const removed = unregisterSkillsByPlugin("pluginA")
    expect(removed).toBe(1)
    expect(getSkill("a")).toBeUndefined()
    expect(getSkill("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerSkill("a", makeSkill("a"))
    registerSkill("b", makeSkill("b"))

    expect(unregisterSkillById("a")).toBe(true)
    expect(getSkill("a")).toBeUndefined()
    expect(getSkill("b")).toBeDefined()

    // Second call for a now-missing id reports false.
    expect(unregisterSkillById("a")).toBe(false)
  })

  it("supports the discriminated source union (local-folder / anthropic-managed / inline)", () => {
    const local = makeSkill("local", {
      source: { kind: "local-folder", path: "/tmp/skills/local" },
    })
    const managed = makeSkill("managed", {
      source: {
        kind: "anthropic-managed",
        containerSkillId: "container-1",
        version: "1.0.0",
      },
    })
    const inline = makeSkill("inline", {
      source: { kind: "inline", markdown: "# Hi" },
    })

    registerSkill("local", local)
    registerSkill("managed", managed)
    registerSkill("inline", inline)

    expect(getSkill("local")?.source.kind).toBe("local-folder")
    expect(getSkill("managed")?.source.kind).toBe("anthropic-managed")
    expect(getSkill("inline")?.source.kind).toBe("inline")
  })

  it("__resetSkillsForTesting clears everything", () => {
    registerSkill("a", makeSkill("a"), { pluginId: "p1" })
    registerSkill("b", makeSkill("b"), { pluginId: "p2" })
    registerSkill("c", makeSkill("c")) // anonymous

    __resetSkillsForTesting()

    expect(listSkillIds()).toEqual([])
    expect(listSkillEntries()).toEqual([])
  })
})

// ── W4.2: cross-plugin id hijack is rejected (first-wins) ────────────────────
describe("first-wins-cross-plugin (W4.2)", () => {
  it("keeps the incumbent plugin's skill and survives the loser's cleanup", () => {
    const mkSkill = (name: string) =>
      ({ id: "shared-id", name, description: "d", content: "c" }) as never
    registerSkill("shared-id", mkSkill("A"), { pluginId: "plugin-a" })
    registerSkill("shared-id", mkSkill("B"), { pluginId: "plugin-b" })

    expect(getSkillEntry("shared-id")?.pluginId).toBe("plugin-a")

    // Unregistering the rejected plugin must not drop the winner's entry.
    expect(unregisterSkillsByPlugin("plugin-b")).toBe(0)
    expect(getSkillEntry("shared-id")?.pluginId).toBe("plugin-a")
    unregisterSkillsByPlugin("plugin-a")
  })
})
