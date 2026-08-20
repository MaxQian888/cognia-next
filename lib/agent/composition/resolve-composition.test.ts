import {
  DEFAULT_HOST_DEFAULTS,
  resolveChildComposition,
  resolveComposition,
} from "./resolve-composition"
import type { ResolveCompositionInput } from "./resolve-composition"
import {
  builtInPresetCatalog,
  CODE_PRESET,
  MINIMAL_PRESET,
  STANDARD_PRESET,
} from "./preset-catalog"
import { AGENT_COMPOSITION_SCHEMA_VERSION } from "@cognia/agent-config-types/agent-composition"

const PROMPT = `sha256:${"a".repeat(64)}`
const TOOLS = `sha256:${"b".repeat(64)}`

function input(overrides: Partial<ResolveCompositionInput> = {}): ResolveCompositionInput {
  return {
    presets: builtInPresetCatalog(),
    promptDigest: PROMPT,
    toolDigest: TOOLS,
    ...overrides,
  }
}

describe("axis precedence", () => {
  it("prefers the selection over the preset recommendation", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", authority: "plan" } })
    )
    expect(resolved.authority).toBe("plan")
    expect(resolved.warnings).toEqual([])
  })

  it("falls back to the preset recommendation", () => {
    const resolved = resolveComposition(input({ selection: { presetId: "minimal" } }))
    expect(resolved.authority).toBe(MINIMAL_PRESET.recommends?.authority)
    expect(resolved.toolPresentation).toBe("native")
  })

  it("falls back to the host default when the preset recommends nothing", () => {
    const bare = { ...STANDARD_PRESET, recommends: undefined }
    const resolved = resolveComposition(
      input({ presets: [bare], selection: { presetId: "standard" } })
    )
    expect(resolved.authority).toBe(DEFAULT_HOST_DEFAULTS.authority)
    expect(resolved.orchestration).toBe(DEFAULT_HOST_DEFAULTS.orchestration)
  })

  it("honours a caller-supplied host default", () => {
    const bare = { ...STANDARD_PRESET, recommends: undefined }
    const resolved = resolveComposition(
      input({
        presets: [bare],
        selection: { presetId: "standard" },
        hostDefaults: { authority: "plan", toolPresentation: "both", orchestration: "subagent" },
      })
    )
    expect(resolved.authority).toBe("plan")
    expect(resolved.toolPresentation).toBe("both")
    expect(resolved.orchestration).toBe("subagent")
  })

  it("carries the runtime binding reference through untouched", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", runtimeBindingRef: "binding-7" } })
    )
    expect(resolved.runtimeBindingRef).toBe("binding-7")
  })

  it("stamps the schema version, digests and fingerprint it was given", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard" }, executionFingerprint: "aexf1-abc" })
    )
    expect(resolved.schemaVersion).toBe(AGENT_COMPOSITION_SCHEMA_VERSION)
    expect(resolved.promptDigest).toBe(PROMPT)
    expect(resolved.toolDigest).toBe(TOOLS)
    expect(resolved.executionFingerprint).toBe("aexf1-abc")
  })
})

describe("authority caps", () => {
  it("caps an escalated selection at the preset maximum", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "minimal", authority: "acceptEdits" } })
    )
    expect(resolved.authority).toBe("plan")
    expect(resolved.warnings).toEqual([
      { reason: "authority-capped-by-preset", requested: "acceptEdits", applied: "plan" },
    ])
  })

  it("caps Creator below bypassPermissions", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "creator", authority: "bypassPermissions" } })
    )
    expect(resolved.authority).toBe("acceptEdits")
    expect(resolved.warnings[0]?.reason).toBe("authority-capped-by-preset")
  })

  it("caps at the parent ceiling", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", authority: "acceptEdits" }, ceiling: "default" })
    )
    expect(resolved.authority).toBe("default")
    expect(resolved.warnings).toEqual([
      { reason: "authority-capped-by-ceiling", requested: "acceptEdits", applied: "default" },
    ])
  })

  it("applies the preset cap and then the ceiling, reporting both", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "creator", authority: "bypassPermissions" },
        ceiling: "default",
      })
    )
    expect(resolved.authority).toBe("default")
    expect(resolved.warnings.map((warning) => warning.reason)).toEqual([
      "authority-capped-by-preset",
      "authority-capped-by-ceiling",
    ])
  })

  it("does not warn when the request already sits under both caps", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", authority: "plan" }, ceiling: "acceptEdits" })
    )
    expect(resolved.authority).toBe("plan")
    expect(resolved.warnings).toEqual([])
  })

  it("never widens toward the ceiling", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "standard", authority: "plan" },
        ceiling: "bypassPermissions",
      })
    )
    expect(resolved.authority).toBe("plan")
  })
})

