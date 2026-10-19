import { CATALOG_SCHEMA_VERSION, type CatalogSnapshot } from "@cognia/provider-types/model-catalog"
import { InMemoryCatalogRepository } from "./catalog-repository"
import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"
import { buildCatalogSnapshotFromModelsDev } from "./models-dev"

function revision(
  id: string,
  options: {
    lifecycle?: "active" | "deprecated"
    tier?: "certified" | "verified" | "experimental"
  } = {}
): CatalogSnapshot {
  const lifecycle = options.lifecycle ?? "active"
  const tier = options.tier ?? "certified"
  return {
    revision: {
      id,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: "2026-07-31T00:00:00.000Z",
      sources: [{ kind: "bundled", id }],
      checksum: `sha256:${id}`,
      integrity: "verified",
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        tier,
        source: { kind: "bundled", id },
        modalities: ["language"],
        adapterFamilies: ["openai-compatible"],
        connectionSchema: { fields: [] },
      },
    ],
    models: [
      {
        id: "openai:gpt-test",
        name: "GPT Test",
        creator: "openai",
        family: "gpt",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { streaming: true, tools: true },
        limits: { context: 128_000 },
        lifecycle,
        provenance: {},
      },
    ],
    offerings: [
      {
        id: "openai:gpt-test",
        providerRef: "openai",
        modelRef: "openai:gpt-test",
        upstreamId: "gpt-test",
        endpointType: "responses",
        lifecycle,
        available: true,
        source: { kind: "bundled", id },
      },
    ],
    aliases: [
      {
        id: "legacy:gpt-test-preview",
        kind: "legacy",
        target: { type: "offering", ref: "openai:gpt-test" },
        replacementRef: "openai:gpt-test",
      },
    ],
  }
}

