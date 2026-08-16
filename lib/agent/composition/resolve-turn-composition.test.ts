import { resolveTurnComposition, toolSurfaceFromNames } from "./resolve-turn-composition"
import { builtInPresetCatalog } from "./preset-catalog"

const presets = builtInPresetCatalog()

describe("toolSurfaceFromNames", () => {
  it("preserves order and records an explicit null schema", () => {
    expect(toolSurfaceFromNames(["read", "grep"])).toEqual([
      { name: "read", schema: null, visibility: "native" },
      { name: "grep", schema: null, visibility: "native" },
    ])
  })

  it("carries the requested visibility", () => {
    expect(toolSurfaceFromNames(["run_code"], "code")[0].visibility).toBe("code")
  })
})

describe("resolveTurnComposition", () => {
  it("resolves the selection and stamps a digest", async () => {
    const resolved = await resolveTurnComposition({
      presets,
      selection: { presetId: "standard" },
      supportedToolPresentations: ["native"],
    })
    expect(resolved.presetId).toBe("standard")
    expect(resolved.compositionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("gives two different prompts two different digests", async () => {
    const base = {
      presets,
      selection: { presetId: "standard" },
      supportedToolPresentations: ["native" as const],
    }
    const a = await resolveTurnComposition({ ...base, systemPrompt: "one" })
    const b = await resolveTurnComposition({ ...base, systemPrompt: "two" })
    expect(a.promptDigest).not.toBe(b.promptDigest)
    expect(a.compositionDigest).not.toBe(b.compositionDigest)
  })

  // Tool order is part of the request identity: providers are order-sensitive.
  it("gives two tool orderings two different digests", async () => {
    const base = {
      presets,
      selection: { presetId: "standard" },
      supportedToolPresentations: ["native" as const],
    }
    const a = await resolveTurnComposition({
      ...base,
      tools: toolSurfaceFromNames(["read", "grep"]),
    })
    const b = await resolveTurnComposition({
      ...base,
      tools: toolSurfaceFromNames(["grep", "read"]),
    })
    expect(a.toolDigest).not.toBe(b.toolDigest)
  })

  it("is deterministic for identical inputs", async () => {
    const input = {
      presets,
      selection: { presetId: "standard" },
      supportedToolPresentations: ["native" as const],
      systemPrompt: "same",
      tools: toolSurfaceFromNames(["read"]),
    }
    const a = await resolveTurnComposition(input)
    const b = await resolveTurnComposition(input)
    expect(a.compositionDigest).toBe(b.compositionDigest)
  })

  // The fail-closed rule reaching the wire: an unsandboxed host resolves a
  // `code` selection down to `native` before the sidecar ever sees it.
  it("degrades a code selection to native when the host cannot sandbox", async () => {
    const resolved = await resolveTurnComposition({
      presets,
      selection: { presetId: "standard", toolPresentation: "code" },
      supportedToolPresentations: ["native"],
    })
    expect(resolved.toolPresentation).toBe("native")
    expect(resolved.warnings.length).toBeGreaterThan(0)
  })

  it("keeps a code selection when the host supports it", async () => {
    const resolved = await resolveTurnComposition({
      presets,
      selection: { presetId: "standard", toolPresentation: "code" },
      supportedToolPresentations: ["native", "code"],
    })
    expect(resolved.toolPresentation).toBe("code")
  })

  it("never lets a child widen past the parent's authority", async () => {
    const resolved = await resolveTurnComposition({
      presets,
      selection: { presetId: "standard", authority: "bypassPermissions" },
      ceiling: "plan",
      supportedToolPresentations: ["native"],
    })
    expect(resolved.authority).toBe("plan")
  })

  it("pairs the execution fingerprint onto the composition", async () => {
    const resolved = await resolveTurnComposition({
      presets,
      selection: { presetId: "standard" },
      supportedToolPresentations: ["native"],
      executionFingerprint: "fp_abc",
    })
    expect(resolved.executionFingerprint).toBe("fp_abc")
  })

  it("falls back to Standard with default authority for an unknown preset", async () => {
    const resolved = await resolveTurnComposition({
      presets,
      selection: { presetId: "no-such-preset" },
      supportedToolPresentations: ["native"],
    })
    expect(resolved.authority).toBe("default")
    expect(resolved.warnings.length).toBeGreaterThan(0)
  })
})
