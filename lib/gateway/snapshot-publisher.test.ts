import {
  buildGatewaySnapshot,
  enrichSnapshotWithSubscriptionCreds,
  type SnapshotSettingsSlice,
} from "./snapshot-publisher"
import type { GatewayRoutingSnapshot } from "@/types/gateway"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"

const mapping = (
  alias: string,
  providers: ModelMapping["providers"],
  enabled = true
): ModelMapping => ({
  id: `m-${alias}`,
  alias,
  providers,
  distribution: "priority",
  enabled,
  createdAt: 1,
  updatedAt: 1,
})

describe("buildGatewaySnapshot", () => {
  it("stamps the injected timestamp", () => {
    expect(buildGatewaySnapshot({}, 999).generatedAtMs).toBe(999)
  })

  it("omits version/authority for legacy pushes (no profile meta)", () => {
    const snap = buildGatewaySnapshot({}, 1)
    expect(snap.profileVersion).toBeUndefined()
    expect(snap.authority).toBeUndefined()
  })

  it("stamps profileVersion + renderer authority and joins deployment/transport (ADR-0090)", () => {
    const slice: SnapshotSettingsSlice = {
      providerSettings: {
        openai: { providerId: "openai", apiKey: "sk-o", enabled: true },
      } as unknown as SnapshotSettingsSlice["providerSettings"],
    }
    const snap = buildGatewaySnapshot(slice, 1, {
      profileVersion: 7,
      byLegacyId: {
        openai: {
          deploymentId: "openai",
          models: {},
          transport: {
            authScheme: "bearer",
            staticHeaders: [["x-tenant", "t1"]],
          },
        },
      },
    })
    expect(snap.profileVersion).toBe(7)
    expect(snap.authority).toBe("renderer")
    const openai = snap.providers.find((p) => p.id === "openai")
    expect(openai?.deploymentId).toBe("openai")
    expect(openai?.transport).toEqual({
      authScheme: "bearer",
      staticHeaders: [["x-tenant", "t1"]],
    })
    // Providers without a derived row stay untouched.
    expect(snap.providers.filter((p) => p.id !== "openai").every((p) => !p.deploymentId)).toBe(true)
  })

  it("resolves enabled built-in providers with protocol + key + baseURL", () => {
    const slice: SnapshotSettingsSlice = {
      providerSettings: {
        openai: { providerId: "openai", apiKey: "sk-o", enabled: true },
      } as unknown as SnapshotSettingsSlice["providerSettings"],
    }
    const snap = buildGatewaySnapshot(slice, 1)
    const openai = snap.providers.find((p) => p.id === "openai")
    expect(openai).toMatchObject({ protocol: "openai", apiKey: "sk-o", enabled: true })
  })

  it("emits an unresolved provider as enabled:false (UI can still see it)", () => {
    const slice: SnapshotSettingsSlice = {
      // referenced by an alias but never configured → no key/baseURL
      modelMappings: [mapping("fast", [{ providerId: "ghost", modelId: "m" }])],
    }
    const snap = buildGatewaySnapshot(slice, 1)
    const ghost = snap.providers.find((p) => p.id === "ghost")
    expect(ghost).toMatchObject({ id: "ghost", enabled: false })
  })

  it("carries custom-provider protocol + models", () => {
    const slice: SnapshotSettingsSlice = {
      customProviders: [
        {
          id: "acme",
          isCustom: true,
          apiProtocol: "openai",
          baseURL: "https://acme.dev/v1",
          apiKey: "sk-a",
          customModels: ["acme-1", "acme-2"],
        },
      ] as unknown as SnapshotSettingsSlice["customProviders"],
    }
    const snap = buildGatewaySnapshot(slice, 1)
    const acme = snap.providers.find((p) => p.id === "acme")
    expect(acme).toMatchObject({
      protocol: "openai",
      baseUrl: "https://acme.dev/v1",
      apiKey: "sk-a",
      enabled: true,
    })
    expect(acme?.models).toEqual(["acme-1", "acme-2"])
  })

  it("publishes only enabled aliases, preserving entry order", () => {
    const slice: SnapshotSettingsSlice = {
      modelMappings: [
        mapping("fast", [
          { providerId: "groq", modelId: "llama" },
          { providerId: "openai", modelId: "gpt-4o-mini" },
        ]),
        mapping("off", [{ providerId: "x", modelId: "y" }], false),
        mapping("empty", []),
      ],
    }
    const snap = buildGatewaySnapshot(slice, 1)
    expect(snap.aliases.map((a) => a.alias)).toEqual(["fast"])
    expect(snap.aliases[0].entries.map((e) => e.providerId)).toEqual(["groq", "openai"])
  })

  it("publishes V2 alias distribution and the local auto-routing policy", () => {
    const weighted = mapping("balanced", [
      { providerId: "groq", modelId: "llama", weight: 3 },
      { providerId: "openai", modelId: "gpt-4o-mini", weight: 1 },
    ])
    weighted.distribution = "weighted"
    const snap = buildGatewaySnapshot(
      {
        modelMappings: [weighted],
        routingConfig: {
          strategy: "least-busy",
          maxFallbackAttempts: 4,
        },
      },
      42
    )

    expect(snap.routingPolicy).toMatchObject({
      schemaVersion: 2,
      policyRevision: "42",
      auto: { modelId: "auto", strategy: "least-busy" },
      maxFallbackAttempts: 4,
    })
    expect(snap.aliases[0]).toMatchObject({
      distribution: "weighted",
      entries: [
        { providerId: "groq", modelId: "llama", weight: 3 },
        { providerId: "openai", modelId: "gpt-4o-mini", weight: 1 },
      ],
    })
  })

  it("projects deployment availability and capabilities into routing entries", () => {
    const snap = buildGatewaySnapshot(
      { modelMappings: [mapping("vision", [{ providerId: "openai", modelId: "gpt-v" }])] },
      7,
      {
        profileVersion: 7,
        byLegacyId: {
          openai: {
            deploymentId: "deployment-openai",
            enabled: true,
            region: "local",
            models: {
              "gpt-v": { tools: true, vision: true, streaming: true, contextTokens: 128_000 },
            },
          },
        },
      }
    )

    expect(snap.aliases[0].entries[0]).toMatchObject({
      deploymentId: "deployment-openai",
      available: true,
      locality: "local",
      capabilities: { tools: true, vision: true, streaming: true, contextTokens: 128_000 },
    })
  })

  it("degrades unsupported strategies explicitly to reliability", () => {
    const snap = buildGatewaySnapshot(
      {
        modelMappings: [mapping("fast", [{ providerId: "groq", modelId: "llama" }])],
        routingConfig: { strategy: "plugin:private-selector" },
      },
      9
    )

    expect(snap.routingPolicy?.auto).toMatchObject({
      strategy: "reliability",
      strategyUnavailable: "plugin:private-selector",
    })
  })

  it("dedupes provider ids referenced by aliases and settings", () => {
    const slice: SnapshotSettingsSlice = {
      providerSettings: {
        openai: { providerId: "openai", apiKey: "k", enabled: true },
      } as unknown as SnapshotSettingsSlice["providerSettings"],
      modelMappings: [mapping("a", [{ providerId: "openai", modelId: "gpt-4o" }])],
    }
    const snap = buildGatewaySnapshot(slice, 1)
    expect(snap.providers.filter((p) => p.id === "openai")).toHaveLength(1)
  })

  it("carries the upstream key pool + strategy when rotation is enabled", () => {
    const slice: SnapshotSettingsSlice = {
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-primary",
          enabled: true,
          apiKeys: ["sk-a", " sk-b ", "", "sk-a"], // blanks + dupes are cleaned
          apiKeyRotationEnabled: true,
          apiKeyRotationStrategy: "least-used",
        },
      } as unknown as SnapshotSettingsSlice["providerSettings"],
    }
    const openai = buildGatewaySnapshot(slice, 1).providers.find((p) => p.id === "openai")
    expect(openai).toMatchObject({
      apiKey: "sk-primary",
      apiKeys: ["sk-a", "sk-b"],
      rotationEnabled: true,
      rotationStrategy: "least-used",
    })
  })

  it("omits the pool when rotation is disabled", () => {
    const slice: SnapshotSettingsSlice = {
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-primary",
          enabled: true,
          apiKeys: ["sk-a", "sk-b"],
          apiKeyRotationEnabled: false,
        },
      } as unknown as SnapshotSettingsSlice["providerSettings"],
    }
    const openai = buildGatewaySnapshot(slice, 1).providers.find((p) => p.id === "openai")
    expect(openai?.apiKeys).toBeUndefined()
    expect(openai?.rotationEnabled).toBeUndefined()
  })

  it("resolves a provider configured with only a rotation pool (blank primary key)", () => {
    const slice: SnapshotSettingsSlice = {
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "",
          enabled: true,
          apiKeys: ["sk-pool-1", "sk-pool-2"],
          apiKeyRotationEnabled: true,
        },
      } as unknown as SnapshotSettingsSlice["providerSettings"],
    }
    const openai = buildGatewaySnapshot(slice, 1).providers.find((p) => p.id === "openai")
    // pool[0] stands in as the resolver's single key → provider becomes usable.
    expect(openai).toMatchObject({ enabled: true, apiKey: "sk-pool-1" })
    expect(openai?.apiKeys).toEqual(["sk-pool-1", "sk-pool-2"])
  })
})

