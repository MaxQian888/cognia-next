import { buildSkill, isBundleResource, listSkillCandidates } from "./skill-source"

const SIMPLE_SKILL = `---
name: Code Review
description: Review a diff for correctness and style.
---

# Code Review

Read the diff, then report findings.
`

const SKILL_WITH_TOOLS = `---
name: Web Research
description: Research topics on the web.
allowed-tools: WebSearch, WebFetch
---

Search, then read primary sources.
`

describe("isBundleResource", () => {
  it.each(["scripts/run.sh", "references/api.md", "assets/logo.png", "./scripts/a.py"])(
    "accepts %s",
    (path) => {
      expect(isBundleResource(path)).toBe(true)
    }
  )

  it.each(["notes.txt", "docs/readme.md", "SKILL.md"])("rejects %s", (path) => {
    expect(isBundleResource(path)).toBe(false)
  })
})

describe("listSkillCandidates", () => {
  it("offers exactly one candidate, keyed by the slugified name", () => {
    expect(listSkillCandidates(SIMPLE_SKILL, "code-review")).toEqual([
      {
        id: "code-review",
        label: "Code Review",
        detail: "Review a diff for correctness and style.",
      },
    ])
  })

  it("falls back to the folder name when frontmatter omits `name`", () => {
    const candidates = listSkillCandidates("Body only, no frontmatter.\n", "my-skill")
    expect(candidates[0].id).toBe("my-skill")
  })
})

describe("buildSkill", () => {
  it("inlines a resource-free skill so it works in every shell", () => {
    const built = buildSkill(SIMPLE_SKILL, [], "code-review")
    expect(built.needsFilesystem).toBe(false)
    expect(built.copies).toEqual([])
    expect(built.skill).toEqual({
      id: "code-review",
      name: "Code Review",
      description: "Review a diff for correctness and style.",
      source: { kind: "inline", markdown: expect.stringContaining("Read the diff") },
    })
  })

  it("carries allowed-tools through when the frontmatter declares them", () => {
    const built = buildSkill(SKILL_WITH_TOOLS, [], "web-research")
    expect(built.skill.allowedTools).toEqual(["WebSearch", "WebFetch"])
  })

  it("switches to local-bundle when sibling resources exist", () => {
    const built = buildSkill(SIMPLE_SKILL, ["references/checklist.md", "scripts/lint.sh"], "cr")
    expect(built.needsFilesystem).toBe(true)
    expect(built.skill.source).toEqual({ kind: "local-bundle", path: "skills/code-review" })
  })

  it("copies SKILL.md plus every recognised resource into the plugin", () => {
    const built = buildSkill(SIMPLE_SKILL, ["references/checklist.md"], "cr")
    expect(built.copies).toEqual([
      { from: "SKILL.md", to: "skills/code-review/SKILL.md" },
      { from: "references/checklist.md", to: "skills/code-review/references/checklist.md" },
    ])
  })

  it("emits a plugin-dir-relative path, which the host anchors at registration", () => {
    const built = buildSkill(SIMPLE_SKILL, ["scripts/a.sh"], "cr")
    const source = built.skill.source as { path: string }
    expect(source.path.startsWith("/")).toBe(false)
    expect(source.path).not.toContain("..")
  })

  it("warns about files it did not copy instead of dropping them silently", () => {
    const built = buildSkill(SIMPLE_SKILL, ["scripts/a.sh", "notes.txt"], "cr")
    expect(built.warnings.join(" ")).toContain("notes.txt")
    expect(built.copies.map((c) => c.from)).not.toContain("notes.txt")
  })

  it("does not treat SKILL.md itself as an uncopied stray", () => {
    const built = buildSkill(SIMPLE_SKILL, ["SKILL.md", "scripts/a.sh"], "cr")
    expect(built.warnings.join(" ")).not.toContain("SKILL.md")
  })

  it("propagates the parser's own warnings", () => {
    const built = buildSkill("Body only.\n", [], "fallback-name")
    expect(built.warnings.join(" ")).toMatch(/No 'name' in frontmatter/)
  })

  it("refuses a skill whose name yields no usable id", () => {
    expect(() => buildSkill(SIMPLE_SKILL, [], "///")).not.toThrow()
    expect(() => buildSkill("---\nname: '///'\n---\n\nbody\n", [], undefined)).toThrow(
      /cannot derive a skill id/
    )
  })
})

describe("buildSkill — degenerate frontmatter", () => {
  it("carries allowed-tools through the bundle branch too", () => {
    const built = buildSkill(SKILL_WITH_TOOLS, ["scripts/a.sh"], "web-research")
    expect(built.skill.source).toEqual({
      kind: "local-bundle",
      path: "skills/web-research",
    })
    expect(built.skill.allowedTools).toEqual(["WebSearch", "WebFetch"])
  })

  it("omits allowedTools when the frontmatter declares none, in both branches", () => {
    expect(buildSkill(SIMPLE_SKILL, [], "cr").skill.allowedTools).toBeUndefined()
    expect(buildSkill(SIMPLE_SKILL, ["scripts/a.sh"], "cr").skill.allowedTools).toBeUndefined()
  })

  it("falls back to an empty description when the frontmatter omits one", () => {
    const noDescription = "---\nname: Bare\n---\n\nBody.\n"
    expect(buildSkill(noDescription, [], "bare").skill.description).toBe("")
    expect(buildSkill(noDescription, ["assets/x.png"], "bare").skill.description).toBe("")
  })
})
