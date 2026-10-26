import {
  alwaysOnText,
  componentOfPath,
  componentsToTree,
  diffTrees,
  findSkillResource,
  harnessInventory,
  isHarnessPath,
  normalizeHarnessPath,
  treeDiversity,
  treeToComponents,
  treesEqual,
  unifiedTreeDiff,
  type HarnessTree,
} from "./tree"
import { makeComponents, makeSkill } from "./test-fixtures"

describe("normalizeHarnessPath", () => {
  it("strips ./ and duplicate slashes", () => {
    expect(normalizeHarnessPath("./skills//a/SKILL.md")).toBe("skills/a/SKILL.md")
    expect(normalizeHarnessPath("skills\\a\\SKILL.md")).toBe("skills/a/SKILL.md")
  })

  it.each([["/etc/passwd"], ["../x"], ["skills/../../x"], ["C:/x"]])("refuses %s", (p) => {
    expect(() => normalizeHarnessPath(p)).toThrow(/escapes/)
  })
})

describe("componentOfPath", () => {
  it.each([
    ["systemprompt.md", "systemPrompt"],
    ["guardrails.md", "guardrails"],
    ["memory.md", "memory"],
    ["tool_guidance.md", "toolGuidance"],
    ["tool_rules.json", "toolRules"],
    ["skills/csv-report/SKILL.md", "skills"],
    ["skills/csv-report/references/notes.md", "skills"],
    ["skills/csv-report/scripts/run.py", "scripts"],
    ["sub_agents/checker/AGENT.md", "subagents"],
  ])("maps %s to %s", (path, component) => {
    expect(componentOfPath(path)).toBe(component)
  })

  it.each([
    ["notes.md"],
    ["skills/Bad Name/SKILL.md"],
    ["skills/a/other/x.md"],
    ["sub_agents/Bad/AGENT.md"],
    ["../systemprompt.md"],
  ])("rejects %s without throwing", (path) => {
    expect(componentOfPath(path)).toBeNull()
    expect(isHarnessPath(path)).toBe(false)
  })
})

describe("componentsToTree / treeToComponents", () => {
  it("round-trips a harness", () => {
    const components = makeComponents()
    const tree = componentsToTree(components)
    expect(Object.keys(tree).sort()).toEqual([
      "guardrails.md",
      "memory.md",
      "skills/csv-report/SKILL.md",
      "skills/csv-report/scripts/summarize.py",
      "sub_agents/checker/AGENT.md",
      "systemprompt.md",
      "tool_guidance.md",
      "tool_rules.json",
    ])
    const parsed = treeToComponents(tree, components)
    expect(parsed.errors).toEqual([])
    expect(parsed.rejectedPaths).toEqual([])
    expect(parsed.components.systemPrompt).toBe(components.systemPrompt)
    expect(parsed.components.skills[0]).toMatchObject({
      key: "csv-report",
      description: components.skills[0].description,
      resources: [{ path: "scripts/summarize.py", kind: "script" }],
    })
    expect(parsed.components.skills[0].content.trim()).toBe(components.skills[0].content.trim())
    expect(parsed.components.subagents).toEqual(components.subagents)
    expect(parsed.components.toolRules).toEqual(components.toolRules)
  })

  it("omits tool_rules.json when there are no rules", () => {
    expect(componentsToTree(makeComponents({ toolRules: [] }))).not.toHaveProperty(
      "tool_rules.json"
    )
  })

  it("reads a missing always-on file as empty and a deleted skill as removed", () => {
    const tree = componentsToTree(makeComponents())
    delete tree["memory.md"]
    delete tree["skills/csv-report/SKILL.md"]
    delete tree["skills/csv-report/scripts/summarize.py"]
    const parsed = treeToComponents(tree)
    expect(parsed.components.memory).toBe("")
    expect(parsed.components.skills).toEqual([])
    expect(parsed.errors).toEqual([])
  })

  it("collects off-surface and escaping paths instead of applying them", () => {
    const tree = { ...componentsToTree(makeComponents()), "notes.md": "x", "../evil": "y" }
    const parsed = treeToComponents(tree)
    expect(parsed.rejectedPaths).toEqual(["../evil", "notes.md"])
  })

  it("requires the frontmatter name to match the directory and a description", () => {
    const tree = componentsToTree(makeComponents({ subagents: [], toolRules: [] }))
    tree["skills/csv-report/SKILL.md"] = "---\nname: other\n---\nbody"
    const parsed = treeToComponents(tree)
    expect(parsed.errors.join("\n")).toMatch(/must equal the directory name/)
    expect(parsed.errors.join("\n")).toMatch(/non-empty `description:`/)
  })

  it("refuses execution settings on a subagent", () => {
    const tree = componentsToTree(makeComponents())
    tree["sub_agents/checker/AGENT.md"] =
      "---\nname: checker\ndescription: d\nmodel: opus\n---\nprompt body"
    const parsed = treeToComponents(tree)
    expect(parsed.errors.join("\n")).toMatch(/`model` is not editable/)
  })

  it("reports a helper whose skill is missing", () => {
    const parsed = treeToComponents({ "skills/ghost/scripts/run.sh": "echo hi" })
    expect(parsed.errors.join("\n")).toMatch(/has no skills\/ghost\/SKILL\.md/)
  })

  it("passes tool-rule errors through with the file name", () => {
    const parsed = treeToComponents({ "tool_rules.json": "{not json" })
    expect(parsed.errors[0]).toMatch(/^tool_rules\.json: not valid JSON/)
  })

  it("carries binary resources and source identity over from the previous harness", () => {
    const previous = makeComponents({
      skills: [
        makeSkill({
          sourceSkillId: "lib-1",
          sourceHash: "h1",
          resources: [
            ...makeSkill().resources,
            { path: "assets/logo.png", kind: "asset", content: "iVBORw0=", encoding: "base64" },
          ],
        }),
      ],
    })
    const tree = componentsToTree(previous)
    expect(tree).not.toHaveProperty("skills/csv-report/assets/logo.png")
    const parsed = treeToComponents(tree, previous)
    const skill = parsed.components.skills[0]
    expect(skill.sourceSkillId).toBe("lib-1")
    expect(skill.sourceHash).toBe("h1")
    expect(findSkillResource(skill, "assets/logo.png")?.encoding).toBe("base64")
  })
})

