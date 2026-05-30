import {
  buildProviderModelDiscoverySnapshot,
  buildBuiltInProviderModelDiscoverySnapshot,
  type ProviderModelCandidate,
  type ProviderModelDiscoverySnapshot,
} from "./model-discovery"

function byId(snapshot: ProviderModelDiscoverySnapshot, id: string) {
  return snapshot.models.find((m) => m.id === id)
}

describe("buildProviderModelDiscoverySnapshot — layered authority", () => {
  it("models.dev overwrites static model-level fields", () => {
    const catalogModels: ProviderModelCandidate[] = [
      { id: "m1", name: "M1 (static)", contextLength: 8000, supportsVision: false },
    ]
    const modelsDevModels: ProviderModelCandidate[] = [
      {
        id: "m1",
        name: "M1 (models.dev)",
        contextLength: 200000,
        supportsVision: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
    ]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      catalogModels,
      modelsDevModels,
    })
    const m1 = byId(snap, "m1")!
    expect(m1.contextLength).toBe(200000)
    expect(m1.supportsVision).toBe(true)
    expect(m1.name).toBe("M1 (models.dev)")
    expect(m1.pricing).toMatchObject({ promptPer1M: 3, completionPer1M: 15 })
    expect(m1.mergedSources).toEqual(["catalog-static", "models-dev"])
  })

  it("remote-discovered does NOT clobber models.dev pricing/capabilities", () => {
    const modelsDevModels: ProviderModelCandidate[] = [
      {
        id: "m1",
        name: "M1",
        contextLength: 200000,
        supportsVision: true,
        pricing: { promptPer1M: 3, completionPer1M: 15 },
      },
    ]
    // Bare /v1/models entry: no pricing, no real context, vision unknown.
    const remoteModels: ProviderModelCandidate[] = [{ id: "m1", name: "m1" }]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels,
      remoteModels,
      remoteLastFetchedAt: 123,
    })
    const m1 = byId(snap, "m1")!
    // pricing + capabilities survive the bare remote entry
    expect(m1.pricing).toMatchObject({ promptPer1M: 3, completionPer1M: 15 })
    expect(m1.contextLength).toBe(200000)
    expect(m1.supportsVision).toBe(true)
    expect(m1.mergedSources).toEqual(["models-dev", "remote-discovered"])
  })

  it("does NOT downgrade a models.dev model's source/freshness when the live list also has it", () => {
    const modelsDevModels: ProviderModelCandidate[] = [
      { id: "m1", contextLength: 200000, pricing: { promptPer1M: 3, completionPer1M: 15 } },
    ]
    const remoteModels: ProviderModelCandidate[] = [{ id: "m1", name: "m1" }]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels,
      remoteModels,
      remoteLastFetchedAt: 123,
    })
    const m1 = byId(snap, "m1")!
    // Provenance stays models-dev (the higher-authority source); only the
    // mergedSources audit trail records the additional remote contribution.
    expect(m1.source).toBe("models-dev")
    expect(m1.mergedSources).toEqual(["models-dev", "remote-discovered"])
  })

  it("remote-discovered still contributes brand-new model ids", () => {
    const modelsDevModels: ProviderModelCandidate[] = [{ id: "m1" }]
    const remoteModels: ProviderModelCandidate[] = [{ id: "m2-new" }]
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels,
      remoteModels,
    })
    expect(byId(snap, "m2-new")).toBeDefined()
    expect(byId(snap, "m2-new")!.source).toBe("remote-discovered")
  })

  it("user-curated takes precedence over everything", () => {
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels: [{ id: "m1", name: "from models.dev", contextLength: 200000 }],
      userCuratedModels: [{ id: "m1", name: "user override", contextLength: 99 }],
    })
    const m1 = byId(snap, "m1")!
    expect(m1.name).toBe("user override")
    expect(m1.contextLength).toBe(99)
  })

  it("merges cache pricing fields without dropping models.dev values", () => {
    const snap = buildProviderModelDiscoverySnapshot({
      providerId: "p",
      modelsDevModels: [
        {
          id: "m1",
          pricing: { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 },
        },
      ],
      remoteModels: [{ id: "m1" }],
    })
    expect(byId(snap, "m1")!.pricing).toMatchObject({
      promptPer1M: 3,
      completionPer1M: 15,
      cachedInputPer1M: 0.3,
    })
  })
})

describe("buildBuiltInProviderModelDiscoverySnapshot", () => {
  it("threads models.dev models into the merge", () => {
    const snap = buildBuiltInProviderModelDiscoverySnapshot({
      providerId: "anthropic",
      catalogModels: [{ id: "m1", contextLength: 8000 }],
      modelsDevModels: [{ id: "m1", contextLength: 200000 }],
      settings: { discoveredModels: [{ id: "m2" }], discoveredModelsLastFetched: 5 },
    })
    expect(byId(snap, "m1")!.contextLength).toBe(200000)
    expect(byId(snap, "m2")).toBeDefined()
  })
})
