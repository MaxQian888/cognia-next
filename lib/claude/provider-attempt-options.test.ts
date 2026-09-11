import type { AppSettings } from "@cognia/agent-config-types"
import {
  applyProviderAttemptLimits,
  resolveProviderAttemptOptions,
} from "./provider-attempt-options"

const mockResolveFeatureProvider = jest.fn()
const mockBuildModelInferenceParams = jest.fn()
const mockSelectApiKey = jest.fn()
const mockRecordKeyUse = jest.fn()
const mockResolveOpencodeVaultCredential = jest.fn()
const mockResolveCodexVaultCredential = jest.fn()
const mockResolveCommandcodeVaultCredential = jest.fn()
const mockResolveManaged = jest.fn()
const mockGetProtocolAdapter = jest.fn()
const mockSetProviderConfig = jest.fn()
const mockUpdateCustomProvider = jest.fn()

jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: (settings: unknown) => settings,
  resolveFeatureProvider: (...args: unknown[]) => mockResolveFeatureProvider(...args),
}))

jest.mock("@cognia/provider-core/providers/inference-params", () => ({
  buildModelInferenceParams: (...args: unknown[]) => mockBuildModelInferenceParams(...args),
}))

jest.mock("@cognia/provider-core/providers/api-key-rotation", () => ({
  selectApiKey: (...args: unknown[]) => mockSelectApiKey(...args),
  recordKeyUse: (...args: unknown[]) => mockRecordKeyUse(...args),
}))

jest.mock("@/lib/subscription/opencode/chat-bridge", () => ({
  resolveOpencodeVaultCredential: (...args: unknown[]) =>
    mockResolveOpencodeVaultCredential(...args),
}))

jest.mock("@/lib/subscription/codex/chat-bridge", () => ({
  resolveCodexVaultCredential: (...args: unknown[]) => mockResolveCodexVaultCredential(...args),
}))

jest.mock("@/lib/subscription/commandcode/chat-bridge", () => ({
  resolveCommandcodeVaultCredential: (...args: unknown[]) =>
    mockResolveCommandcodeVaultCredential(...args),
}))

jest.mock("@/lib/subscription/core/managed-key-credential", () => ({
  resolveManagedSubscriptionCredential: (...args: unknown[]) => mockResolveManaged(...args),
}))

jest.mock("@/types/subscription", () => ({
  isOpencodeChatProviderId: (providerId: string) => providerId.startsWith("opencode"),
  isCodexChatProviderId: (providerId: string) => providerId.startsWith("codex"),
}))

jest.mock("@cognia/provider-types/built-in-provider-catalog", () => ({
  ...jest.requireActual("@cognia/provider-types/built-in-provider-catalog"),
  getBuiltInProviderDefaultModel: (providerId: string) => `${providerId}-default`,
}))

jest.mock("@cognia/provider-core/providers/protocol-adapter-registry", () => ({
  getProtocolAdapter: (...args: unknown[]) => mockGetProtocolAdapter(...args),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      setProviderConfig: mockSetProviderConfig,
      updateCustomProvider: mockUpdateCustomProvider,
    }),
  },
}))

const resolved = (overrides: Record<string, unknown> = {}) => ({
  kind: "resolved",
  apiKey: "sk-attempt",
  baseURL: "https://example.test",
  protocol: "openai",
  isCustomProvider: false,
  ...overrides,
})

const settings = (providerId = "openai", config: Record<string, unknown> = {}): AppSettings =>
  ({
    defaultProvider: providerId,
    providerSettings: {
      [providerId]: {
        apiKey: "sk-attempt",
        inferenceDefaults: { temperature: 0.25, maxTokens: 512 },
        ...config,
      },
    },
  }) as unknown as AppSettings

async function flushAsyncPersistence(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveFeatureProvider.mockReturnValue(resolved())
  mockBuildModelInferenceParams.mockReturnValue({
    temperature: 0.25,
    maxOutputTokens: 512,
  })
  mockGetProtocolAdapter.mockReturnValue({
    spec: { kind: "declarative", request: { path: "/chat" } },
  })
  mockSelectApiKey.mockReturnValue({ apiKey: "sk-rotated", index: 1 })
  mockRecordKeyUse.mockReturnValue({ apiKeyRotationCursor: 1 })
})

