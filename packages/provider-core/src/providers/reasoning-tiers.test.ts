import {
  REASONING_TIER_ORDER,
  reasoningSurfaceFor,
  reasoningTiersFor,
  surfaceKeepsXhigh,
  tiersForSurface,
} from "./reasoning-tiers"

describe("reasoningSurfaceFor", () => {
  it("places Anthropic's effort-GA families on the native effort surface", () => {
    for (const model of [
      "claude-opus-4-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-fable-5",
      "claude-mythos-5",
    ]) {
      expect(reasoningSurfaceFor({ providerId: "anthropic", modelId: model })).toBe(
        "anthropic-effort"
      )
    }
  })

  it("gives older Anthropic models no depth control — they 400 on the parameter", () => {
    for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"]) {
      expect(reasoningSurfaceFor({ providerId: "anthropic", modelId: model })).toBe("none")
    }
  })

  it("treats date- and speed-suffixed Anthropic ids as their family", () => {
    expect(reasoningSurfaceFor({ providerId: "anthropic", modelId: "claude-opus-4-6-fast" })).toBe(
      "anthropic-effort"
    )
  })

  it("puts Google on the budget surface", () => {
    expect(reasoningSurfaceFor({ providerId: "google", modelId: "gemini-2.5-pro" })).toBe("budget")
    expect(reasoningSurfaceFor({ providerId: "gemini", modelId: "gemini-2.5-pro" })).toBe("budget")
  })

  it("separates OpenAI-native from an OpenAI-dialect gateway", () => {
    expect(reasoningSurfaceFor({ providerId: "openai", modelId: "gpt-5" })).toBe("openai-effort")
    // Same protocol, different endpoint: the sidecar only emits
    // `reasoning_effort` on a native surface, so a gateway gets the coarse map.
    expect(reasoningSurfaceFor({ providerId: "groq", modelId: "gpt-5", protocol: "openai" })).toBe(
      "generic-effort"
    )
    expect(
      reasoningSurfaceFor({ providerId: "openai", modelId: "gpt-5", openAiNative: false })
    ).toBe("generic-effort")
  })

  it("falls back to the generic gateway surface for the long tail", () => {
    expect(reasoningSurfaceFor({ providerId: "deepseek", modelId: "deepseek-reasoner" })).toBe(
      "generic-effort"
    )
  })

  it("reports no surface for a model known not to reason, or no model at all", () => {
    expect(reasoningSurfaceFor({ providerId: "openai", modelId: "gpt-4o", reasoning: false })).toBe(
      "none"
    )
    expect(reasoningSurfaceFor({ providerId: "anthropic", modelId: undefined })).toBe("none")
  })

  it("does not require the reasoning flag — unknown leaves the surface intact", () => {
    // The caller's own capability gate decides whether to render; an unknown
    // model must not silently lose its provider's ladder.
    expect(
      reasoningSurfaceFor({ providerId: "openai", modelId: "gpt-5", reasoning: undefined })
    ).toBe("openai-effort")
  })
})

describe("tiersForSurface", () => {
  it("gives Anthropic and the budget surfaces the full low…max ladder", () => {
    expect(tiersForSurface("anthropic-effort")).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(tiersForSurface("budget")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  it("gives OpenAI-native minimal…xhigh — it has minimal, and rejects max", () => {
    // `normalizeOpenAiEffort` folds `max` to `xhigh`, so offering `max` would be
    // a control with no distinct effect.
    expect(tiersForSurface("openai-effort")).toEqual(["minimal", "low", "medium", "high", "xhigh"])
  })

  it("collapses a generic gateway to the tiers it keeps distinct", () => {
    // GENERIC_REASONING_EFFORT maps minimal→low, xhigh→high, max→high, so only
    // three wire values exist and only three tiers are worth offering.
    expect(tiersForSurface("generic-effort")).toEqual(["low", "medium", "high"])
  })

  it("labels a collapsed group after the value the channel receives", () => {
    // `minimal` and `low` both fold to wire "low"; offering it as "minimal"
    // would tell the user something the channel never sees.
    expect(tiersForSurface("generic-effort")).not.toContain("minimal")
  })

  it("offers nothing on a surface with no depth control", () => {
    expect(tiersForSurface("none")).toEqual([])
  })

  it("keeps every list in canonical shallow→deep order", () => {
    for (const surface of [
      "anthropic-effort",
      "budget",
      "openai-effort",
      "generic-effort",
    ] as const) {
      const tiers = tiersForSurface(surface)
      const positions = tiers.map((t) => REASONING_TIER_ORDER.indexOf(t))
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }
  })
})

describe("surfaceKeepsXhigh", () => {
  it("is true only where xhigh survives to the wire", () => {
    // Cognia's `ultracode` tier is xhigh + workflow tools; on a surface that
    // folds xhigh into high its name promises depth it cannot deliver.
    expect(surfaceKeepsXhigh("anthropic-effort")).toBe(true)
    expect(surfaceKeepsXhigh("budget")).toBe(true)
    expect(surfaceKeepsXhigh("openai-effort")).toBe(true)
    expect(surfaceKeepsXhigh("generic-effort")).toBe(false)
    expect(surfaceKeepsXhigh("none")).toBe(false)
  })
})

describe("reasoningTiersFor", () => {
  it("composes the surface lookup with its tier list", () => {
    expect(reasoningTiersFor({ providerId: "anthropic", modelId: "claude-opus-4-8" })).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(reasoningTiersFor({ providerId: "openai", modelId: "gpt-5" })).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    expect(reasoningTiersFor({ providerId: "anthropic", modelId: "claude-haiku-4-5" })).toEqual([])
  })
})