describe("child resolution", () => {
  it("bounds a child by the parent's resolved authority", () => {
    const parent = resolveComposition(
      input({ selection: { presetId: "minimal", authority: "acceptEdits" } })
    )
    expect(parent.authority).toBe("plan")

    const child = resolveChildComposition(
      parent,
      input({ selection: { presetId: "standard", authority: "acceptEdits" } })
    )
    // The parent asked for acceptEdits and did not get it; the child must not
    // inherit what the parent was refused.
    expect(child.authority).toBe("plan")
    expect(child.warnings[0]?.reason).toBe("authority-capped-by-ceiling")
  })

  it("lets a child narrow further than its parent", () => {
    const parent = resolveComposition(
      input({ selection: { presetId: "standard", authority: "acceptEdits" } })
    )
    const child = resolveChildComposition(
      parent,
      input({ selection: { presetId: "standard", authority: "plan" } })
    )
    expect(child.authority).toBe("plan")
    expect(child.warnings).toEqual([])
  })
})

describe("unavailable capabilities", () => {
  it("degrades code presentation to native and says so", () => {
    // The strict sandbox is unavailable: the code path fails closed rather than
    // running generated code unsandboxed.
    const resolved = resolveComposition(
      input({
        selection: { presetId: "code" },
        supportedToolPresentations: ["native"],
      })
    )
    expect(resolved.toolPresentation).toBe("native")
    expect(resolved.warnings).toEqual([
      { reason: "presentation-unavailable", requested: "code", applied: "native" },
    ])
  })

  it("keeps code presentation when the host supports it", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "code" },
        supportedToolPresentations: ["native", "code"],
      })
    )
    expect(resolved.toolPresentation).toBe(CODE_PRESET.recommends?.toolPresentation)
    expect(resolved.warnings).toEqual([])
  })

  it("degrades an unavailable orchestration to direct", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "standard", orchestration: "workflow" },
        supportedOrchestrations: ["direct"],
      })
    )
    expect(resolved.orchestration).toBe("direct")
    expect(resolved.warnings).toEqual([
      { reason: "orchestration-unavailable", requested: "workflow", applied: "direct" },
    ])
  })

  it("leaves both axes alone when no support list is given", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", orchestration: "workflow" } })
    )
    expect(resolved.orchestration).toBe("workflow")
    expect(resolved.warnings).toEqual([])
  })
})

describe("unknown presets", () => {
  it("falls back to Standard and reports it", () => {
    const resolved = resolveComposition(input({ selection: { presetId: "ghost" } }))
    expect(resolved.presetId).toBe("standard")
    expect(resolved.warnings).toEqual([
      { reason: "unknown-preset", requested: "ghost", applied: "standard" },
    ])
  })

  it("still resolves when the catalog itself is empty", () => {
    // Mid-turn is the wrong place to throw; an unprivileged composition is.
    const resolved = resolveComposition(input({ presets: [], selection: { presetId: "ghost" } }))
    expect(resolved.presetId).toBe("standard")
    expect(resolved.presetSource).toBe("builtin")
    expect(resolved.authority).toBe("default")
  })
})

describe("legacy migration", () => {
  it("migrates agentModeId when there is no modern selection", () => {
    const resolved = resolveComposition(input({ legacyModeId: "build" }))
    expect(resolved.presetId).toBe("standard")
    expect(resolved.authority).toBe("acceptEdits")
    expect(resolved.legacyModeId).toBe("build")
    expect(resolved.warnings).toEqual([])
  })

  it("migrates a domain mode to its adapted preset", () => {
    const resolved = resolveComposition(input({ legacyModeId: "research" }))
    expect(resolved.presetId).toBe("research")
  })

  it("reports an unknown legacy id and refuses to elevate it", () => {
    const resolved = resolveComposition(input({ legacyModeId: "mystery-mode" }))
    expect(resolved.presetId).toBe("standard")
    expect(resolved.authority).toBe("default")
    expect(resolved.warnings).toEqual([
      { reason: "unknown-legacy-mode", requested: "mystery-mode", applied: "standard" },
    ])
  })

  it("ignores agentModeId once a modern selection exists", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "minimal" }, legacyModeId: "build" })
    )
    expect(resolved.presetId).toBe("minimal")
    expect(resolved.authority).toBe("plan")
  })

  it("resolves an absent selection and absent legacy id to plain Standard", () => {
    const resolved = resolveComposition(input())
    expect(resolved.presetId).toBe("standard")
    expect(resolved.authority).toBe("default")
    expect(resolved.toolPresentation).toBe("native")
    expect(resolved.orchestration).toBe("direct")
    expect(resolved.warnings).toEqual([])
    expect(resolved.legacyModeId).toBeUndefined()
  })
})