describe("enrichSnapshotWithSubscriptionCreds", () => {
  const snap = (providers: GatewayRoutingSnapshot["providers"]): GatewayRoutingSnapshot => ({
    providers,
    aliases: [],
    generatedAtMs: 1,
  })

  it("fills a keyless provider from the vault", async () => {
    const out = await enrichSnapshotWithSubscriptionCreds(
      snap([{ id: "opencode", protocol: "openai", baseUrl: "", enabled: false, models: [] }]),
      ["opencode"],
      async (id) => (id === "opencode" ? { apiKey: "sk-zen", baseURL: "https://zen/v1" } : null)
    )
    expect(out.providers[0]).toMatchObject({
      id: "opencode",
      apiKey: "sk-zen",
      baseUrl: "https://zen/v1",
      enabled: true,
    })
  })

  it("appends a probed provider absent from the base snapshot", async () => {
    const out = await enrichSnapshotWithSubscriptionCreds(snap([]), ["opencode-go"], async () => ({
      apiKey: "sk-go",
      baseURL: "https://go/v1",
    }))
    expect(out.providers).toHaveLength(1)
    expect(out.providers[0]).toMatchObject({
      id: "opencode-go",
      protocol: "openai",
      apiKey: "sk-go",
    })
  })

  it("never clobbers an explicitly configured key", async () => {
    const out = await enrichSnapshotWithSubscriptionCreds(
      snap([
        {
          id: "openai",
          protocol: "openai",
          baseUrl: "u",
          apiKey: "sk-real",
          enabled: true,
          models: [],
        },
      ]),
      [],
      async () => ({ apiKey: "sk-vault", baseURL: "v" })
    )
    expect(out.providers[0].apiKey).toBe("sk-real")
  })

  it("leaves the snapshot unchanged when the resolver returns null", async () => {
    const base = snap([
      { id: "groq", protocol: "openai", baseUrl: "u", apiKey: "k", enabled: true, models: [] },
    ])
    const out = await enrichSnapshotWithSubscriptionCreds(base, ["opencode"], async () => null)
    expect(out.providers).toEqual(base.providers)
  })

  it("tolerates a throwing resolver", async () => {
    const out = await enrichSnapshotWithSubscriptionCreds(
      snap([{ id: "opencode", protocol: "openai", baseUrl: "", enabled: false, models: [] }]),
      ["opencode"],
      async () => {
        throw new Error("vault locked")
      }
    )
    expect(out.providers[0].enabled).toBe(false)
  })
})