describe("InMemoryCatalogRepository", () => {
  it("applies provider-scoped retirement notices without retiring an active aggregator offering", () => {
    const snapshot = buildCatalogSnapshotFromModelsDev(
      {
        openrouter: {
          id: "openrouter",
          models: {
            "deepseek/deepseek-chat": {
              id: "deepseek/deepseek-chat",
              name: "DeepSeek Chat",
              status: "active",
            },
          },
        },
      },
      {
        revisionId: "mixed-governance",
        generatedAt: "2026-10-19T00:00:00.000Z",
        checksum: "test",
        builtInCatalog: getBuiltInProviderCatalog(),
        certifiedProviderIds: new Set(["deepseek", "openrouter"]),
      }
    )
    const repository = new InMemoryCatalogRepository(snapshot)
    expect(repository.getModel("deepseek:deepseek-chat")?.lifecycle).toBe("active")
    expect(repository.resolveOffering("deepseek", "deepseek-chat")).toMatchObject({
      lifecycle: "retired",
      available: false,
    })
    expect(repository.resolveOffering("openrouter", "deepseek/deepseek-chat")).toMatchObject({
      lifecycle: "active",
      available: true,
    })
    expect(
      repository
        .searchModels({ providerIds: ["deepseek"], lifecycle: ["retired"] })
        .some((result) =>
          result.offerings.some((offering) => offering.upstreamId === "deepseek-chat")
        )
    ).toBe(true)
  })
  it("finds a retired direct offering even while its shared canonical model remains active elsewhere", () => {
    const snapshot = revision("mixed")
    snapshot.providers.push({ ...snapshot.providers[0], id: "relay" })
    snapshot.offerings[0].lifecycle = "retired"
    snapshot.offerings[0].available = false
    snapshot.offerings.push({
      ...snapshot.offerings[0],
      id: "relay:gpt-test",
      providerRef: "relay",
      lifecycle: "active",
      available: true,
    })
    const repository = new InMemoryCatalogRepository(snapshot)
    expect(
      repository.searchModels({ providerIds: ["openai"], lifecycle: ["retired"] })
    ).toHaveLength(1)
    expect(
      repository.searchModels({ providerIds: ["openai"], lifecycle: ["active"] })
    ).toHaveLength(0)
    expect(repository.searchModels({ providerIds: ["relay"], lifecycle: ["active"] })).toHaveLength(
      1
    )
  })
  it("applies current bundled defaults to a cached catalog without mutating its historical snapshot", () => {
    const snapshot = buildCatalogSnapshotFromModelsDev(
      {},
      {
        revisionId: "cached-old-default",
        generatedAt: "2026-07-31T00:00:00.000Z",
        checksum: "test",
        builtInCatalog: getBuiltInProviderCatalog(),
        certifiedProviderIds: new Set(["deepseek"]),
      }
    )
    snapshot.models = snapshot.models.filter((model) => model.id !== "deepseek:deepseek-flash")
    snapshot.offerings = snapshot.offerings.filter(
      (offering) => offering.id !== "deepseek:deepseek-flash"
    )
    snapshot.aliases = snapshot.aliases.filter(
      (alias) => alias.replacementRef !== "deepseek:deepseek-flash"
    )
    const role = snapshot.aliases.find((alias) => alias.id === "role:deepseek:default")!
    role.target = { type: "offering", ref: "deepseek:deepseek-chat" }
    const original = JSON.stringify(snapshot)
    const repository = new InMemoryCatalogRepository(snapshot)
    expect(repository.resolveAlias("role:deepseek:default")?.offering.upstreamId).toBe(
      "deepseek-flash"
    )
    expect(
      repository
        .searchModels({ providerIds: ["deepseek"], lifecycle: ["retired"] })
        .some((result) =>
          result.offerings.some((offering) => offering.upstreamId === "deepseek-chat")
        )
    ).toBe(true)
    expect(repository.resolveOffering("deepseek", "deepseek-chat")?.upstreamId).toBe(
      "deepseek-chat"
    )
    expect(JSON.stringify(snapshot)).toBe(original)
  })
  it("stages, activates, and resolves offerings and aliases through one repository", async () => {
    const repository = new InMemoryCatalogRepository()
    await repository.stageRevision(revision("r1"))
    await repository.activateRevision("r1")

    expect(repository.resolveOffering("openai", "gpt-test")?.id).toBe("openai:gpt-test")
    expect(repository.resolveAlias("legacy:gpt-test-preview")).toEqual({
      aliasId: "legacy:gpt-test-preview",
      offering: expect.objectContaining({ id: "openai:gpt-test" }),
      replacementRef: "openai:gpt-test",
    })
  })

  it("filters search by tier, lifecycle, modality, and hard capability", async () => {
    const repository = new InMemoryCatalogRepository()
    await repository.stageRevision(revision("r1"))
    await repository.activateRevision("r1")

    expect(
      repository.searchModels({
        query: "gpt",
        tiers: ["certified"],
        lifecycle: ["active"],
        modalities: ["language"],
        capabilities: ["tools"],
      })
    ).toEqual([
      expect.objectContaining({
        model: expect.objectContaining({ id: "openai:gpt-test" }),
        offerings: [expect.objectContaining({ upstreamId: "gpt-test" })],
      }),
    ])

    expect(repository.searchModels({ tiers: ["experimental"] })).toEqual([])
  })

  it("keeps only active and previous revisions after activation", async () => {
    const repository = new InMemoryCatalogRepository()
    for (const id of ["r1", "r2", "r3"]) {
      await repository.stageRevision(revision(id))
      await repository.activateRevision(id)
    }

    expect(repository.getRevisionState()).toEqual({
      active: "r3",
      previous: "r2",
      staged: [],
    })
    await expect(repository.activateRevision("r1")).rejects.toThrow(
      'catalog revision "r1" is not staged'
    )
  })

  it("does not activate an invalid or unverified revision", async () => {
    const repository = new InMemoryCatalogRepository()
    const unverified = revision("bad")
    unverified.revision.integrity = "invalid"

    await expect(repository.stageRevision(unverified)).rejects.toThrow(
      'catalog revision "bad" failed validation'
    )
    expect(repository.getRevisionState().active).toBeUndefined()
  })

  it("adds and removes namespaced plugin offerings without allowing Certified overrides", async () => {
    const repository = new InMemoryCatalogRepository()
    await repository.stageRevision(revision("r1"))
    await repository.activateRevision("r1")

    const unregister = repository.registerContribution("plugin.weather", {
      providers: [
        {
          id: "plugin.weather:provider",
          name: "Weather Models",
          tier: "experimental",
          source: { kind: "plugin", id: "plugin.weather" },
          modalities: ["language"],
          adapterFamilies: ["openai-compatible"],
          connectionSchema: { fields: [] },
        },
      ],
      models: [],
      offerings: [
        {
          id: "plugin.weather:offering",
          providerRef: "plugin.weather:provider",
          modelRef: "openai:gpt-test",
          upstreamId: "weather-gpt",
          endpointType: "chat-completions",
          lifecycle: "active",
          available: true,
          source: { kind: "plugin", id: "plugin.weather" },
        },
      ],
    })

    expect(repository.resolveOffering("plugin.weather:provider", "weather-gpt")).toBeDefined()
    unregister()
    expect(repository.resolveOffering("plugin.weather:provider", "weather-gpt")).toBeUndefined()
    expect(() =>
      repository.registerContribution("plugin.weather", {
        providers: [
          {
            id: "plugin.weather:certified",
            name: "No",
            tier: "certified",
            source: { kind: "plugin", id: "plugin.weather" },
            modalities: ["language"],
            adapterFamilies: ["openai-compatible"],
            connectionSchema: { fields: [] },
          },
        ],
        models: [],
        offerings: [],
      })
    ).toThrow(/cannot declare certified/)
  })
})

