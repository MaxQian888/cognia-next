import type { GatewayRoutingSnapshot } from "@/types/gateway"

const flagMock = jest.fn()
jest.mock("@/lib/ai/agent/execution/feature-flags", () => ({
  isAgentExecutionFlagEnabled: (...args: unknown[]) => flagMock(...args),
}))

const statusMock = jest.fn()
const mintMock = jest.fn()
const pushMock = jest.fn()
const revokeMock = jest.fn()
const startMock = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetStatus: () => statusMock(),
  gatewayStart: () => startMock(),
  gatewayPushSnapshot: (...args: unknown[]) => pushMock(...args),
  gatewayRevokeRouteTicket: (...args: unknown[]) => revokeMock(...args),
  gatewayMintRouteTicket: (...args: unknown[]) => mintMock(...args),
}))

const buildSnapshotMock = jest.fn()
const enrichedMock = jest.fn()
const modelMetadataMock = jest.fn()
jest.mock("@/lib/gateway/snapshot-publisher", () => ({
  buildEnrichedGatewaySnapshot: (...args: unknown[]) => enrichedMock(...args),
  gatewayModelMetadata: (...args: unknown[]) => modelMetadataMock(...args),
  buildGatewaySnapshot: (...args: unknown[]) => buildSnapshotMock(...args),
  loadSnapshotProfileMeta: () => Promise.resolve(undefined),
}))

const settingsState = {
  settings: {
    defaultProvider: "anthropic",
    providerSettings: { anthropic: { providerId: "anthropic", apiKey: "default-key" } } as Record<
      string,
      { providerId: string; apiKey?: string }
    >,
    customProviders: [],
    modelMappings: [],
    routingConfig: { strategy: "difficulty", maxFallbackAttempts: 2 },
  },
}
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: () => settingsState } }))
const accountState = { unlockedAccountId: "local-a" as string | null }
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => accountState },
}))
const activeAccountMock = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: (...args: unknown[]) => activeAccountMock(...args),
}))
const modelDetailMock = jest.fn()
const subscriptionDefinitionMock = jest.fn()
jest.mock("@/lib/subscription/core/provider-registry", () => ({
  getSubscriptionProvider: (...args: unknown[]) => subscriptionDefinitionMock(...args),
}))
jest.mock("@/lib/subscription/core/model-discovery", () => ({
  getSubscriptionModel: (...args: unknown[]) => modelDetailMock(...args),
}))
const credentialMock = jest.fn()
jest.mock("@/lib/claude/provider-attempt-options", () => ({
  resolveSubscriptionProviderCredential: (...args: unknown[]) => credentialMock(...args),
}))

import {
  candidatesForModel,
  mintSessionRouteTicket,
  prepareExternalAgentGatewayRoute,
} from "./mint-session-ticket"

function snapshot(overrides: Partial<GatewayRoutingSnapshot> = {}): GatewayRoutingSnapshot {
  return {
    generatedAtMs: 1,
    aliases: [],
    providers: [
      {
        id: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        enabled: true,
        models: ["claude-opus-5"],
        deploymentId: "dep_anthropic",
      },
    ],
    ...overrides,
  }
}

const INPUT = {
  sessionId: "sess_1",
  executionFingerprint: "fp_1",
  model: "claude-opus-5",
  routePolicy: "gateway-preferred",
}

beforeEach(() => {
  jest.clearAllMocks()
  flagMock.mockReturnValue(true)
  statusMock.mockResolvedValue({ running: true, boundPort: 8317 })
  buildSnapshotMock.mockReturnValue(snapshot())
  enrichedMock.mockImplementation(() => ({
    ...snapshot(),
    providers: snapshot().providers.map((provider) => ({ ...provider, apiKey: "default-key" })),
  }))
  pushMock.mockResolvedValue({ accepted: true })
  revokeMock.mockResolvedValue(true)
  startMock.mockResolvedValue(undefined)
  accountState.unlockedAccountId = "local-a"
  settingsState.settings.providerSettings = {
    anthropic: { providerId: "anthropic", apiKey: "default-key" },
  }
  credentialMock.mockReset()
  subscriptionDefinitionMock.mockReset()
  modelDetailMock.mockReset()
  modelMetadataMock.mockImplementation((_settings: unknown, _provider: string, model: string) => ({
    id: model,
    maxOutputTokens: 8192,
    maxInputTokens: 100000,
  }))
  activeAccountMock.mockResolvedValue({ activeAccountId: "active-a" })
  mintMock.mockResolvedValue({ ticket: { ticketId: "tkt_1" }, secret: "sk-ticket" })
})

