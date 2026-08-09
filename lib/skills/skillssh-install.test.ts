import {
  buildSkillsShFileTree,
  computeSkillsShFilesHash,
  filesToBundleResult,
} from "./skillssh-install"

const SKILL_MD = "---\nname: find-skills\ndescription: Finds skills\n---\n\n# Find Skills\nBody."

describe("buildSkillsShFileTree", () => {
  it("marks SKILL.md as kind 'skill' and sorts it first", () => {
    const tree = buildSkillsShFileTree([
      { path: "scripts/run.sh", contents: "#!/bin/sh" },
      { path: "SKILL.md", contents: SKILL_MD },
      { path: "assets/logo.png", contents: "binary-ish" },
    ])
    expect(tree[0]).toMatchObject({ path: "SKILL.md", kind: "skill" })
    expect(tree.map((n) => n.path)).toEqual(["SKILL.md", "assets/logo.png", "scripts/run.sh"])
  })

  it("classifies kinds by directory and extension", () => {
    const tree = buildSkillsShFileTree([
      { path: "SKILL.md", contents: "x" },
      { path: "scripts/build.py", contents: "pass" },
      { path: "references/api.md", contents: "# api" },
      { path: "examples/demo.ts", contents: "let x = 1" },
      { path: "logo.png", contents: "p" },
    ])
    const byPath = Object.fromEntries(tree.map((n) => [n.path, n.kind]))
    expect(byPath["scripts/build.py"]).toBe("script")
    expect(byPath["references/api.md"]).toBe("reference")
    expect(byPath["examples/demo.ts"]).toBe("script")
    expect(byPath["logo.png"]).toBe("asset")
  })

  it("records content sizes", () => {
    const tree = buildSkillsShFileTree([{ path: "SKILL.md", contents: "12345" }])
    expect(tree[0].size).toBe(5)
  })
})

describe("filesToBundleResult", () => {
  it("parses SKILL.md into the draft and maps the rest to resources", () => {
    const result = filesToBundleResult(
      [
        { path: "SKILL.md", contents: SKILL_MD },
        { path: "scripts/run.sh", contents: "#!/bin/sh\necho hi" },
        { path: "references/notes.md", contents: "# notes" },
      ],
      "fallback"
    )
    expect(result.draft.name).toBe("find-skills")
    expect(result.draft.content).toContain("Body.")
    expect(result.draft.resources).toHaveLength(2)
    expect(result.draft.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "scripts/run.sh",
          name: "run.sh",
          kind: "script",
          encoding: "utf-8",
          size: 17,
        }),
        expect.objectContaining({ path: "references/notes.md", kind: "reference" }),
      ])
    )
  })

  it("accepts a nested SKILL.md (e.g. skills/<slug>/SKILL.md)", () => {
    const result = filesToBundleResult(
      [{ path: "skills/find-skills/SKILL.md", contents: SKILL_MD }],
      "fallback"
    )
    expect(result.draft.name).toBe("find-skills")
    expect(result.draft.resources).toBeUndefined()
  })

  it("recognizes agents/openai.yaml as Codex configuration instead of an asset", () => {
    const openaiYaml = `policy:\n  allow_implicit_invocation: false\nvendor:\n  keep: true\n`
    const result = filesToBundleResult(
      [
        { path: "SKILL.md", contents: SKILL_MD },
        { path: "agents/openai.yaml", contents: openaiYaml },
        { path: "references/guide.md", contents: "guide" },
      ],
      "fallback"
    )
    expect(result.draft.codexOpenAiYaml).toBe(openaiYaml)
    expect(result.draft.invocationPolicy).toBe("explicit")
    expect(result.draft.resources).toEqual([
      expect.objectContaining({ path: "references/guide.md" }),
    ])
  })

  it("throws when no SKILL.md is present", () => {
    expect(() => filesToBundleResult([{ path: "readme.md", contents: "x" }], "fallback")).toThrow(
      /no SKILL\.md/
    )
  })

  it("uses the fallback name when the frontmatter omits one", () => {
    const result = filesToBundleResult(
      [{ path: "SKILL.md", contents: "Just a body, no frontmatter." }],
      "my-fallback"
    )
    expect(result.draft.name).toBe("my-fallback")
  })
})

describe("computeSkillsShFilesHash", () => {
  it("is stable across file ordering", async () => {
    const a = await computeSkillsShFilesHash([
      { path: "SKILL.md", contents: "x" },
      { path: "scripts/run.sh", contents: "y" },
    ])
    const b = await computeSkillsShFilesHash([
      { path: "scripts/run.sh", contents: "y" },
      { path: "SKILL.md", contents: "x" },
    ])
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("changes when any file's contents change", async () => {
    const a = await computeSkillsShFilesHash([{ path: "SKILL.md", contents: "x" }])
    const b = await computeSkillsShFilesHash([{ path: "SKILL.md", contents: "x2" }])
    expect(a).not.toBe(b)
  })
})
