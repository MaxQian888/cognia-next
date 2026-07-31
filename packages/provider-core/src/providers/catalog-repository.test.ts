import { CATALOG_SCHEMA_VERSION, type CatalogSnapshot } from "@cognia/provider-types/model-catalog"
import { InMemoryCatalogRepository } from "./catalog-repository"

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