describe("candidatesForModel", () => {
  it("expands an alias into its ordered deployment candidates", () => {
    const withAlias = snapshot({
      aliases: [
        {
          alias: "fast",
          entries: [
            { providerId: "anthropic", modelId: "claude-opus-5" },
            { providerId: "openai", modelId: "gpt-5" },
          ],
        },
      ],
      providers: [
        ...snapshot().providers,
        {
          id: "openai",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          enabled: true,
          models: ["gpt-5"],
          deploymentId: "dep_openai",
        },
      ],
    })
    expect(candidatesForModel(withAlias, "fast")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "claude-opus-5" },
      { deploymentId: "dep_openai", modelId: "gpt-5" },
    ])
  })

  it("matches a bare model id against every enabled provider that lists it", () => {
    expect(candidatesForModel(snapshot(), "claude-opus-5")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "claude-opus-5" },
    ])
  })

  it("honours a provider-pinned id", () => {
    expect(candidatesForModel(snapshot(), "anthropic:claude-opus-5")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "claude-opus-5" },
    ])
    expect(candidatesForModel(snapshot(), "openai:claude-opus-5")).toEqual([])
  })

  it("skips disabled providers, which mint would reject as unservable", () => {
    const disabled = snapshot({
      providers: [{ ...snapshot().providers[0]!, enabled: false }],
    })
    expect(candidatesForModel(disabled, "claude-opus-5")).toEqual([])
  })

  it("falls back to the provider id when no deployment profile exists", () => {
    const legacy = snapshot({
      providers: [{ ...snapshot().providers[0]!, deploymentId: undefined }],
    })
    expect(candidatesForModel(legacy, "claude-opus-5")).toEqual([
      { deploymentId: "anthropic", modelId: "claude-opus-5" },
    ])
  })
})

