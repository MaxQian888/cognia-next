import type {
  CatalogSnapshot,
  DeploymentProfile,
  ProviderProfile,
  TransportProfile,
} from "@cognia/provider-types"

import { InMemoryCatalogRepository } from "./catalog-repository"
import { resolveCatalogRuntimeTarget } from "./catalog-runtime-resolver"

const providerProfile: ProviderProfile = {
  id: "profile:openai",
  displayName: "OpenAI",
  deploymentRefs: ["deployment:openai"],
}

const deployment: DeploymentProfile = {
  id: "deployment:openai",
  providerRef: "openai",
  endpoint: "https://api.openai.com/v1",
  transportProfileRef: "transport:openai",
  models: [
    {
      id: "gpt-test",
      upstreamId: "gpt-test",
      offeringRef: "offering:openai:gpt-test",
      canonicalModelRef: "model:gpt-test",
    },
  ],
  enabled: true,
}

const transport: TransportProfile = {
  id: "transport:openai",
  protocol: "openai",
  auth: { scheme: "bearer" },
}

function snapshot(tier: "certified" | "verified" | "experimental" = "certified"): CatalogSnapshot {
  return {
    revision: {
      id: `revision:${tier}`,
      schemaVersion: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      sources: [{ kind: "bundled", id: "test" }],
      checksum: `checksum:${tier}`,
      integrity: "verified",
    },
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        tier,
        source: { kind: "bundled", id: "test" },
        modalities: ["language"],
        adapterFamilies: ["openai-compatible"],
        connectionSchema: { fields: [] },
      },
    ],
    models: [
      {
        id: "model:gpt-test",
        name: "GPT Test",
        creator: "openai",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: { streaming: true, tools: true },
        lifecycle: "active",
        provenance: {},
      },
    ],
    offerings: [
      {
        id: "offering:openai:gpt-test",
        providerRef: "openai",
        modelRef: "model:gpt-test",
        upstreamId: "gpt-test",
        endpointType: "responses",
        lifecycle: "active",
        available: true,
        source: { kind: "bundled", id: "test" },
      },
    ],
    aliases: [],
  }
}

async function repository(
  tier: "certified" | "verified" | "experimental" = "certified"
): Promise<InMemoryCatalogRepository> {
  const result = new InMemoryCatalogRepository()
  const catalog = snapshot(tier)
  await result.stageRevision(catalog)
  await result.activateRevision(catalog.revision.id)
  return result
}