describe("tree comparison", () => {
  const before = componentsToTree(makeComponents())

  it("diffs at path level", () => {
    const after: HarnessTree = { ...before, "memory.md": "changed", "skills/new/SKILL.md": "x" }
    delete after["guardrails.md"]
    expect(diffTrees(before, after)).toEqual({
      added: ["skills/new/SKILL.md"],
      removed: ["guardrails.md"],
      modified: ["memory.md"],
    })
    expect(treesEqual(before, { ...before })).toBe(true)
    expect(treesEqual(before, after)).toBe(false)
  })

  it("renders a unified diff with context and elisions", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const a = { "memory.md": long }
    const b = { "memory.md": long.replace("line 10", "line ten") }
    const diff = unifiedTreeDiff(a, b)
    expect(diff).toContain("--- current/memory.md")
    expect(diff).toContain("+++ candidate/memory.md")
    expect(diff).toContain("-line 10")
    expect(diff).toContain("+line ten")
    expect(diff).toContain("@@ … @@")
    expect(diff).not.toContain(" line 1\n")
  })

  it("names added and removed files against /dev/null", () => {
    const diff = unifiedTreeDiff({}, { "memory.md": "x" })
    expect(diff).toContain("--- /dev/null")
    expect(unifiedTreeDiff({ "memory.md": "x" }, { "memory.md": "x" })).toBe("")
  })

  it("measures diversity", () => {
    const one = treeDiversity({ a: before, b: { ...before } })
    expect(one).toEqual({ n: 2, nDistinct: 1, meanLineJaccard: 1 })
    const two = treeDiversity({ a: { "memory.md": "x" }, b: { "memory.md": "y" } })
    expect(two.nDistinct).toBe(2)
    expect(two.meanLineJaccard).toBe(0)
    expect(treeDiversity({ a: before }).meanLineJaccard).toBe(1)
  })
})

describe("census", () => {
  it("joins always-on text and summarises the components", () => {
    const components = makeComponents()
    expect(alwaysOnText(components)).toContain(components.guardrails)
    expect(harnessInventory(components)).toMatch(
      /^1 skills, 1 scripts, 1 subagents, 1 tool rules; [\d,]+ always-on chars$/
    )
    expect(harnessInventory(makeComponents({ skills: [], subagents: [], toolRules: [] }))).toMatch(
      /^always-on text only;/
    )
  })
})
