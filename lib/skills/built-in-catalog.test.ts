import {
  BUILT_IN_SKILL_CATALOG,
  builtinSkillId,
  getCatalogSkill,
  BUILTIN_SKILL_ID_PREFIX,
} from "./built-in-catalog"

describe("built-in skills catalog", () => {
  it("ships the expected functional skills", () => {
    const ids = BUILT_IN_SKILL_CATALOG.map((e) => e.id).sort()
    expect(ids).toEqual([
      "agent-team-delegation",
      "computer-use-safety",
      "digital-twin-query",
      "goal-loop-execution",
      "im-auto-reply",
      "ocr-extraction",
      "plugin-authoring",
      "plugin-conversion",
      "web-research",
      "workflow-authoring",
    ])
  })

  it("registers plugin authoring as an opt-in skill with its required tools", () => {
    const entry = getCatalogSkill("plugin-authoring")!
    expect(entry.allowedTools).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "Bash"])
    expect(entry.surface).toEqual([])
    expect(entry.content).toContain("cognia plugin contract")
    expect(entry.content).toContain("--point <id>")
    expect(entry.content).toContain("--point-kind <kind>")
    expect(entry.content).toContain("--permission <permission>")
    expect(entry.content).toContain("formFactor")
    expect(entry.content).toContain("deprecated")
    expect(entry.content).toContain("plugin-owned i18n")
    expect(entry.content).toContain("shared React")
    expect(entry.content).toContain("vscode-extension")
    expect(entry.content).toContain("wasm")
    expect(entry.content).toContain("support=experimental")
    expect(entry.content).toContain("cognia plugin sync-types")
    expect(entry.content).toContain("scaffolded public `cognia` module")
    expect(entry.content).toContain("only when the user explicitly requests")
  })

  it("every entry has a name, non-empty body, and a surface array", () => {
    for (const e of BUILT_IN_SKILL_CATALOG) {
      expect(e.name.trim().length).toBeGreaterThan(0)
      expect(e.content.trim().length).toBeGreaterThan(0)
      expect(Array.isArray(e.surface)).toBe(true)
    }
  })

  it("builtinSkillId underscores the bundle id under the legacy prefix", () => {
    const entry = getCatalogSkill("im-auto-reply")!
    expect(builtinSkillId(entry)).toBe(`${BUILTIN_SKILL_ID_PREFIX}im_auto_reply`)
  })

  it("getCatalogSkill returns undefined for an unknown id", () => {
    expect(getCatalogSkill("does-not-exist")).toBeUndefined()
  })
})
