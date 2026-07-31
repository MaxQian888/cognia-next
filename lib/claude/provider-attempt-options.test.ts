import type { AppSettings } from "@cognia/agent-config-types"
import { resolveProviderAttemptOptions } from "./provider-attempt-options"

const mockResolveFeatureProvider = jest.fn()
const mockBuildModelInferenceParams = jest.fn()
const mockSelectApiKey = jest.fn()
const mockRecordKeyUse = jest.fn()
const mockResolveOpencodeVaultCredential = jest.fn()
const mockResolveCodexVaultCredential = jest.fn()
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

jest.mock("@/types/subscription", () => ({
  isOpencodeChatProviderId: (providerId: string) => providerId.startsWith("opencode"),
  isCodexChatProviderId: (providerId: string) => providerId.startsWith("codex"),
}))

jest.mock("@cognia/provider-types/built-in-provider-catalog", () => ({
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
    const opencode = await resolveProviderAttemptOptions("opencode-chat", settings("opencode-chat"))
    expect(opencode.providerCredentials?.apiKey).toBe("open-vault")

    mockResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "codex-vault",
      baseURL: "https://codex.test",
      headers: { "x-account": "account" },
    })
    const codex = await resolveProviderAttemptOptions("codex-chat", settings("codex-chat"))
    expect(codex.providerCredentials).toMatchObject({
      apiKey: "codex-vault",
      baseURL: "https://codex.test",
      headers: { "x-account": "account" },
    })
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
      resolveProviderAttemptOptions("opencode-chat", settings("opencode-chat"))
    ).resolves.toMatchObject({
      providerCredentials: {
        apiKey: "open-vault",
        baseURL: "https://open.test",
        protocol: "openai",
      },
      defaultModel: "opencode-chat-default",
    })

    mockResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "codex-vault",
      baseURL: "https://codex.test",
      headers: { authorization: "Bearer session" },
    })
    await expect(
      resolveProviderAttemptOptions("codex-chat", settings("codex-chat"))
    ).resolves.toMatchObject({
      providerCredentials: {
        apiKey: "codex-vault",
        headers: { authorization: "Bearer session" },
      },
      defaultModel: "codex-chat-default",
    })
  })

  it("returns no credentials for unavailable, explicitly disabled providers", async () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unavailable",
      nextAction: "enable_provider",
    })

    await expect(
      resolveProviderAttemptOptions("opencode-chat", settings("opencode-chat"))
    ).resolves.toEqual({})
    await expect(resolveProviderAttemptOptions("missing", settings("missing"))).resolves.toEqual({})
  })

  it("returns an empty result when an unresolved subscription provider has no vault session", async () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unavailable",
      nextAction: "configure_credentials",
    })
    mockResolveOpencodeVaultCredential.mockResolvedValue(undefined)
    mockResolveCodexVaultCredential.mockResolvedValue(undefined)

    await expect(
      resolveProviderAttemptOptions("opencode-chat", settings("opencode-chat"))
    ).resolves.toEqual({})
    await expect(
      resolveProviderAttemptOptions("codex-chat", settings("codex-chat"))
    ).resolves.toEqual({})
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