describe("resolveCatalogRuntimeTarget", () => {
  it("resolves the frozen routed id and adapter without network access", async () => {
    const resolved = resolveCatalogRuntimeTarget({
      providerProfile,
      deployment,
      transport,
      modelId: "gpt-test",
      purpose: "new",
      requiredCapabilities: ["tools"],
      repository: await repository(),
    })

    expect(resolved).toMatchObject({
      upstreamId: "gpt-test",
      adapterFamily: "openai-compatible",
      offering: { id: "offering:openai:gpt-test" },
      model: { id: "model:gpt-test" },
    })
  })

  it("fails closed when a required hard capability is unknown", async () => {
    const catalog = await repository()
    expect(() =>
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "new",
        requiredCapabilities: ["reasoning"],
        repository: catalog,
      })
    ).toThrow(expect.objectContaining({ code: "capability_unavailable" }))
  })

  it("only admits Verified providers into auto routing through explicit policy", async () => {
    const catalog = await repository("verified")
    const base = {
      providerProfile,
      deployment,
      transport,
      modelId: "gpt-test",
      purpose: "auto" as const,
      repository: catalog,
    }

    expect(() => resolveCatalogRuntimeTarget(base)).toThrow(
      expect.objectContaining({ code: "tier_not_allowed" })
    )
    expect(resolveCatalogRuntimeTarget({ ...base, allowVerifiedAuto: true }).offering.id).toBe(
      "offering:openai:gpt-test"
    )
  })

  it("requires explicit confirmation for Experimental providers", async () => {
    const catalog = await repository("experimental")
    const base = {
      providerProfile,
      deployment,
      transport,
      modelId: "gpt-test",
      purpose: "new" as const,
      repository: catalog,
    }

    expect(() => resolveCatalogRuntimeTarget(base)).toThrow(
      expect.objectContaining({ code: "experimental_confirmation_required" })
    )
    expect(
      resolveCatalogRuntimeTarget({ ...base, experimentalConfirmed: true }).provider.tier
    ).toBe("experimental")
  })

  it("keeps deprecated offerings resolvable only for historical configurations", async () => {
    const catalogSnapshot = snapshot()
    catalogSnapshot.models[0].lifecycle = "deprecated"
    catalogSnapshot.offerings[0].lifecycle = "deprecated"
    const catalog = new InMemoryCatalogRepository()
    await catalog.stageRevision(catalogSnapshot)
    await catalog.activateRevision(catalogSnapshot.revision.id)
    const base = {
      providerProfile,
      deployment,
      transport,
      modelId: "gpt-test",
      repository: catalog,
    }

    expect(() => resolveCatalogRuntimeTarget({ ...base, purpose: "new" })).toThrow(
      expect.objectContaining({ code: "lifecycle_not_allowed" })
    )
    expect(resolveCatalogRuntimeTarget({ ...base, purpose: "historical" }).upstreamId).toBe(
      "gpt-test"
    )
  })

  it.each([
    {
      code: "deployment_not_owned",
      override: { providerProfile: { ...providerProfile, deploymentRefs: [] } },
    },
    {
      code: "deployment_disabled",
      override: { deployment: { ...deployment, enabled: false } },
    },
    {
      code: "transport_mismatch",
      override: { transport: { ...transport, id: "transport:other" } },
    },
    {
      code: "model_not_configured",
      override: { modelId: "missing" },
    },
    {
      code: "model_not_configured",
      override: {
        deployment: {
          ...deployment,
          models: [
            {
              ...deployment.models[0],
              userOverride: { enabled: false },
            },
          ],
        },
      },
    },
    {
      code: "offering_not_found",
      override: {
        deployment: {
          ...deployment,
          models: [{ id: "unmapped", upstreamId: "unmapped" }],
        },
        modelId: "unmapped",
      },
    },
  ])("rejects an invalid configured connection with $code", async ({ code, override }) => {
    const catalog = await repository()
    expect(() =>
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "new",
        repository: catalog,
        ...override,
      })
    ).toThrow(expect.objectContaining({ code }))
  })

  it.each(["http://localhost:1234", "http://169.254.169.254", "not a URL"])(
    "rejects an unsafe endpoint supplied by a remote catalog: %s",
    async (endpoint) => {
      const catalog = await repository()
      expect(() =>
        resolveCatalogRuntimeTarget({
          providerProfile,
          deployment: { ...deployment, endpoint },
          transport,
          modelId: "gpt-test",
          purpose: "new",
          endpointSource: "remote-catalog",
          repository: catalog,
        })
      ).toThrow(expect.objectContaining({ code: "unsafe_catalog_endpoint" }))
    }
  )

  it("allows a public remote endpoint and applies the data policy", async () => {
    const catalog = await repository()
    const dataPolicyAllows = jest.fn(() => true)

    expect(
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "new",
        endpointSource: "remote-catalog",
        dataPolicyAllows,
        repository: catalog,
      }).upstreamId
    ).toBe("gpt-test")
    expect(dataPolicyAllows).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ id: "openai" }),
        model: expect.objectContaining({ id: "model:gpt-test" }),
        offering: expect.objectContaining({ id: "offering:openai:gpt-test" }),
      })
    )

    expect(() =>
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "new",
        dataPolicyAllows: () => false,
        repository: catalog,
      })
    ).toThrow(expect.objectContaining({ code: "data_policy_rejected" }))
  })

  it("allows unavailable offerings only for historical resolution", async () => {
    const catalogSnapshot = snapshot()
    catalogSnapshot.offerings[0].available = false
    const catalog = new InMemoryCatalogRepository()
    await catalog.stageRevision(catalogSnapshot)
    await catalog.activateRevision(catalogSnapshot.revision.id)

    expect(() =>
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "new",
        repository: catalog,
      })
    ).toThrow(expect.objectContaining({ code: "offering_unavailable" }))
    expect(
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "historical",
        repository: catalog,
      }).upstreamId
    ).toBe("gpt-test")
  })

  it("rejects transports outside a provider's adapter allowlist", async () => {
    const catalogSnapshot = snapshot()
    catalogSnapshot.providers[0].adapterFamilies = ["anthropic", "gemini"]
    const catalog = new InMemoryCatalogRepository()
    await catalog.stageRevision(catalogSnapshot)
    await catalog.activateRevision(catalogSnapshot.revision.id)

    expect(() =>
      resolveCatalogRuntimeTarget({
        providerProfile,
        deployment,
        transport,
        modelId: "gpt-test",
        purpose: "new",
        repository: catalog,
      })
    ).toThrow(expect.objectContaining({ code: "adapter_not_allowed" }))
  })
})
