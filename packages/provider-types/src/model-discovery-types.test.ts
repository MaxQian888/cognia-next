import {
  PROVIDER_MODEL_FRESHNESS,
  PROVIDER_MODEL_SOURCES,
  type ProviderModelCandidate,
  type ProviderModelFreshness,
  type ProviderModelSource,
} from "./model-discovery-types"

describe("model discovery vocabulary", () => {
  it("keeps the four sources and three freshness states", () => {
    expect(PROVIDER_MODEL_SOURCES).toEqual([
      "catalog-static",
      "models-dev",
      "remote-discovered",
      "user-curated",
    ])
    expect(PROVIDER_MODEL_FRESHNESS).toEqual(["static", "fresh", "stale"])
  })

  it("derives the unions from the constants", () => {
    const source: ProviderModelSource = "remote-discovered"
    const freshness: ProviderModelFreshness = "stale"
    const candidate: ProviderModelCandidate = { id: "m1", name: "Model One" }
    expect(source).toBe("remote-discovered")
    expect(freshness).toBe("stale")
    expect(candidate.id).toBe("m1")
  })
})
