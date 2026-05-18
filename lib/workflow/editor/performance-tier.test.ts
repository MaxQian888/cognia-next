import {
  AUTO_BALANCED_THRESHOLD,
  flagsForTier,
  isPerformanceTier,
  resolveEffectiveTier,
} from "./performance-tier"

describe("resolveEffectiveTier", () => {
  it("returns 'high' on auto when graph is small and reduce-motion is off", () => {
    expect(resolveEffectiveTier("auto", { nodeCount: 10, prefersReducedMotion: false })).toBe(
      "high"
    )
  })

  it("returns 'balanced' on auto when nodeCount crosses the threshold", () => {
    expect(
      resolveEffectiveTier("auto", {
        nodeCount: AUTO_BALANCED_THRESHOLD,
        prefersReducedMotion: false,
      })
    ).toBe("balanced")
  })

  it("returns 'reduced' on auto when prefers-reduced-motion is set, regardless of size", () => {
    expect(resolveEffectiveTier("auto", { nodeCount: 2, prefersReducedMotion: true })).toBe(
      "reduced"
    )
    expect(resolveEffectiveTier("auto", { nodeCount: 500, prefersReducedMotion: true })).toBe(
      "reduced"
    )
  })

  it("honours explicit tier over reduce-motion + huge graph", () => {
    expect(resolveEffectiveTier("high", { nodeCount: 1000, prefersReducedMotion: true })).toBe(
      "high"
    )
    expect(resolveEffectiveTier("reduced", { nodeCount: 1, prefersReducedMotion: false })).toBe(
      "reduced"
    )
    expect(resolveEffectiveTier("balanced", { nodeCount: 1, prefersReducedMotion: false })).toBe(
      "balanced"
    )
  })
})

describe("flagsForTier", () => {
  it("high tier turns everything on", () => {
    expect(flagsForTier("high")).toEqual({
      showMinimap: true,
      minimapDegraded: false,
      edgeAnimations: true,
      alignmentGuides: true,
      liveQueryWhileDragging: true,
      inspectorLiveValidation: true,
      nodeCardTransitions: true,
      cullingThreshold: 25,
    })
  })

  it("balanced tier keeps minimap but degraded, no edge animation, no live-query while dragging", () => {
    const flags = flagsForTier("balanced")
    expect(flags.showMinimap).toBe(true)
    expect(flags.minimapDegraded).toBe(true)
    expect(flags.edgeAnimations).toBe(false)
    expect(flags.alignmentGuides).toBe(true)
    expect(flags.liveQueryWhileDragging).toBe(false)
    expect(flags.inspectorLiveValidation).toBe(true)
    expect(flags.nodeCardTransitions).toBe(true)
    expect(flags.cullingThreshold).toBe(0)
  })

  it("reduced tier turns motion and minimap off", () => {
    expect(flagsForTier("reduced")).toEqual({
      showMinimap: false,
      minimapDegraded: false,
      edgeAnimations: false,
      alignmentGuides: false,
      liveQueryWhileDragging: false,
      inspectorLiveValidation: false,
      nodeCardTransitions: false,
      cullingThreshold: 0,
    })
  })

  it("returns a fresh reference each call (does not leak the internal table)", () => {
    expect(flagsForTier("high")).not.toBe(flagsForTier("high"))
  })

  it("cullingThreshold is low enough on high tier to engage on small graphs", () => {
    // Was a hard 40 in canvas.tsx; tier-driven now so balanced/reduced can
    // unconditionally cull (0) and high still has a small-graph fast path.
    expect(flagsForTier("high").cullingThreshold).toBeLessThan(40)
    expect(flagsForTier("balanced").cullingThreshold).toBe(0)
    expect(flagsForTier("reduced").cullingThreshold).toBe(0)
  })
})

describe("isPerformanceTier", () => {
  it("accepts the four known tiers", () => {
    expect(isPerformanceTier("auto")).toBe(true)
    expect(isPerformanceTier("high")).toBe(true)
    expect(isPerformanceTier("balanced")).toBe(true)
    expect(isPerformanceTier("reduced")).toBe(true)
  })

  it("rejects everything else", () => {
    expect(isPerformanceTier(undefined)).toBe(false)
    expect(isPerformanceTier(null)).toBe(false)
    expect(isPerformanceTier("")).toBe(false)
    expect(isPerformanceTier("HIGH")).toBe(false)
    expect(isPerformanceTier(0)).toBe(false)
    expect(isPerformanceTier({ tier: "high" })).toBe(false)
  })
})