describe("the modalities schema v2 added", () => {
  // `video`, `transcription` and `moderation` widened the enum in ADR-0163 and
  // this filter was never taught about them, so it returned `undefined` for
  // each. `undefined` is falsy at the call site, so a search for any of the
  // three quietly matched nothing at all rather than failing loudly.
  function v2Snapshot(): CatalogSnapshot {
    const base = revision("v2")
    return {
      ...base,
      models: [
        ...base.models,
        {
          id: "openai:sora-test",
          name: "Sora Test",
          creator: "openai",
          modalities: { input: ["text"], output: ["video"] },
          capabilities: {},
          lifecycle: "active",
          provenance: {},
        },
        {
          id: "openai:whisper-test",
          name: "Whisper Test",
          creator: "openai",
          modalities: { input: ["audio"], output: ["text"] },
          capabilities: {},
          lifecycle: "active",
          provenance: {},
        },
        {
          id: "openai:omni-moderation-test",
          name: "Omni Moderation Test",
          creator: "openai",
          modalities: { input: ["text"], output: ["text"] },
          capabilities: {},
          lifecycle: "active",
          provenance: {},
        },
      ],
      offerings: [
        ...base.offerings,
        {
          id: "openai:sora-test",
          providerRef: "openai",
          modelRef: "openai:sora-test",
          upstreamId: "sora-test",
          endpointType: "video",
          lifecycle: "active",
          available: true,
          source: { kind: "bundled", id: "v2" },
        },
        {
          id: "openai:whisper-test",
          providerRef: "openai",
          modelRef: "openai:whisper-test",
          upstreamId: "whisper-test",
          endpointType: "transcription",
          lifecycle: "active",
          available: true,
          source: { kind: "bundled", id: "v2" },
        },
        {
          id: "openai:omni-moderation-test",
          providerRef: "openai",
          modelRef: "openai:omni-moderation-test",
          upstreamId: "omni-moderation-test",
          endpointType: "moderation",
          lifecycle: "active",
          available: true,
          source: { kind: "bundled", id: "v2" },
        },
      ],
    }
  }

  async function loaded() {
    const repository = new InMemoryCatalogRepository()
    await repository.stageRevision(v2Snapshot())
    await repository.activateRevision("v2")
    return repository
  }

  const ids = (results: { model: { id: string } }[]) => results.map((result) => result.model.id)

  it("finds a video model instead of returning nothing", async () => {
    const repository = await loaded()
    expect(ids(repository.searchModels({ modalities: ["video"] }))).toEqual(["openai:sora-test"])
  })

  it("finds a transcription model without also claiming the text-only one", async () => {
    const repository = await loaded()
    expect(ids(repository.searchModels({ modalities: ["transcription"] }))).toEqual([
      "openai:whisper-test",
    ])
  })

  it("finds a moderation model, which only its offering can identify", async () => {
    // Nothing on the model definition distinguishes it from any other
    // text-in/text-out model, so the endpoint type is the entire signal.
    const repository = await loaded()
    expect(ids(repository.searchModels({ modalities: ["moderation"] }))).toEqual([
      "openai:omni-moderation-test",
    ])
  })

  it("does not let a speech-capable model answer for transcription", async () => {
    const repository = await loaded()
    const speech = repository.searchModels({ modalities: ["speech"] })
    expect(ids(speech)).toEqual(["openai:whisper-test"])
    expect(ids(repository.searchModels({ modalities: ["language"] }))).not.toContain(
      "openai:sora-test"
    )
  })

  it("leaves the modalities that already worked exactly as they were", async () => {
    const repository = await loaded()
    // Every text-emitting model still answers, the two new ones included.
    // Ordering is the search ranking's business, not this filter's.
    expect(ids(repository.searchModels({ modalities: ["language"] })).sort()).toEqual([
      "openai:gpt-test",
      "openai:omni-moderation-test",
      "openai:whisper-test",
    ])
  })
})