describe("autonomy", () => {
  it("defaults to a level that caps nothing, so a chosen authority survives", () => {
    // The regression this pins: if the host default were anything below
    // `autopilot`, adding the axis would silently narrow every desktop user
    // who had picked `bypassPermissions`.
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", authority: "bypassPermissions" } })
    )
    expect(DEFAULT_HOST_DEFAULTS.autonomy).toBe("autopilot")
    expect(resolved.authority).toBe("bypassPermissions")
    expect(resolved.autonomy).toBe("autopilot")
    expect(resolved.warnings).toEqual([])
  })

  it("caps authority at the level the autonomy implies", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "standard", authority: "bypassPermissions", autonomy: "confirm" },
      })
    )
    expect(resolved.authority).toBe("default")
    expect(resolved.warnings).toContainEqual({
      reason: "authority-capped-by-autonomy",
      requested: "bypassPermissions",
      applied: "default",
    })
  })

  it("names the value the caller asked for, not an intermediate one", () => {
    // Code pins itself at `acceptEdits`; asking for bypass at `suggest`
    // autonomy must report the preset cap and the autonomy cap separately.
    const resolved = resolveComposition(
      input({
        selection: {
          presetId: CODE_PRESET.id,
          authority: "bypassPermissions",
          autonomy: "suggest",
        },
      })
    )
    const reasons = resolved.warnings.map((warning) => warning.reason)
    expect(reasons).toContain("authority-capped-by-autonomy")
    expect(resolved.authority).toBe("plan")
  })

  it("applies the preset cap before the parent ceiling", () => {
    const gated = { ...STANDARD_PRESET, maxAutonomy: "confirm" as const }
    const resolved = resolveComposition(
      input({
        presets: [gated],
        selection: { presetId: "standard", autonomy: "autopilot" },
      })
    )
    expect(resolved.autonomy).toBe("confirm")
    expect(resolved.warnings).toContainEqual({
      reason: "autonomy-capped-by-preset",
      requested: "autopilot",
      applied: "confirm",
    })
  })

  it("lets a child narrow its parent's autonomy and never widen it", () => {
    const parent = resolveComposition(
      input({ selection: { presetId: "standard", autonomy: "confirm" } })
    )
    const child = resolveChildComposition(parent, {
      ...input({ selection: { presetId: "standard", autonomy: "autopilot" } }),
    })
    expect(child.autonomy).toBe("confirm")
    expect(child.warnings).toContainEqual({
      reason: "autonomy-capped-by-ceiling",
      requested: "autopilot",
      applied: "confirm",
    })
  })
})

describe("engagement", () => {
  it("defaults to inline", () => {
    const resolved = resolveComposition(input({ selection: { presetId: "standard" } }))
    expect(resolved.engagement).toBe("inline")
  })

  it("honours an explicit selection", () => {
    const resolved = resolveComposition(
      input({ selection: { presetId: "standard", engagement: "background" } })
    )
    expect(resolved.engagement).toBe("background")
    expect(resolved.warnings).toEqual([])
  })

  it("degrades loudly on a host that cannot detach a run", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "standard", engagement: "background" },
        supportedEngagements: ["inline"],
      })
    )
    expect(resolved.engagement).toBe("inline")
    expect(resolved.warnings).toContainEqual({
      reason: "engagement-unavailable",
      requested: "background",
      applied: "inline",
    })
  })
})

describe("orchestration reference", () => {
  it("carries the engine's target id without owning it", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "standard", orchestration: "team", orchestrationRef: "team-42" },
      })
    )
    expect(resolved.orchestration).toBe("team")
    expect(resolved.orchestrationRef).toBe("team-42")
  })

  it("degrades an unsupported orchestration to direct", () => {
    const resolved = resolveComposition(
      input({
        selection: { presetId: "standard", orchestration: "team" },
        supportedOrchestrations: ["direct"],
      })
    )
    expect(resolved.orchestration).toBe("direct")
    expect(resolved.warnings).toContainEqual({
      reason: "orchestration-unavailable",
      requested: "team",
      applied: "direct",
    })
  })
})
