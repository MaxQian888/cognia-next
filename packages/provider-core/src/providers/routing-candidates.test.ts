import type { CatalogSnapshot } from "@cognia/provider-types/model-catalog"
import { InMemoryCatalogRepository } from "./catalog-repository"
import { ROUTING_CANDIDATE_SET_VERSION, listRoutingCandidates } from "./routing-candidates"

async function repository(): Promise<InMemoryCatalogRepository> {
  const repo = new InMemoryCatalogRepository()
  const snapshot: CatalogSnapshot = {
    revision: {
      id: "routing",
      schemaVersion: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      sources: [{ kind: "bundled", id: "test" }],
      checksum: "sha256:test",
      integrity: "verified",
    },
    providers: [
      {
        id: "certified",
        name: "Certified",
        tier: "certified",
        source: { kind: "bundled", id: "test" },
        modalities: ["language"],
        adapterFamilies: ["openai-compatible"],
        connectionSchema: { fields: [] },
      },
      {
        id: "experimental",
        name: "Experimental",
        tier: "experimental",
        source: { kind: "models-dev", id: "test" },
        modalities: ["language"],
        adapterFamilies: ["openai-compatible"],
        connectionSchema: { fields: [] },
      },
    ],
    models: [
      {
        id: "creator:fast",
        name: "Fast",
        creator: "creator",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { streaming: true, tools: true },
        lifecycle: "active",
        provenance: {},
      },
      {
        id: "creator:reason",
        name: "Reason",
        creator: "creator",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { streaming: true, tools: true, reasoning: true },
        lifecycle: "active",
        provenance: {},
      },
    ],
    offerings: [
      {
        id: "certified:fast",
        providerRef: "certified",
        deploymentRef: "certified-main",
        modelRef: "creator:fast",
        upstreamId: "fast-v1",
        endpointType: "chat-completions",
        lifecycle: "active",
        available: true,
        pricing: { currency: "USD", inputPer1M: 0.1, outputPer1M: 0.2 },
        source: { kind: "bundled", id: "test" },
      },
      {
        id: "certified:reason",
        providerRef: "certified",
        deploymentRef: "certified-main",
        modelRef: "creator:reason",
        upstreamId: "reason-v1",
        endpointType: "chat-completions",
        lifecycle: "active",
        available: true,
        pricing: { currency: "USD", inputPer1M: 2, outputPer1M: 4 },
        source: { kind: "bundled", id: "test" },
      },
      {
        id: "experimental:reason",
        providerRef: "experimental",
        deploymentRef: "experimental",
        modelRef: "creator:reason",
        upstreamId: "reason-v1",
        endpointType: "chat-completions",
        lifecycle: "active",
        available: true,
        source: { kind: "models-dev", id: "test" },
      },
    ],
    aliases: [],
  }
  await repo.stageRevision(snapshot)
  await repo.activateRevision("routing")
  return repo
}

describe("versioned routing candidates", () => {
  it("uses capability policies instead of production model ids", () => {
    expect(ROUTING_CANDIDATE_SET_VERSION).toBe("2026-07-31")
  })

  it("selects active Certified offerings and fail-closes missing hard capabilities", async () => {
    const repo = await repository()

    expect(listRoutingCandidates(repo, "reasoning", new Set(["certified-main"]))).toEqual([
      {
        providerId: "certified-main",
        modelId: "reason-v1",
      },
    ])
    expect(listRoutingCandidates(repo, "fast", new Set(["certified-main"]))[0]).toEqual({
      providerId: "certified-main",
      modelId: "fast-v1",
    })
  })

  it("keeps Experimental out of automatic candidates even when enabled", async () => {
    const repo = await repository()

    expect(
      listRoutingCandidates(repo, "reasoning", new Set(["certified-main", "experimental"]))
    ).toHaveLength(1)
  })

  it("uses the quality ordering for balanced and capability-specific roles", async () => {
    const repo = await repository()

    expect(listRoutingCandidates(repo, "balanced", new Set(["certified-main"]))[0]).toEqual({
      providerId: "certified-main",
      modelId: "reason-v1",
    })
    expect(listRoutingCandidates(repo, "coding", new Set(["certified-main"]))).toHaveLength(2)
    expect(listRoutingCandidates(repo, "powerful", new Set(["certified-main"]))).toEqual([
      { providerId: "certified-main", modelId: "reason-v1" },
    ])
  })

  it("returns no candidates when the offering deployment is disabled", async () => {
    const repo = await repository()

    expect(listRoutingCandidates(repo, "fast", new Set())).toEqual([])
  })
})