describe("mintSessionRouteTicket", () => {
  it("mints against the running listener and returns the one-shot secret", async () => {
    await expect(mintSessionRouteTicket(INPUT)).resolves.toEqual({
      endpoint: "http://127.0.0.1:8317/v1",
      ticketId: "tkt_1",
      secret: "sk-ticket",
    })
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_1",
        executionFingerprint: "fp_1",
        routePolicy: "gateway-preferred",
        candidates: [{ deploymentId: "dep_anthropic", modelId: "claude-opus-5" }],
        model: "claude-opus-5",
        credentialAffinity: "session-sticky",
        allowAuthFailover: false,
      })
    )
    // Bindings are Rust's job (`default_model_bindings`); passing any here
    // would create a second implementation of the family mapping.
    expect(mintMock.mock.calls[0]![0]).not.toHaveProperty("modelBindings")
    expect(buildSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routingConfig: { strategy: "difficulty", maxFallbackAttempts: 2 },
      }),
      expect.any(Number),
      undefined
    )
  })

  it("allows auth failover only when more than one candidate is frozen", async () => {
    buildSnapshotMock.mockReturnValue(
      snapshot({
        providers: [
          snapshot().providers[0]!,
          {
            id: "bedrock",
            protocol: "anthropic",
            baseUrl: "https://bedrock",
            enabled: true,
            models: ["claude-opus-5"],
            deploymentId: "dep_bedrock",
          },
        ],
      })
    )
    await mintSessionRouteTicket(INPUT)
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialAffinity: "sticky-with-failover",
        allowAuthFailover: true,
      })
    )
  })

  it("does not mint while the capability flag is off", async () => {
    flagMock.mockReturnValue(false)
    await expect(mintSessionRouteTicket(INPUT)).resolves.toBeUndefined()
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("does not mint when the listener is not running", async () => {
    statusMock.mockResolvedValue({ running: false, boundPort: null })
    await expect(mintSessionRouteTicket(INPUT)).resolves.toBeUndefined()
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("does not mint when the snapshot cannot serve the model", async () => {
    await expect(
      mintSessionRouteTicket({ ...INPUT, model: "some-unrouted-model" })
    ).resolves.toBeUndefined()
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("degrades to undefined rather than throwing when Rust refuses", async () => {
    mintMock.mockRejectedValue(new Error("candidate is not servable"))
    await expect(mintSessionRouteTicket(INPUT)).resolves.toBeUndefined()
  })
})

describe("required external agent gateway leases", () => {
  const input = { providerId: "anthropic", modelId: "claude-opus-5", sessionId: "task-a" } as const

  it("publishes a fresh snapshot and mints a task-only upstream even while the optional flag is off", async () => {
    flagMock.mockReturnValue(false)
    const result = await prepareExternalAgentGatewayRoute({
      ...input,
      ingressProtocol: "openai-responses",
    })
    expect(result).toMatchObject({
      endpoint: "http://127.0.0.1:8317/v1",
      ticketId: "tkt_1",
      secret: "sk-ticket",
      model: input.modelId,
      ownerAccountId: "local-a",
    })
    const [request, options] = mintMock.mock.calls[0]
    expect(options).toEqual({ required: true })
    expect(request).toMatchObject({
      routePolicy: "gateway-required",
      credentialAffinity: "session-sticky",
      allowAuthFailover: false,
      operations: ["responses", "models", "count-tokens"],
      modelBindings: { [input.modelId]: input.modelId, haiku: input.modelId },
      providerOverrides: [
        {
          apiKey: "default-key",
          models: [input.modelId],
          modelMetadata: [{ id: input.modelId, maxOutputTokens: 8192, maxInputTokens: 100000 }],
        },
      ],
    })
    expect(request.candidates[0].deploymentId).toBe(request.providerOverrides[0].id)
    expect(pushMock.mock.invocationCallOrder[0]).toBeLessThan(mintMock.mock.invocationCallOrder[0])
    expect(pushMock.mock.calls[0][0].providers[0].id).toBe("anthropic")
  })

  it("returns an explicit null owner for a host without local account ownership", async () => {
    accountState.unlockedAccountId = null
    statusMock.mockResolvedValue({ running: true, boundPort: 8317, accountRequired: false })
    const result = await prepareExternalAgentGatewayRoute(input)
    expect(result.ownerAccountId).toBeNull()
  })

  it.each([
    ["anthropic/claude-sonnet-4-6", "anthropic", "x-api-key"],
    ["openai/gpt-5.4", "openai", "bearer"],
  ])(
    "freezes CommandCode model-family protocol for %s before assigning a private deployment",
    async (modelId, protocol, authScheme) => {
      settingsState.settings.providerSettings = {
        commandcode: { providerId: "commandcode", apiKey: "commandcode-key" },
      }
      enrichedMock.mockResolvedValue(
        snapshot({
          providers: [
            {
              id: "commandcode",
              protocol: "openai",
              apiKey: "commandcode-key",
              baseUrl: "https://api.commandcode.ai/provider/v1",
              enabled: true,
              models: [modelId],
            },
          ],
        })
      )
      await prepareExternalAgentGatewayRoute({ ...input, providerId: "commandcode", modelId })
      const provider = mintMock.mock.calls[0][0].providerOverrides[0]
      expect(provider.id).toMatch(/^cognia-task-/)
      expect(provider).toMatchObject({ protocol, transport: { authScheme }, models: [modelId] })
      expect(pushMock.mock.calls[0][0].providers[0].protocol).toBe("openai")
    }
  )

  it("freezes an explicit account without changing the shared snapshot or global settings", async () => {
    credentialMock.mockResolvedValue({
      apiKey: "selected-key",
      baseURL: "https://selected.example/v1",
      protocol: "openai",
      apiFlavor: "responses",
      headers: { "x-region": "us" },
    })
    await prepareExternalAgentGatewayRoute({ ...input, accountId: "account-b" })
    expect(credentialMock).toHaveBeenCalledWith("anthropic", settingsState.settings, "account-b")
    expect(pushMock.mock.calls[0][0].providers[0].apiKey).toBe("default-key")
    expect(mintMock.mock.calls[0][0].providerOverrides[0]).toMatchObject({
      apiKey: "selected-key",
      apiFlavor: "responses",
      rotationEnabled: false,
      transport: { staticHeaders: [["x-region", "us"]] },
    })
  })

  it("returns the resolved account binding and keeps explicit manual bindings from following an active account", async () => {
    settingsState.settings.providerSettings = { anthropic: { providerId: "anthropic" } }
    subscriptionDefinitionMock.mockReturnValue({ id: "anthropic", authMode: "api-key" })
    credentialMock.mockResolvedValue({
      apiKey: "active-key",
      baseURL: "https://gateway.example/v1",
    })
    const route = await prepareExternalAgentGatewayRoute(input)
    expect(route.binding).toEqual({
      providerId: input.providerId,
      modelId: input.modelId,
      accountId: "active-a",
    })
    expect(credentialMock).toHaveBeenCalledWith(
      input.providerId,
      settingsState.settings,
      "active-a"
    )
    await expect(prepareExternalAgentGatewayRoute({ ...input, accountId: null })).rejects.toThrow(
      "no usable gateway credential"
    )
    expect(mintMock).toHaveBeenCalledTimes(1)
  })

  it("isolates simultaneous tasks selecting different subscription accounts", async () => {
    credentialMock.mockImplementation(async (_provider, _settings, accountId) => ({
      apiKey: `key-${accountId}`,
      baseURL: "https://gateway.example/v1",
    }))
    await Promise.all([
      prepareExternalAgentGatewayRoute({ ...input, sessionId: "task-a", accountId: "a" }),
      prepareExternalAgentGatewayRoute({ ...input, sessionId: "task-b", accountId: "b" }),
    ])
    const requests = mintMock.mock.calls.map(([request]) => request)
    expect(new Set(requests.map((request) => request.candidates[0].deploymentId)).size).toBe(2)
    expect(requests.map((request) => request.providerOverrides[0].apiKey).sort()).toEqual([
      "key-a",
      "key-b",
    ])
    expect(
      pushMock.mock.calls.every(([snapshot]) => snapshot.providers[0].apiKey === "default-key")
    ).toBe(true)
  })

  it("reads selected-account model facts transiently and rejects models unavailable to that account", async () => {
    credentialMock.mockResolvedValue({
      apiKey: "selected-key",
      baseURL: "https://selected.example/v1",
    })
    const definition = { id: input.providerId, modelApi: { list: true } }
    subscriptionDefinitionMock.mockReturnValue(definition)
    modelDetailMock.mockResolvedValue({ model: { id: input.modelId, maxOutputTokens: 4096 } })
    modelMetadataMock.mockImplementationOnce((metadataSettings, providerId, modelId) => ({
      id: modelId,
      maxOutputTokens:
        metadataSettings.providerSettings[providerId].discoveredModels[0].maxOutputTokens,
    }))
    const route = await prepareExternalAgentGatewayRoute({ ...input, accountId: "limited-account" })
    expect(route.modelMetadata).toEqual({ id: input.modelId, maxOutputTokens: 4096 })
    expect(mintMock.mock.calls[0][0].providerOverrides[0].modelMetadata).toEqual([
      route.modelMetadata,
    ])
    expect(modelDetailMock).toHaveBeenCalledWith({
      definition,
      accountId: "limited-account",
      model: input.modelId,
      signal: undefined,
    })
    modelDetailMock.mockResolvedValue({ model: null })
    await expect(
      prepareExternalAgentGatewayRoute({ ...input, accountId: "limited-account" })
    ).rejects.toThrow("does not provide")
    expect(mintMock).toHaveBeenCalledTimes(1)
  })

  it("never falls back when a selected account is unavailable", async () => {
    credentialMock.mockResolvedValue(null)
    await expect(
      prepareExternalAgentGatewayRoute({ ...input, accountId: "missing" })
    ).rejects.toThrow("account is unavailable")
    expect(mintMock).not.toHaveBeenCalled()
  })

  it("refuses rejected publication and disabled or unknown models before minting", async () => {
    pushMock.mockResolvedValue({ accepted: false })
    await expect(prepareExternalAgentGatewayRoute(input)).rejects.toThrow("rejected")
    expect(mintMock).not.toHaveBeenCalled()
    pushMock.mockResolvedValue({ accepted: true })
    await expect(
      prepareExternalAgentGatewayRoute({ ...input, modelId: "missing" })
    ).rejects.toThrow("catalog")
    enrichedMock.mockResolvedValue(
      snapshot({ providers: [{ ...snapshot().providers[0], credentialFallbackAllowed: false }] })
    )
    await expect(prepareExternalAgentGatewayRoute(input)).rejects.toThrow("disabled")
  })

  it("starts the listener and rejects an account generation change", async () => {
    statusMock
      .mockResolvedValue({ running: true, boundPort: 8317, accountGeneration: 1 })
      .mockResolvedValueOnce({ running: false, boundPort: null, accountGeneration: 1 })
    await prepareExternalAgentGatewayRoute(input)
    expect(startMock).toHaveBeenCalledTimes(1)
    statusMock
      .mockResolvedValueOnce({ running: true, boundPort: 8317, accountGeneration: 1 })
      .mockResolvedValueOnce({ running: true, boundPort: 8317, accountGeneration: 2 })
    await expect(prepareExternalAgentGatewayRoute(input)).rejects.toThrow("ownership changed")
    expect(revokeMock).toHaveBeenCalledWith("tkt_1")
  })

  it("revokes a lease if cancellation or local-account switch wins the mint race", async () => {
    const controller = new AbortController()
    mintMock.mockImplementationOnce(async () => {
      controller.abort()
      return { ticket: { ticketId: "cancelled" }, secret: "secret" }
    })
    await expect(
      prepareExternalAgentGatewayRoute({ ...input, signal: controller.signal })
    ).rejects.toThrow()
    expect(revokeMock).toHaveBeenCalledWith("cancelled")
    mintMock.mockImplementationOnce(async () => {
      accountState.unlockedAccountId = "local-b"
      return { ticket: { ticketId: "switched" }, secret: "secret" }
    })
    await expect(prepareExternalAgentGatewayRoute(input)).rejects.toThrow(
      "account or model settings changed"
    )
    expect(revokeMock).toHaveBeenCalledWith("switched")
  })

  it("allows a catalog-declared local OpenAI endpoint that requires no API key", async () => {
    settingsState.settings.providerSettings = { lmstudio: { providerId: "lmstudio" } }
    enrichedMock.mockResolvedValue(
      snapshot({
        providers: [
          {
            id: "lmstudio",
            protocol: "openai",
            baseUrl: "http://127.0.0.1:1234/v1",
            enabled: true,
            models: ["local-model"],
          },
        ],
      })
    )
    const route = await prepareExternalAgentGatewayRoute({
      providerId: "lmstudio",
      modelId: "local-model",
      sessionId: "local-task",
    })
    expect(route.binding.accountId).toBeNull()
    expect(mintMock.mock.calls[0][0].providerOverrides[0].apiKey).toBeUndefined()
  })

  it("keeps namespaced providers and colon-containing models unambiguous", async () => {
    const provider = {
      ...snapshot().providers[0],
      id: "plugin:sub:anthropic",
      apiKey: "k",
      models: ["family:model"],
    }
    const current = snapshot({ providers: [provider] })
    expect(candidatesForModel(current, "plugin:sub:anthropic:family:model")).toEqual([
      { deploymentId: "dep_anthropic", modelId: "family:model" },
    ])
    enrichedMock.mockResolvedValue(current)
    settingsState.settings.providerSettings[provider.id] = { providerId: provider.id, apiKey: "k" }
    await prepareExternalAgentGatewayRoute({
      ...input,
      providerId: provider.id,
      modelId: "family:model",
    })
    expect(mintMock.mock.calls[0][0].candidates[0].modelId).toBe("family:model")
  })
})
