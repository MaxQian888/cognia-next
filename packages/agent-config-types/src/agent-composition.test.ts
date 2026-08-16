import {
  AGENT_AUTHORITIES,
  AGENT_COMPOSITION_SCHEMA_VERSION,
  AGENT_ORCHESTRATION_POLICIES,
  AUTHORITY_RANK,
  TOOL_PRESENTATION_MODES,
  compositionDigestPayload,
  isAgentAuthority,
  isAgentOrchestrationPolicy,
  isToolPresentationMode,
  narrowAuthority,
  validateAgentCompositionSelection,
  validateResolvedAgentComposition,
  widensAuthority,
} from "./agent-composition"
import type { AgentCompositionSelectionV1, ResolvedAgentCompositionV1 } from "./agent-composition"
import { AGENT_PERMISSION_MODES } from "./index"

const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`
const DIGEST_C = `sha256:${"c".repeat(64)}`

function resolved(overrides: Partial<ResolvedAgentCompositionV1> = {}): ResolvedAgentCompositionV1 {
  return {
    schemaVersion: AGENT_COMPOSITION_SCHEMA_VERSION,
    presetId: "standard",
    presetVersion: "1",
    presetSource: "builtin",
    authority: "default",
    toolPresentation: "native",
    orchestration: "direct",
    promptDigest: DIGEST_A,
    toolDigest: DIGEST_B,
    compositionDigest: DIGEST_C,
    warnings: [],
    ...overrides,
  }
}

describe("authority ranking", () => {
  it("ranks every SDK permission mode in escalation order", () => {
    // The rank map is a total record; this pins it to the shared escalation
    // order so the two cannot drift apart silently.
    const ranked = [...AGENT_PERMISSION_MODES].sort((a, b) => AUTHORITY_RANK[a] - AUTHORITY_RANK[b])
    expect(ranked).toEqual([...AGENT_PERMISSION_MODES])
  })

  it("exposes the user-selectable authorities as a subset of the SDK modes", () => {
    for (const authority of AGENT_AUTHORITIES) {
      expect(AGENT_PERMISSION_MODES).toContain(authority)
    }
    expect(AGENT_AUTHORITIES).not.toContain("dontAsk" as never)
    expect(AGENT_AUTHORITIES).not.toContain("auto" as never)
  })
})

describe("narrowAuthority", () => {
  it("keeps the ceiling when nothing is requested", () => {
    expect(narrowAuthority("acceptEdits", undefined)).toBe("acceptEdits")
  })

  it("narrows to the less privileged request", () => {
    expect(narrowAuthority("acceptEdits", "plan")).toBe("plan")
    expect(narrowAuthority("bypassPermissions", "default")).toBe("default")
  })

  it("refuses to widen past the ceiling", () => {
    expect(narrowAuthority("plan", "bypassPermissions")).toBe("plan")
    expect(narrowAuthority("default", "acceptEdits")).toBe("default")
  })

  it("is idempotent for an equal request", () => {
    expect(narrowAuthority("default", "default")).toBe("default")
  })

  it("reports widening separately from applying it", () => {
    expect(widensAuthority("plan", "default")).toBe(true)
    expect(widensAuthority("default", "plan")).toBe(false)
    expect(widensAuthority("default", "default")).toBe(false)
  })
})

describe("axis guards", () => {
  it("accepts declared values and rejects everything else", () => {
    for (const value of AGENT_AUTHORITIES) expect(isAgentAuthority(value)).toBe(true)
    for (const value of TOOL_PRESENTATION_MODES) expect(isToolPresentationMode(value)).toBe(true)
    for (const value of AGENT_ORCHESTRATION_POLICIES) {
      expect(isAgentOrchestrationPolicy(value)).toBe(true)
    }

    expect(isAgentAuthority("build")).toBe(false)
    expect(isAgentAuthority("dontAsk")).toBe(false)
    expect(isToolPresentationMode("sandbox")).toBe(false)
    expect(isAgentOrchestrationPolicy("team")).toBe(false)
    expect(isAgentAuthority(undefined)).toBe(false)
  })
})

describe("compositionDigestPayload", () => {
  it("covers every axis plus the prompt and tool digests", () => {
    expect(compositionDigestPayload(resolved())).toEqual({
      schemaVersion: AGENT_COMPOSITION_SCHEMA_VERSION,
      presetId: "standard",
      presetVersion: "1",
      presetSource: "builtin",
      authority: "default",
      toolPresentation: "native",
      orchestration: "direct",
      runtimeBindingRef: undefined,
      promptDigest: DIGEST_A,
      toolDigest: DIGEST_B,
    })
  })

  it("ignores how the composition was reached", () => {
    // A session migrated from `agentModeId` and a natively-selected one must
    // digest identically, or every migrated session reads as a behaviour change.
    const migrated = resolved({
      legacyModeId: "general",
      warnings: [{ reason: "unknown-legacy-mode", requested: "nope", applied: "standard" }],
      executionFingerprint: "aexf1-deadbeef",
    })
    expect(compositionDigestPayload(migrated)).toEqual(compositionDigestPayload(resolved()))
  })

  it("changes when any axis changes", () => {
    const base = JSON.stringify(compositionDigestPayload(resolved()))
    expect(JSON.stringify(compositionDigestPayload(resolved({ authority: "plan" })))).not.toBe(base)
    expect(
      JSON.stringify(compositionDigestPayload(resolved({ toolPresentation: "code" })))
    ).not.toBe(base)
    expect(
      JSON.stringify(compositionDigestPayload(resolved({ orchestration: "workflow" })))
    ).not.toBe(base)
    expect(JSON.stringify(compositionDigestPayload(resolved({ presetVersion: "2" })))).not.toBe(
      base
    )
  })
})

describe("validateAgentCompositionSelection", () => {
  it("accepts a preset-only selection", () => {
    const result = validateAgentCompositionSelection({ presetId: "standard" })
    expect(result.ok).toBe(true)
  })

  it("accepts a fully specified selection", () => {
    const selection: AgentCompositionSelectionV1 = {
      presetId: "code",
      authority: "plan",
      toolPresentation: "code",
      orchestration: "subagent",
      runtimeBindingRef: "binding-1",
      legacyModeId: "code-gen",
    }
    const result = validateAgentCompositionSelection(selection)
    expect(result).toEqual({ ok: true, value: selection })
  })

  it("rejects a missing preset and unknown axis values together", () => {
    const result = validateAgentCompositionSelection({
      presetId: "",
      authority: "build",
      toolPresentation: "sandbox",
      orchestration: "team",
      runtimeBindingRef: 7,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toHaveLength(5)
  })

  it("rejects a non-object", () => {
    expect(validateAgentCompositionSelection(null).ok).toBe(false)
    expect(validateAgentCompositionSelection(["standard"]).ok).toBe(false)
  })
})

describe("validateResolvedAgentComposition", () => {
  it("accepts a well-formed composition", () => {
    expect(validateResolvedAgentComposition(resolved()).ok).toBe(true)
  })

  it("accepts an authority outside the user-selectable subset", () => {
    // A Team lead may run a child at `dontAsk`; only the *picker* is narrower.
    expect(validateResolvedAgentComposition(resolved({ authority: "dontAsk" })).ok).toBe(true)
  })

  it("rejects a non-sha256 digest", () => {
    const result = validateResolvedAgentComposition(resolved({ promptDigest: "deadbeef" }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("promptDigest must be a sha256:<64 hex> digest")
  })

  it("rejects an unknown schema version", () => {
    const result = validateResolvedAgentComposition({ ...resolved(), schemaVersion: 2 })
    expect(result.ok).toBe(false)
  })

  it("rejects an unknown authority", () => {
    const result = validateResolvedAgentComposition(resolved({ authority: "root" as never }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.errors).toContain("authority must be a known permission mode")
  })

  it("rejects missing warnings", () => {
    const { warnings: _warnings, ...withoutWarnings } = resolved()
    expect(validateResolvedAgentComposition(withoutWarnings).ok).toBe(false)
  })

  it("rejects a non-object", () => {
    expect(validateResolvedAgentComposition("standard").ok).toBe(false)
  })

  it("names each malformed field", () => {
    const cases: Array<[Partial<ResolvedAgentCompositionV1>, string]> = [
      [{ presetId: "" }, "presetId must be a non-empty string"],
      [{ presetVersion: 1 as never }, "presetVersion must be a non-empty string"],
      [
        { presetSource: "marketplace" as never },
        "presetSource must be one of builtin|custom|plugin",
      ],
      [
        { toolPresentation: "sandbox" as never },
        `toolPresentation must be one of ${TOOL_PRESENTATION_MODES.join("|")}`,
      ],
      [
        { orchestration: "team" as never },
        `orchestration must be one of ${AGENT_ORCHESTRATION_POLICIES.join("|")}`,
      ],
      [{ toolDigest: "sha256:xyz" }, "toolDigest must be a sha256:<64 hex> digest"],
      [{ compositionDigest: 7 as never }, "compositionDigest must be a sha256:<64 hex> digest"],
    ]

    for (const [override, expected] of cases) {
      const result = validateResolvedAgentComposition(resolved(override))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected failure for ${expected}`)
      expect(result.errors).toContain(expected)
    }
  })
})
