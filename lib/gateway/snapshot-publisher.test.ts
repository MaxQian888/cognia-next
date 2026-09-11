import {
  buildGatewaySnapshot,
  enrichSnapshotWithSubscriptionCreds,
  loadSnapshotProfileMeta,
  type SnapshotSettingsSlice,
} from "./snapshot-publisher"
import type { GatewayRoutingSnapshot } from "@/types/gateway"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import * as profiles from "@/lib/db/provider-profiles"

jest.mock("@/lib/db/provider-profiles", () => ({
  getProfileMeta: jest.fn(),
  listDeploymentProfiles: jest.fn(),
  listTransportProfiles: jest.fn(),
}))

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
  it("projects remote deployment overrides and a named alias outside the auto tiers", () => {
    const snapshot = buildGatewaySnapshot(
      {
        modelMappings: [mapping("custom", [{ providerId: "openai", modelId: "gpt-4o" }])],
        routingConfig: { strategy: "my-plugin" },
      },
      1,
      {
        profileVersion: 2,
        byLegacyId: {
          openai: {
            deploymentId: "remote",
            region: "eu",
            enabled: false,
            models: { "gpt-4o": { tools: false, contextTokens: 4096 } },
          },
        },
      }
    )
    expect(snapshot.aliases[0].entries[0]).toMatchObject({
      locality: "remote",
      available: false,
      capabilities: { tools: false, contextTokens: 4096 },
    })
    expect(snapshot.routingPolicy?.auto).toMatchObject({
      candidateAliases: ["custom"],
      strategy: "reliability",
      strategyUnavailable: "my-plugin",
    })
  })
  it("publishes constraint counters and circuit-breaker policy with local deployments", () => {
    const snapshot = buildGatewaySnapshot(
      {
        modelMappings: [
          mapping("fast", [
            { providerId: "openai", modelId: "gpt-4o", conditions: { minContextLength: 1000 } },
          ]),
        ],
        routingConfig: {
          providerConstraints: [{ providerId: "openai", enabled: true }],
          circuitBreaker: { enabled: true },
        },
      } as SnapshotSettingsSlice,
      1,
      {
        profileVersion: 1,
        byLegacyId: {
          openai: { deploymentId: "local", enabled: true, region: "local", models: {} },
        },
      }
    )
    expect(snapshot.aliases[0].entries[0]).toMatchObject({ locality: "local", available: true })
    expect(snapshot.routingPolicy?.providerConstraints?.[0]).toMatchObject({
      providerId: "openai",
      currentRequestsPerMinute: 0,
      currentTokensPerMinute: 0,
      currentDailyCost: 0,
      circuitOpen: false,
    })
    expect(snapshot.routingPolicy?.circuitBreaker).toEqual({ enabled: true })
  })
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

describe("loadSnapshotProfileMeta", () => {
  it("keeps the legacy path when no account profile has been derived", async () => {
    jest.mocked(profiles.getProfileMeta).mockResolvedValue(undefined)
    await expect(loadSnapshotProfileMeta()).resolves.toBeUndefined()
  })

  it("projects account-owned model overrides and transport headers without credentials", async () => {
    jest
      .mocked(profiles.getProfileMeta)
      .mockResolvedValue({ profileVersion: 7 } as Awaited<
        ReturnType<typeof profiles.getProfileMeta>
      >)
    jest.mocked(profiles.listDeploymentProfiles).mockResolvedValue([
      {
        id: "deployment",
        legacyProviderId: "opencode",
        enabled: false,
        region: "local",
        transportProfileRef: "relay",
        models: [
          {
            id: "m",
            userOverride: {
              capabilities: {
                tools: false,
                attachments: true,
                structuredOutput: true,
                streaming: false,
              },
              limits: { context: 8192 },
            },
          },
          { id: "plain" },
        ],
      },
      { id: "unmapped", enabled: true, transportProfileRef: "missing", models: [] },
      { id: "simple", enabled: true, transportProfileRef: "bearer", models: [] },
    ] as Awaited<ReturnType<typeof profiles.listDeploymentProfiles>>)
    jest.mocked(profiles.listTransportProfiles).mockResolvedValue([
      {
        id: "relay",
        auth: { scheme: "custom-header", name: "x-token" },
        staticHeaders: { "x-tenant": "team" },
        forwardedSemanticHeaders: ["x-request-id"],
      },
      { id: "bearer", auth: { scheme: "bearer" } },
    ] as Awaited<ReturnType<typeof profiles.listTransportProfiles>>)
    const meta = await loadSnapshotProfileMeta()
    expect(meta).toMatchObject({
      profileVersion: 7,
      byLegacyId: {
        opencode: {
          deploymentId: "deployment",
          enabled: false,
          region: "local",
          models: {
            m: {
              tools: false,
              vision: true,
              structuredOutput: true,
              streaming: false,
              contextTokens: 8192,
            },
            plain: {},
          },
          transport: {
            authScheme: "custom-header",
            authHeaderName: "x-token",
            staticHeaders: [["x-tenant", "team"]],
            forwardedSemanticHeaders: ["x-request-id"],
          },
        },
        unmapped: { deploymentId: "unmapped" },
        simple: { transport: { authScheme: "bearer" } },
      },
    })
    expect(meta?.byLegacyId.unmapped.transport).toBeUndefined()
  })
})

