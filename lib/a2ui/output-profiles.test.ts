import {
  getRichOutputProfile,
  listRichOutputProfiles,
  routeRichOutputProfile,
  type RichOutputRequestCategory,
} from "./output-profiles"

describe("rich output profile registry", () => {
  it("covers the supported routing matrix with canonical profiles", () => {
    const profiles = listRichOutputProfiles()

    expect(profiles.length).toBeGreaterThanOrEqual(20)
    expect(getRichOutputProfile("quick-factual-answer")?.outputType).toBe("plain-text")
    expect(getRichOutputProfile("quick-factual-answer")?.technology).toBe("none")
    expect(getRichOutputProfile("trends-over-time")?.outputType).toBe("chart")
    expect(getRichOutputProfile("trends-over-time")?.technology).toBe("chartjs")
    expect(getRichOutputProfile("design-a-ui")?.outputType).toBe("html")
    expect(getRichOutputProfile("design-a-ui")?.technology).toBe("html")
    expect(getRichOutputProfile("database-schema-erd")?.outputType).toBe("mermaid")
  })

  it("routes request categories to deterministic profiles", () => {
    const category: RichOutputRequestCategory = "how-it-works-physical"

    const result = routeRichOutputProfile(category)

    expect(result.profile.id).toBe("how-it-works-physical")
    expect(result.usedFallback).toBe(false)
  })

  it("falls back when an advanced runtime is disabled by rollout controls", () => {
    const result = routeRichOutputProfile("3d-visualization", {
      featureFlags: {
        enableAdvancedRichOutputProfiles: false,
      },
    })

    expect(result.profile.id).toBe("creative-decorative-art")
    expect(result.usedFallback).toBe(true)
    expect(result.reason).toBe("feature-disabled")
  })

  it("falls back to simple text when the caller prefers non-rich output", () => {
    const result = routeRichOutputProfile("network-graph", {
      preferSimpleOutput: true,
    })

    expect(result.profile.id).toBe("quick-factual-answer")
    expect(result.usedFallback).toBe(true)
    expect(result.reason).toBe("prefer-simple-output")
  })
})