describe("resolveProviderAttemptOptions", () => {
  it.each(["codex", "opencode", "commandcode"])(
    "honors an explicitly selected %s account over a manual key and rotation",
    async (id) => {
      const bridge =
        id === "codex"
          ? mockResolveCodexVaultCredential
          : id === "commandcode"
            ? mockResolveCommandcodeVaultCredential
            : mockResolveOpencodeVaultCredential
      bridge.mockResolvedValue({ apiKey: "selected-key", baseURL: "https://account.test" })
      const result = await resolveProviderAttemptOptions(
        id,
        settings(id, { apiKeyRotationEnabled: true }),
        "selected"
      )
      expect(result.providerCredentials?.apiKey).toBe("selected-key")
      expect(bridge).toHaveBeenCalledWith(id, "selected")
      expect(mockRecordKeyUse).not.toHaveBeenCalled()
    }
  )

  it("keeps a manual key when the account id was inherited from app defaults", async () => {
    const result = await resolveProviderAttemptOptions(
      "codex",
      settings("codex"),
      "app-default",
      false
    )
    expect(result.providerCredentials?.apiKey).toBe("sk-attempt")
    expect(mockResolveCodexVaultCredential).not.toHaveBeenCalled()
  })

  it("does not use a manual key when the explicitly selected account is unavailable", async () => {
    mockResolveCodexVaultCredential.mockResolvedValue(null)
    expect(await resolveProviderAttemptOptions("codex", settings("codex"), "deleted")).toEqual({})
  })

  it.each(["resolved", "unavailable"])(
    "preserves the OpenCode relay URL and headers for a %s provider",
    async (kind) => {
      mockResolveFeatureProvider.mockReturnValue(
        kind === "resolved"
          ? resolved({
              apiKey: "",
              baseURL: "https://opencode.ai/zen/v1",
              headers: { "X-Static": "kept" },
            })
          : { kind: "unavailable", nextAction: "configure_credentials" }
      )
      mockResolveOpencodeVaultCredential.mockResolvedValue({
        apiKey: "relay-key",
        baseURL: "https://relay.example/v1",
        headers: { "X-Tenant": "team" },
      })
      const result = await resolveProviderAttemptOptions(
        "opencode",
        settings("opencode", { apiKey: "" })
      )
      expect(result.providerCredentials).toMatchObject({
        apiKey: "relay-key",
        baseURL: "https://relay.example/v1",
        headers: { "X-Tenant": "team" },
      })
      if (kind === "resolved")
        expect(result.providerCredentials?.headers?.["X-Static"]).toBe("kept")
    }
  )
  it("uses the legacy OpenCode default for OpenCode Go vault resolution", async () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unavailable",
      nextAction: "configure_credentials",
    })
    mockResolveOpencodeVaultCredential.mockResolvedValue({
      apiKey: "go-key",
      baseURL: "https://open.test",
    })
    const appSettings = settings("opencode-go")
    appSettings.defaultAccountId = "legacy-go"

    await resolveProviderAttemptOptions("opencode-go", appSettings)

    expect(mockResolveOpencodeVaultCredential).toHaveBeenCalledWith("opencode-go", "legacy-go")
  })

  it("resolves credentials, inference defaults, and a declarative adapter", async () => {
    const result = await resolveProviderAttemptOptions("openai", settings())

    expect(result.providerCredentials).toMatchObject({
      apiKey: "sk-attempt",
      baseURL: "https://example.test",
      protocol: "openai",
    })
    expect(result.modelParams).toEqual({
      temperature: 0.25,
      maxOutputTokens: 512,
    })
    expect(result.protocolAdapterSpec).toMatchObject({ kind: "declarative" })
  })

  it("carries a valid provider concurrency limit into the execution attempt", async () => {
    await expect(
      resolveProviderAttemptOptions(
        "openai",
        settings("openai", { connectionParams: { concurrentLimit: 3 } })
      )
    ).resolves.toMatchObject({ concurrentLimit: 3 })

    await expect(
      resolveProviderAttemptOptions(
        "openai",
        settings("openai", { connectionParams: { concurrentLimit: 0 } })
      )
    ).resolves.not.toHaveProperty("concurrentLimit")
  })

  it("forwards the provider's static customHeaders and lets vault relay headers win", async () => {
    mockResolveFeatureProvider.mockReturnValue(
      resolved({ headers: { "x-tenant": "acme", "x-shared": "from-settings" } })
    )
    const result = await resolveProviderAttemptOptions("openai", settings())
    expect(result.providerCredentials?.headers).toEqual({
      "x-tenant": "acme",
      "x-shared": "from-settings",
    })

    // Codex vault headers merge on top of the settings headers.
    mockResolveFeatureProvider.mockReturnValue(
      resolved({ apiKey: undefined, headers: { "x-tenant": "acme", "x-shared": "from-settings" } })
    )
    mockResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "codex-key",
      baseURL: "https://codex.test",
      headers: { "x-shared": "from-vault", "chatgpt-account-id": "acct" },
    })
    const codex = await resolveProviderAttemptOptions("codex", settings("codex", { apiKey: "" }))
    expect(codex.providerCredentials?.headers).toEqual({
      "x-tenant": "acme",
      "x-shared": "from-vault",
      "chatgpt-account-id": "acct",
    })
  })

  it("passes the provider id and parameter schema to the inference-param builder", async () => {
    await resolveProviderAttemptOptions("openai", settings())
    expect(mockBuildModelInferenceParams).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-attempt" }),
      expect.objectContaining({ providerId: "openai", schema: expect.any(Object) })
    )
  })

  it("preserves Bedrock auth, API flavor, and the resolved default model", async () => {
    mockResolveFeatureProvider.mockReturnValue(
      resolved({
        apiFlavor: "responses",
        model: "anthropic.claude-sonnet",
        bedrock: {
          authMode: "credentials",
          region: "us-east-1",
          accessKeyId: "access",
          secretAccessKey: "secret",
          sessionToken: "session",
          roleArn: "arn:aws:iam::1:role/test",
        },
      })
    )

    const result = await resolveProviderAttemptOptions("bedrock", settings("bedrock"))

    expect(result.providerCredentials).toMatchObject({
      apiFlavor: "responses",
      bedrockAuthMode: "credentials",
      region: "us-east-1",
      accessKeyId: "access",
      secretAccessKey: "secret",
      sessionToken: "session",
      roleArn: "arn:aws:iam::1:role/test",
    })
    expect(result.defaultModel).toBe("anthropic.claude-sonnet")
  })

  it("omits an unavailable protocol adapter", async () => {
    mockGetProtocolAdapter.mockReturnValue(undefined)

    const result = await resolveProviderAttemptOptions("openai", settings())

    expect(result.protocolAdapterSpec).toBeUndefined()
  })

  it("uses the whole protocol id as the plugin id for an unqualified code adapter", async () => {
    mockResolveFeatureProvider.mockReturnValue(resolved({ protocol: "custom-adapter" }))
    mockGetProtocolAdapter.mockReturnValue({ spec: { kind: "code" } })

    const result = await resolveProviderAttemptOptions("custom", settings("custom"))

    expect(result.protocolAdapterSpec).toEqual({
      kind: "code",
      pluginId: "custom-adapter",
      adapterId: "custom-adapter",
    })
  })

  it("uses a rotated key and persists built-in provider rotation", async () => {
    const result = await resolveProviderAttemptOptions(
      "openai",
      settings("openai", { apiKeyRotationEnabled: true })
    )
    await flushAsyncPersistence()

    expect(result.providerCredentials?.apiKey).toBe("sk-rotated")
    expect(mockSetProviderConfig).toHaveBeenCalledWith("openai", {
      apiKeyRotationCursor: 1,
    })
  })

  it("keeps the resolved credential when rotation has no usable key or cursor update", async () => {
    mockSelectApiKey.mockReturnValue({ apiKey: undefined, index: -1 })
    mockRecordKeyUse.mockReturnValue(undefined)

    const result = await resolveProviderAttemptOptions(
      "openai",
      settings("openai", { apiKeyRotationEnabled: true })
    )
    await flushAsyncPersistence()

    expect(result.providerCredentials?.apiKey).toBe("sk-attempt")
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("persists custom-provider rotation and resolves a code adapter identity", async () => {
    mockResolveFeatureProvider.mockReturnValue(
      resolved({ protocol: "plugin-id:adapter", isCustomProvider: true })
    )
    mockGetProtocolAdapter.mockReturnValue({ spec: { kind: "code" } })
    const appSettings = {
      customProviders: [
        {
          id: "custom",
          apiKey: "custom-key",
          apiKeyRotationEnabled: true,
        },
      ],
    } as unknown as AppSettings

    const result = await resolveProviderAttemptOptions("custom", appSettings)
    await flushAsyncPersistence()

    expect(result.protocolAdapterSpec).toEqual({
      kind: "code",
      pluginId: "plugin-id",
      adapterId: "plugin-id:adapter",
    })
    expect(mockUpdateCustomProvider).toHaveBeenCalledWith("custom", {
      apiKeyRotationCursor: 1,
    })
  })

  it("uses resolved OpenCode and Codex vault credentials when config has no key", async () => {
    mockResolveFeatureProvider.mockReturnValue(resolved({ apiKey: "" }))
    mockResolveOpencodeVaultCredential.mockResolvedValue({ apiKey: "open-vault" })
    const opencode = await resolveProviderAttemptOptions("opencode", settings("opencode"))
    expect(opencode.providerCredentials?.apiKey).toBe("open-vault")

    mockResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "codex-vault",
      baseURL: "https://codex.test",
      headers: { "x-account": "account" },
    })
    const codex = await resolveProviderAttemptOptions("codex", settings("codex"))
    expect(codex.providerCredentials).toMatchObject({
      apiKey: "codex-vault",
      baseURL: "https://codex.test",
      headers: { "x-account": "account" },
    })
  })

  it("forwards the deterministically selected account to the vault bridge", async () => {
    mockResolveFeatureProvider.mockReturnValue(resolved({ apiKey: "" }))
    mockResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "selected-key",
      baseURL: "https://codex.test",
    })

    await resolveProviderAttemptOptions("codex", settings("codex"), "selected-account")

    expect(mockResolveCodexVaultCredential).toHaveBeenCalledWith("codex", "selected-account")
  })

  it("falls back to standalone subscription vaults for unresolved providers", async () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unavailable",
      nextAction: "configure_credentials",
    })
    mockResolveOpencodeVaultCredential.mockResolvedValue({
      apiKey: "open-vault",
      baseURL: "https://open.test",
    })
    await expect(
      resolveProviderAttemptOptions("opencode", settings("opencode"))
    ).resolves.toMatchObject({
      providerCredentials: {
        apiKey: "open-vault",
        baseURL: "https://open.test",
        protocol: "openai",
      },
      defaultModel: "opencode-default",
    })

    mockResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "codex-vault",
      baseURL: "https://codex.test",
      headers: { authorization: "Bearer session" },
    })
    await expect(resolveProviderAttemptOptions("codex", settings("codex"))).resolves.toMatchObject({
      providerCredentials: {
        apiKey: "codex-vault",
        headers: { authorization: "Bearer session" },
      },
      defaultModel: "codex-default",
    })
  })

  it("returns no credentials for unavailable, explicitly disabled providers", async () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unavailable",
      nextAction: "enable_provider",
    })

    await expect(resolveProviderAttemptOptions("opencode", settings("opencode"))).resolves.toEqual(
      {}
    )
    await expect(resolveProviderAttemptOptions("missing", settings("missing"))).resolves.toEqual({})
  })

  it("returns an empty result when an unresolved subscription provider has no vault session", async () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unavailable",
      nextAction: "configure_credentials",
    })
    mockResolveOpencodeVaultCredential.mockResolvedValue(undefined)
    mockResolveCodexVaultCredential.mockResolvedValue(undefined)

    await expect(resolveProviderAttemptOptions("opencode", settings("opencode"))).resolves.toEqual(
      {}
    )
    await expect(resolveProviderAttemptOptions("codex", settings("codex"))).resolves.toEqual({})
  })

  it("does not let a failed rotation persistence break credential resolution", async () => {
    mockSetProviderConfig.mockRejectedValueOnce(new Error("storage unavailable"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const result = await resolveProviderAttemptOptions(
        "openai",
        settings("openai", { apiKeyRotationEnabled: true })
      )
      await flushAsyncPersistence()
      expect(result.providerCredentials?.apiKey).toBe("sk-rotated")
      expect(warn).toHaveBeenCalledWith(
        "api key rotation advance persist failed",
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })
})

it("preserves the concurrently added CommandCode account transport", async () => {
  mockResolveCommandcodeVaultCredential.mockResolvedValue({
    apiKey: "command-key",
    baseURL: "https://command.test",
  })
  const result = await resolveProviderAttemptOptions(
    "commandcode",
    settings("commandcode"),
    "selected-command"
  )
  expect(result.providerCredentials?.apiKey).toBe("command-key")
  expect(mockResolveCommandcodeVaultCredential).toHaveBeenCalledWith(
    "commandcode",
    "selected-command"
  )
})

describe("registered API subscriptions", () => {
  it("shares retry output, input and summary limit calculation across chat and Room", () => {
    const options = {
      provider: "openai",
      model: "retry-model",
      modelParams: { maxOutputTokens: 10000 },
      compaction: { enabled: true, contextWindow: 200000, maxSummaryTokens: 5000 },
    } as Parameters<typeof applyProviderAttemptLimits>[0]
    const limits = applyProviderAttemptLimits(
      options,
      settings("openai", {
        discoveredModels: [
          { id: "retry-model", contextLength: 64000, maxInputTokens: 32000, maxOutputTokens: 4096 },
        ],
      }),
      256
    )
    expect(limits).toMatchObject({
      modelParams: { maxOutputTokens: 256 },
      compaction: { contextWindow: 32000, maxSummaryTokens: 4096 },
    })
    expect(options.compaction?.contextWindow).toBe(200000)
  })
  it.each([
    [10000, 4096],
    [1024, 1024],
  ])(
    "caps requested output %s for the selected discovered model without raising smaller limits",
    async (requested, expected) => {
      mockResolveFeatureProvider.mockReturnValue(resolved({ model: "provider-default" }))
      mockBuildModelInferenceParams.mockReturnValue({ maxOutputTokens: requested })
      const result = await resolveProviderAttemptOptions(
        "openai",
        settings("openai", {
          discoveredModels: [
            { id: "chosen-model", maxOutputTokens: 4096, supportsReasoning: false },
          ],
        }),
        undefined,
        false,
        "chosen-model"
      )
      expect(result.modelParams?.maxOutputTokens).toBe(expected)
      expect(mockBuildModelInferenceParams).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          modelConfig: expect.objectContaining({ id: "chosen-model", supportsReasoning: false }),
        })
      )
    }
  )
  it("leaves unknown limits unchanged and fills an unspecified cap from known metadata", async () => {
    mockResolveFeatureProvider.mockReturnValue(resolved({ model: "unknown-model" }))
    mockBuildModelInferenceParams.mockReturnValue({ maxOutputTokens: 7777 })
    expect(
      (await resolveProviderAttemptOptions("openai", settings())).modelParams?.maxOutputTokens
    ).toBe(7777)
    mockBuildModelInferenceParams.mockReturnValue({ temperature: 0.2 })
    expect(
      (
        await resolveProviderAttemptOptions(
          "openai",
          settings("openai", {
            discoveredModels: [{ id: "chosen-model", maxOutputTokens: 2048 }],
          }),
          undefined,
          false,
          "chosen-model"
        )
      ).modelParams
    ).toEqual({ temperature: 0.2, maxOutputTokens: 2048 })
  })
  const custom = {
    id: "custom-api",
    providerId: "custom-api",
    isCustom: true,
    customName: "Example",
    baseURL: "https://custom.test/v1",
    apiProtocol: "anthropic",
    customModels: ["model-a"],
    enabled: true,
    subscription: {},
  }
  it.each(["resolved", "fallback"])(
    "preserves a plugin's Responses endpoint on the %s path",
    async (path) => {
      const { registerPluginSubscriptionProvider, unregisterSubscriptionProvidersByPlugin } =
        await import("@/lib/subscription/core/provider-registry")
      const id = registerPluginSubscriptionProvider(
        {
          id: "responses",
          name: "Responses API",
          baseUrl: "https://plugin.test/v1",
          protocol: "openai",
          apiFlavor: "responses",
          models: ["model-a"],
        },
        "sample-responses"
      )
      try {
        mockResolveFeatureProvider.mockReturnValue(
          path === "resolved"
            ? resolved({ apiKey: "", apiFlavor: "chat" })
            : { kind: "unresolved", nextAction: "add_api_key" }
        )
        mockResolveManaged.mockResolvedValue({
          apiKey: "vault-key",
          baseURL: "https://plugin.test/v1",
        })
        const result = await resolveProviderAttemptOptions(
          id,
          settings(id, { apiKey: "" }),
          "chosen"
        )
        expect(result.providerCredentials).toMatchObject({
          apiKey: "vault-key",
          protocol: "openai",
          apiFlavor: "responses",
        })
      } finally {
        unregisterSubscriptionProvidersByPlugin("sample-responses")
      }
    }
  )
  it("resolves a panel-created provider using its default account without settings secrets", async () => {
    mockResolveFeatureProvider.mockReturnValue(
      resolved({ apiKey: "", protocol: "anthropic", isCustomProvider: true })
    )
    mockResolveManaged.mockResolvedValue({ apiKey: "vault-key", baseURL: "https://relay.test/v1" })
    const config = {
      ...settings("custom-api", { apiKey: "" }),
      customProviders: [custom],
      defaultAccountIds: { "custom-api": "default-account" },
    } as unknown as AppSettings
    const result = await resolveProviderAttemptOptions("custom-api", config)
    expect(result.providerCredentials).toMatchObject({
      apiKey: "vault-key",
      baseURL: "https://relay.test/v1",
      protocol: "anthropic",
    })
    expect(mockResolveManaged).toHaveBeenCalledWith(
      expect.objectContaining({ id: "custom-api", source: "custom" }),
      "default-account"
    )
    expect(config.customProviders?.[0]).not.toHaveProperty("apiKey")
  })
  it("does not dispatch a managed custom subscription as a keyless custom endpoint", async () => {
    mockResolveFeatureProvider.mockReturnValue(resolved({ apiKey: "", isCustomProvider: true }))
    mockResolveManaged.mockResolvedValue(null)
    await expect(
      resolveProviderAttemptOptions("custom-api", {
        ...settings("custom-api", { apiKey: "" }),
        customProviders: [custom],
      } as unknown as AppSettings)
    ).resolves.toEqual({})
  })
  it("uses the registered plugin protocol even when saved settings omit it", async () => {
    const { registerPluginSubscriptionProvider, unregisterSubscriptionProvidersByPlugin } =
      await import("@/lib/subscription/core/provider-registry")
    const id = registerPluginSubscriptionProvider(
      {
        id: "api",
        name: "Plugin API",
        baseUrl: "https://plugin.test/v1",
        protocol: "anthropic",
        models: ["model-a"],
      },
      "sample"
    )
    try {
      mockResolveFeatureProvider.mockReturnValue(resolved({ apiKey: "" }))
      mockResolveManaged.mockResolvedValue({
        apiKey: "plugin-key",
        baseURL: "https://plugin.test/v1",
      })
      const result = await resolveProviderAttemptOptions(
        id,
        settings(id, { apiKey: "" }),
        "selected"
      )
      expect(result.providerCredentials).toMatchObject({
        apiKey: "plugin-key",
        protocol: "anthropic",
      })
      expect(mockBuildModelInferenceParams).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          schema: expect.objectContaining({
            parameters: expect.arrayContaining([
              expect.objectContaining({ key: "anthropic.thinking.enabled" }),
            ]),
          }),
        })
      )
    } finally {
      unregisterSubscriptionProvidersByPlugin("sample")
    }
  })
})

it("does not dispatch an unloaded plugin using stale settings", async () => {
  mockResolveFeatureProvider.mockReturnValue(resolved({ apiKey: "stale-manual-key" }))
  await expect(
    resolveProviderAttemptOptions("unloaded:api", settings("unloaded:api"))
  ).resolves.toEqual({})
  expect(mockResolveFeatureProvider).not.toHaveBeenCalled()
})