describe("enrichSnapshotWithSubscriptionCreds", () => {
  const snap = (providers: GatewayRoutingSnapshot["providers"]): GatewayRoutingSnapshot => ({
    providers,
    aliases: [],
    generatedAtMs: 1,
  })

  it("keeps the configured relay when the vault has no endpoint override", async () => {
    const result = await enrichSnapshotWithSubscriptionCreds(
      snap([
        {
          id: "opencode",
          protocol: "openai",
          baseUrl: "https://configured.test/v1",
          enabled: false,
          models: [],
        },
      ]),
      ["opencode"],
      async () => ({ apiKey: "vault-key", baseURL: "" })
    )
    expect(result.providers[0].baseUrl).toBe("https://configured.test/v1")
  })

  it("preserves an explicit provider disable when a vault credential exists", async () => {
    const base = buildGatewaySnapshot(
      {
        providerSettings: {
          opencode: { providerId: "opencode", enabled: false, apiKey: "" },
        } as SnapshotSettingsSlice["providerSettings"],
      },
      1
    )
    const resolve = jest
      .fn()
      .mockResolvedValue({ apiKey: "vault-key", baseURL: "https://relay.test/v1" })
    const result = await enrichSnapshotWithSubscriptionCreds(base, ["opencode"], resolve)
    expect(result.providers.find((p) => p.id === "opencode")?.enabled).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("preserves a disabled deployment profile when enriching credentials", async () => {
    const base = buildGatewaySnapshot(
      {
        providerSettings: {
          opencode: { providerId: "opencode", enabled: true, apiKey: "" },
        } as SnapshotSettingsSlice["providerSettings"],
      },
      1,
      {
        profileVersion: 1,
        byLegacyId: { opencode: { deploymentId: "d", enabled: false, models: {} } },
      }
    )
    const result = await enrichSnapshotWithSubscriptionCreds(base, ["opencode"], async () => ({
      apiKey: "vault-key",
      baseURL: "https://relay.test/v1",
    }))
    expect(result.providers.find((p) => p.id === "opencode")?.enabled).toBe(false)
  })

  it("merges relay headers case-insensitively while preserving transport behavior", async () => {
    const result = await enrichSnapshotWithSubscriptionCreds(
      snap([
        {
          id: "opencode",
          protocol: "openai",
          baseUrl: "",
          enabled: false,
          models: [],
          transport: {
            authScheme: "bearer",
            staticHeaders: [
              ["x-tenant", "old"],
              ["x-client", "desktop"],
            ],
            forwardedSemanticHeaders: ["x-request-id"],
          },
        },
      ]),
      ["opencode"],
      async () => ({
        apiKey: "vault-key",
        baseURL: "https://relay.test/v1",
        headers: { "X-Tenant": "new", "x-cognia-private": "omit" },
      })
    )
    expect(result.providers[0].transport).toEqual({
      authScheme: "bearer",
      staticHeaders: [
        ["x-tenant", "new"],
        ["x-client", "desktop"],
      ],
      forwardedSemanticHeaders: ["x-request-id"],
    })
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

it("enriches a configured generic subscription with its declared protocol", async () => {
  const snapshot = {
    providers: [{ id: "example:api", protocol: "openai", baseUrl: "", enabled: false, models: [] }],
    aliases: [],
    generatedAtMs: 1,
  }
  const result = await enrichSnapshotWithSubscriptionCreds(snapshot, ["example:api"], async () => ({
    apiKey: "vault-key",
    baseURL: "https://example.test/v1",
    protocol: "anthropic",
  }))
  expect(result.providers[0]).toMatchObject({
    protocol: "anthropic",
    apiKey: "vault-key",
    enabled: true,
  })
})
it("does not leave a managed subscription enabled when its vault is unavailable", async () => {
  const snapshot = {
    providers: [
      {
        id: "custom-api",
        protocol: "openai",
        baseUrl: "https://example.test/v1",
        enabled: true,
        models: [],
      },
    ],
    aliases: [],
    generatedAtMs: 1,
  }
  const result = await enrichSnapshotWithSubscriptionCreds(
    snapshot,
    ["custom-api"],
    async () => null
  )
  expect(result.providers[0].enabled).toBe(false)
})

it("reads independent provider vaults concurrently while preserving provider order", async () => {
  let finishFirst!: (value: { apiKey: string; baseURL: string }) => void
  const resolve = jest.fn((id: string) =>
    id === "first"
      ? new Promise<{ apiKey: string; baseURL: string }>((finish) => {
          finishFirst = finish
        })
      : Promise.resolve({ apiKey: "second-key", baseURL: "https://second.test/v1" })
  )
  const pending = enrichSnapshotWithSubscriptionCreds(
    { providers: [], aliases: [], generatedAtMs: 1 },
    ["first", "second"],
    resolve
  )
  expect(resolve.mock.calls.map(([id]) => id)).toEqual(["first", "second"])
  finishFirst({ apiKey: "first-key", baseURL: "https://first.test/v1" })
  expect((await pending).providers.map((provider) => provider.id)).toEqual(["first", "second"])
})

it("publishes the complete live model catalog and preserves independent limits and explicit false", () => {
  const result = buildGatewaySnapshot(
    {
      customProviders: [
        {
          id: "custom-gateway",
          customName: "Gateway",
          baseURL: "https://gateway.example/v1",
          apiKey: "k",
          enabled: true,
          apiProtocol: "openai",
          apiFlavor: "responses",
          customModels: ["fallback"],
          discoveredModels: [
            {
              id: "live",
              name: "Live model",
              contextLength: 128000,
              maxInputTokens: 100000,
              maxOutputTokens: 8192,
              supportsTools: false,
              supportsReasoning: true,
              supportsStreaming: true,
            },
          ],
        },
      ],
    } as SnapshotSettingsSlice,
    1
  )
  expect(result.providers[0]).toMatchObject({
    apiFlavor: "responses",
    models: ["fallback", "live"],
  })
  expect(result.providers[0].modelMetadata?.find((model) => model.id === "live")).toMatchObject({
    contextLength: 128000,
    maxInputTokens: 100000,
    maxOutputTokens: 8192,
    supportsTools: false,
    supportsReasoning: true,
  })
  expect(
    result.providers[0].modelMetadata?.find((model) => model.id === "fallback")
  ).not.toHaveProperty("maxOutputTokens")
})

it("uses Anthropic authentication while preserving explicit subscription headers and API flavor", async () => {
  const snapshot: GatewayRoutingSnapshot = { providers: [], aliases: [], generatedAtMs: 1 }
  const result = await enrichSnapshotWithSubscriptionCreds(
    snapshot,
    ["plugin:messages"],
    async () => ({
      apiKey: "key",
      baseURL: "https://gateway.example/v1",
      protocol: "anthropic",
      headers: { "x-region": "us" },
    })
  )
  expect(result.providers[0].transport).toEqual({
    authScheme: "x-api-key",
    staticHeaders: [["x-region", "us"]],
  })
  const responses = await enrichSnapshotWithSubscriptionCreds(
    snapshot,
    ["plugin:responses"],
    async () => ({
      apiKey: "key",
      baseURL: "https://gateway.example/v1",
      protocol: "openai",
      apiFlavor: "responses",
    })
  )
  expect(responses.providers[0].apiFlavor).toBe("responses")
})
