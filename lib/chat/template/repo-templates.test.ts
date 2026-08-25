import {
  demoteRepoLaunchSpec,
  parseRepoTemplate,
  repoTemplateId,
  repoTemplateRevision,
} from "./repo-templates"

describe("demoteRepoLaunchSpec", () => {
  // A checkout asking for `acceptEdits` is asking whoever cloned it to hand
  // write access to whoever last pushed.
  it("refuses every mode looser than default", () => {
    for (const permissionMode of ["acceptEdits", "bypassPermissions", "dontAsk", "auto"] as const) {
      expect(demoteRepoLaunchSpec({ permissionMode })).toBeUndefined()
    }
  })

  it("keeps a mode at or below the ceiling", () => {
    expect(demoteRepoLaunchSpec({ permissionMode: "plan" })).toEqual({ permissionMode: "plan" })
    expect(demoteRepoLaunchSpec({ permissionMode: "default" })).toEqual({
      permissionMode: "default",
    })
  })

  // A value this build cannot reason about is not a value it can bound.
  it("drops a mode it does not recognise", () => {
    expect(demoteRepoLaunchSpec({ permissionMode: "yolo" as never, model: "m" })).toEqual({
      model: "m",
    })
  })

  it("strips every field that would hand out capability", () => {
    expect(
      demoteRepoLaunchSpec({
        allowedTools: ["Bash"],
        mcpServerIds: ["srv"],
        skillIds: ["skill"],
        agentModeId: "mode",
        workingDir: "/",
        disallowedTools: ["WebSearch"],
      })
    ).toEqual({ disallowedTools: ["WebSearch"] })
  })

  it("keeps the portable half of a workspace reference and drops the local id", () => {
    expect(
      demoteRepoLaunchSpec({
        workspace: { projectId: "prj_local", gitRemote: "git@x:a/b.git", branch: "main" },
      })
    ).toEqual({ workspace: { gitRemote: "git@x:a/b.git", branch: "main" } })
  })

  it("returns nothing when nothing survives, so no diff bar appears", () => {
    expect(demoteRepoLaunchSpec({ allowedTools: ["Bash"] })).toBeUndefined()
    expect(demoteRepoLaunchSpec(undefined)).toBeUndefined()
  })
})

describe("parseRepoTemplate", () => {
  it("reads a body and derives its parameters", () => {
    const parsed = parseRepoTemplate(
      ".cognia/templates/review.md",
      "---\nname: Review a PR\ndescription: Focused review\n---\nReview {{module}} on {{branch}}."
    )

    expect(parsed).toMatchObject({
      id: "repo:review",
      name: "Review a PR",
      description: "Focused review",
      body: "Review {{module}} on {{branch}}.",
      source: "repo",
      sourcePath: ".cognia/templates/review.md",
    })
    expect(parsed!.params.map((p) => p.id)).toEqual(["module", "branch"])
  })

  it("falls back to the file name when the frontmatter has no name", () => {
    expect(parseRepoTemplate(".cognia/templates/bug-report.md", "Report {{what}}")?.name).toBe(
      "bug-report"
    )
  })

  it("lets the frontmatter add what a token cannot say about itself", () => {
    const parsed = parseRepoTemplate(
      ".cognia/templates/t.md",
      [
        "---",
        "params:",
        "  - id: target",
        "    label: Which file",
        "    kind: resource",
        "    resourceKind: file",
        "  - id: depth",
        "    kind: enum",
        "    options: [quick, thorough]",
        "    required: false",
        "---",
        "Review {{target}} at {{depth}} depth.",
      ].join("\n")
    )

    expect(parsed!.params).toEqual([
      { id: "target", label: "Which file", required: true, kind: "resource", resourceKind: "file" },
      {
        id: "depth",
        label: "depth",
        required: false,
        kind: "enum",
        options: ["quick", "thorough"],
      },
    ])
  })

  // The body decides which parameters exist; the frontmatter only annotates.
  it("ignores a declaration for a token the body does not contain", () => {
    const parsed = parseRepoTemplate(
      ".cognia/templates/t.md",
      "---\nparams:\n  - id: ghost\n    label: Ghost\n---\nHello {{name}}"
    )
    expect(parsed!.params.map((p) => p.id)).toEqual(["name"])
  })

  it("falls back to text for a resource kind nothing can pick from", () => {
    const parsed = parseRepoTemplate(
      ".cognia/templates/t.md",
      "---\nparams:\n  - id: x\n    kind: resource\n    resourceKind: skill\n---\nUse {{x}}"
    )
    expect(parsed!.params[0]).toEqual({ id: "x", label: "x", required: true, kind: "string" })
  })

  it("demotes the setup a file carries", () => {
    const parsed = parseRepoTemplate(
      ".cognia/templates/t.md",
      [
        "---",
        "launch:",
        "  permissionMode: bypassPermissions",
        "  allowedTools: [Bash]",
        "  model: claude-sonnet-5",
        "---",
        "Go {{x}}",
      ].join("\n")
    )
    expect(parsed!.launchSpec).toEqual({ model: "claude-sonnet-5" })
  })

  // A file someone is halfway through writing must not take the picker down.
  it("returns null rather than throwing on an unusable file", () => {
    expect(parseRepoTemplate(".cognia/templates/t.md", "---\nname: [\n---\nbody")).toBeNull()
    expect(parseRepoTemplate(".cognia/templates/t.md", "---\nname: Empty\n---\n   ")).toBeNull()
  })
})

describe("repoTemplateRevision", () => {
  it("changes when the body does, so a pinned draft stops following", () => {
    const a = repoTemplateRevision("review {{x}}", [])
    expect(repoTemplateRevision("review {{x}}", [])).toBe(a)
    expect(repoTemplateRevision("review {{y}}", [])).not.toBe(a)
  })

  it("changes when only a declaration does", () => {
    const params = [{ id: "x", label: "x", required: true, kind: "string" as const }]
    expect(repoTemplateRevision("review {{x}}", params)).not.toBe(
      repoTemplateRevision("review {{x}}", [{ ...params[0], required: false }])
    )
  })
})

describe("repoTemplateId", () => {
  it("is the file name, so two roots cannot silently disagree about one id", () => {
    expect(repoTemplateId(".cognia/templates/review.md")).toBe("repo:review")
    expect(repoTemplateId(".cognia/templates/review.mdx")).toBe("repo:review")
    expect(repoTemplateId(".cognia\\templates\\review.md")).toBe("repo:review")
  })
})
