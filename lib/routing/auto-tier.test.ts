import { pickAutoAlias } from "./auto-tier"
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"
import type { AutoRoutingSettings } from "@/types/routing/tool-route"

const settings = (over: Partial<AutoRoutingSettings> = {}): AutoRoutingSettings => ({
  ...DEFAULT_AUTO_ROUTING,
  ...over,
})

const all = new Set(["fast", "balanced", "powerful"])

describe("pickAutoAlias", () => {
  it("maps low scores to the low tier", () => {
    expect(pickAutoAlias(0, settings(), all)).toBe("fast")
    expect(pickAutoAlias(0.33, settings(), all)).toBe("fast")
  })

  it("maps mid scores to the mid tier", () => {
    // thresholds default balanced=0.34, powerful=0.67
    expect(pickAutoAlias(0.34, settings(), all)).toBe("balanced")
    expect(pickAutoAlias(0.66, settings(), all)).toBe("balanced")
  })

  it("maps high scores to the top tier", () => {
    expect(pickAutoAlias(0.67, settings(), all)).toBe("powerful")
    expect(pickAutoAlias(1, settings(), all)).toBe("powerful")
  })

  it("degrades DOWN to the nearest cheaper enabled tier when the target is absent", () => {
    // High score wants "powerful" but only fast+balanced enabled → balanced.
    expect(pickAutoAlias(0.9, settings(), new Set(["fast", "balanced"]))).toBe("balanced")
    // Mid score wants "balanced" but only fast enabled → fast.
    expect(pickAutoAlias(0.5, settings(), new Set(["fast"]))).toBe("fast")
  })

  it("climbs UP to the cheapest enabled tier when nothing at/below the target exists", () => {
    // Low score wants "fast" but only powerful enabled → powerful (still routes).
    expect(pickAutoAlias(0, settings(), new Set(["powerful"]))).toBe("powerful")
    // Low score, only balanced+powerful → balanced (cheapest above).
    expect(pickAutoAlias(0, settings(), new Set(["balanced", "powerful"]))).toBe("balanced")
  })

  it("returns undefined when no candidate alias is enabled", () => {
    expect(pickAutoAlias(0.5, settings(), new Set())).toBeUndefined()
    expect(pickAutoAlias(0.5, settings(), new Set(["reasoning", "coding"]))).toBeUndefined()
  })

  it("returns undefined when the candidate ladder is empty", () => {
    expect(pickAutoAlias(0.5, settings({ candidateAliases: [] }), all)).toBeUndefined()
  })

  it("matches aliases case-insensitively", () => {
    expect(pickAutoAlias(0, settings({ candidateAliases: ["Fast", "Balanced"] }), all)).toBe("fast")
  })

  it("honors custom thresholds", () => {
    const s = settings({ thresholds: { balanced: 0.5, powerful: 0.9 } })
    expect(pickAutoAlias(0.49, s, all)).toBe("fast")
    expect(pickAutoAlias(0.5, s, all)).toBe("balanced")
    expect(pickAutoAlias(0.89, s, all)).toBe("balanced")
    expect(pickAutoAlias(0.9, s, all)).toBe("powerful")
  })

  it("clamps a two-tier ladder without dead-ending on the mid rung", () => {
    // Only [fast, powerful]; mid score targets index min(1, len-1)=1 → powerful.
    const s = settings({ candidateAliases: ["fast", "powerful"] })
    expect(pickAutoAlias(0.5, s, new Set(["fast", "powerful"]))).toBe("powerful")
    expect(pickAutoAlias(0, s, new Set(["fast", "powerful"]))).toBe("fast")
  })
})
