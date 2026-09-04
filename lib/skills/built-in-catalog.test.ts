import {
  BUILT_IN_SKILL_CAPABILITY_IDS,
  BUILT_IN_SKILL_CATALOG,
  builtinSkillId,
  canonicalBuiltinSkillId,
  getCatalogSkill,
  loadBuiltInSkillContent,
  resolveBuiltinSkillIdentity,
  BUILTIN_SKILL_ID_PREFIX,
} from "./built-in-catalog"

describe("built-in skills catalog", () => {
  it("ships the expected functional skills", () => {
    const ids = BUILT_IN_SKILL_CATALOG.map((e) => e.id).sort()
    expect(ids).toEqual([
      "agent-team-delegation",
      "chart-design",
      // `cognia-onboarding` shipped in the catalog without being added here, so
      // this assertion had been red on `dev`; adding a skill meant fixing it.
      "cognia-onboarding",
      "computer-use-safety",
      "diagram-design",
      "digital-twin-query",
      "goal-loop-execution",
      "im-auto-reply",
      "ocr-extraction",
      "plugin-authoring",
      "plugin-conversion",
      "scheduling",
      "web-research",
      "workflow-authoring",
    ])
  })

  it("teaches the chart artifact contract the renderer actually enforces", async () => {
    const entry = getCatalogSkill("chart-design")!
    const body = await loadBuiltInSkillContent(entry.id)
    expect(entry.category).toBe("data-analysis")
    expect(entry.surface).toEqual([])
    // Each of these is a real constraint in the pipeline, not style advice:
    // the artifact tool, the series list read from `data[0]` only, the
    // detector's line-count floor, and the palette the renderer owns.
    expect(body).toContain("`artifact_create`")
    expect(body).toContain("first row only")
    expect(body).toContain("at least three lines")
    expect(body).toContain("Do not specify colours")
    // The prohibition survives, now scoped to the branch where it is true.
    // It used to be blanket, which contradicted the host: in `fenced` mode the
    // routing prompt ASKS for a fenced payload, and that is a desktop session
    // with a live dock, not the IM case this sentence is about.
    expect(body).toContain("do not try to bypass")
    expect(body).toContain("It offers no artifact route at all")
    expect(body).toContain("fenced block tagged `json`")
    expect(body).toContain("Always name the `type`")
    // Scatter is the one shape with a different row contract.
    expect(body).toMatch(/`x` and\s+`y`\*\* as numbers/)
  })

  it("teaches both structural routes, not only the HTML one", async () => {
    const entry = getCatalogSkill("diagram-design")!
    const body = await loadBuiltInSkillContent(entry.id)
    // The mermaid surface had no contract anywhere in the repo, yet it is the
    // default for structural content and the only one that survives an IM
    // thread, where this skill is not even delivered.
    expect(body).toContain("Quote every label")
    expect(body).toContain("%%{init}%%")
    expect(body).toContain("8,000")
    // `-beta` is load-bearing: those grammars do not parse without it.
    expect(body).toContain("radar-beta")
    // The HTML route stays the deliverable route, and still names its tool.
    expect(body).toContain('artifact_create` with `type: "html"')
  })

  it("publishes an orthogonal delivery and activation contract for every skill", () => {
    expect(
      Object.fromEntries(BUILT_IN_SKILL_CATALOG.map((entry) => [entry.id, entry.delivery]))
    ).toEqual({
      "agent-team-delegation": "inject",
      "chart-design": "catalog",
      "cognia-onboarding": "request-scoped",
      "computer-use-safety": "inject",
      "diagram-design": "catalog",
      "digital-twin-query": "inject",
      "goal-loop-execution": "inject",
      "im-auto-reply": "inject",
      "ocr-extraction": "catalog",
      "plugin-authoring": "explicit",
      "plugin-conversion": "explicit",
      // `catalog`, not `inject`: there is no scheduler SURFACE in a chat, and
      // the capability gate (`scheduler` → does this turn actually hold the
      // tools) is what keeps it off a turn that could not act on it.
      scheduling: "catalog",
      "web-research": "catalog",
      "workflow-authoring": "inject",
    })

    for (const entry of BUILT_IN_SKILL_CATALOG) {
      expect(entry.canonicalId).toBe(`builtin:${entry.id}`)
      expect([...entry.triggers.surfaces, ...entry.triggers.intents].length).toBeGreaterThan(0)
      expect(entry.surface).toEqual(entry.triggers.surfaces)
      expect(entry.hostPolicies.length).toBeGreaterThan(0)
      for (const requirement of entry.capabilityRequirements) {
        expect(requirement.capability.trim()).not.toBe("")
        expect(requirement.reason.trim()).not.toBe("")
      }
    }
  })

  it("exports the complete capability-id vocabulary for exhaustive runtime mapping", () => {
    expect(BUILT_IN_SKILL_CAPABILITY_IDS).toEqual([
      "agent-dispatch",
      "artifact-authoring",
      "cognia-cli",
      "computer-use",
      "goal-runtime",
      "im-binding",
      "ocr",
      "plugin-conversion-tools",
      "scheduler",
      "screen-capture",
      "twin-context",
      "web-fetch",
      "web-search",
      "workflow-editor-tools",
      "workspace",
      "workspace-backend",
      "workspace-read",
    ])
    expect(
      [
        ...new Set(
          BUILT_IN_SKILL_CATALOG.flatMap((entry) =>
            entry.capabilityRequirements.map((requirement) => requirement.capability)
          )
        ),
      ].sort()
    ).toEqual(BUILT_IN_SKILL_CAPABILITY_IDS)
  })

  it("keeps specialized skills explicit and policy-sensitive skills host-owned", () => {
    for (const id of ["plugin-authoring", "plugin-conversion"]) {
      const entry = getCatalogSkill(id)!
      expect(entry.delivery).toBe("explicit")
      expect(entry.triggers.surfaces).toEqual([])
      expect(entry.hostPolicies).toEqual(
        expect.arrayContaining(["workspace-confined", "host-consent", "permission-ceiling"])
      )
    }

    expect(getCatalogSkill("cognia-onboarding")).toMatchObject({
      delivery: "request-scoped",
      hostPolicies: expect.arrayContaining(["request-scope", "capability-preflight"]),
    })
    expect(getCatalogSkill("workflow-authoring")).toMatchObject({
      delivery: "inject",
      hostPolicies: expect.arrayContaining(["proposal-first", "host-consent"]),
    })
  })

  it("makes contextual delivery reachable by default while specialists stay manual", () => {
    for (const entry of BUILT_IN_SKILL_CATALOG) {
      expect(entry.defaultEnabled).toBe(entry.delivery === "explicit" ? undefined : true)
    }
  })

  it("emits a content-free resource manifest with a role for every payload", () => {
    for (const entry of BUILT_IN_SKILL_CATALOG) {
      const manifest = entry.resourceManifest ?? []
      for (const resource of manifest) {
        expect(["runtime-reference", "template", "example", "compliance"]).toContain(resource.role)
      }
    }

    const diagram = getCatalogSkill("diagram-design")!
    expect(
      diagram.resourceManifest?.find((resource) => resource.path === "assets/template.html")?.role
    ).toBe("template")
    expect(
      diagram.resourceManifest?.find(
        (resource) => resource.path === "assets/example-flowchart.html"
      )?.role
    ).toBe("example")
    expect(
      diagram.resourceManifest?.find(
        (resource) => resource.path === "references/UPSTREAM_LICENSE.txt"
      )?.role
    ).toBe("compliance")
  })

  it("pins request scope, proposal-first workflow editing, and exact visual tools in content", async () => {
    const [onboarding, workflow, chart, diagram] = await Promise.all(
      ["cognia-onboarding", "workflow-authoring", "chart-design", "diagram-design"].map(
        loadBuiltInSkillContent
      )
    )
    expect(onboarding).toContain("at most one\nmissing-input reply")
    expect(workflow).toContain("`wf_propose_batch`")
    expect(workflow).toContain("Do not call legacy direct-mutation tools")
    expect(chart).toContain("artifact_create")
    expect(diagram).toContain('artifact_create` with `type: "html"')
  })

  it("registers plugin authoring as an opt-in skill with its required tools", async () => {
    const entry = getCatalogSkill("plugin-authoring")!
    const body = await loadBuiltInSkillContent(entry.id)
    expect(entry.allowedTools).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "Bash"])
    expect(entry.surface).toEqual([])
    expect(body).toContain("cognia plugin contract")
    expect(body).toContain("--point <id>")
    expect(body).toContain("--point-kind <kind>")
    expect(body).toContain("--permission <permission>")
    expect(body).toContain("formFactor")
    expect(body).toContain("deprecated")
    expect(body).toContain("plugin-owned i18n")
    expect(body).toContain("shared React")
    expect(body).toContain("vscode-extension")
    expect(body).toContain("wasm")
    expect(body).toContain("support=experimental")
    expect(body).toContain("cognia plugin sync-types")
    expect(body).toContain("scaffolded public `cognia` module")
    expect(body).toContain("only when the user explicitly requests")
  })

  it("every entry has a name, non-empty body, and a surface array", async () => {
    for (const e of BUILT_IN_SKILL_CATALOG) {
      expect(e.name.trim().length).toBeGreaterThan(0)
      // Loaded, not read off the entry: the loader is the only route to a body
      // now, so this also pins that every id in the catalog has a chunk.
      expect((await loadBuiltInSkillContent(e.id)).trim().length).toBeGreaterThan(0)
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

  it("normalizes canonical, bundle, slug, and Dexie ids to one built-in identity", () => {
    const expected = {
      bundleId: "im-auto-reply",
      canonicalId: "builtin:im-auto-reply",
      storageId: "skill_builtin_im_auto_reply",
    }
    for (const alias of ["im-auto-reply", "builtin:im-auto-reply", "skill_builtin_im_auto_reply"]) {
      expect(resolveBuiltinSkillIdentity(alias)).toEqual(expected)
    }
    expect(canonicalBuiltinSkillId(getCatalogSkill("im-auto-reply")!)).toBe(expected.canonicalId)
  })

  it("does not manufacture an identity for an unknown alias", () => {
    expect(resolveBuiltinSkillIdentity("builtin:not-real")).toBeUndefined()
  })
})
