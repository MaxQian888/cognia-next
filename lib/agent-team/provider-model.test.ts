import type { AppSettings } from "@/lib/claude/types"
import {
  createFeatureProviderModel,
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import { buildTeamClaudeRuntimeModel } from "./provider-model"

jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: jest.fn((input: unknown) => ({ snapshot: input })),
  resolveFeatureProvider: jest.fn(),
  createFeatureProviderModel: jest.fn((resolved: unknown) => ({ resolved })),
}))

const mockCreateProviderSettingsSnapshot = createProviderSettingsSnapshot as jest.Mock
const mockResolveFeatureProvider = resolveFeatureProvider as jest.Mock
const mockCreateFeatureProviderModel = createFeatureProviderModel as jest.Mock

describe("buildTeamClaudeRuntimeModel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("builds the team streamer model from the configured provider resolution", () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "resolved",
      providerId: "openrouter",
      protocol: "openai",
      apiFlavor: "responses",
      apiKey: "sk-or-v1-test",
      baseURL: "https://openrouter.ai/api/v1",
      model: "openrouter/auto",
      isCustomProvider: false,
      useProxy: false,
    })

    const settings = {
      id: "singleton",
      defaultProvider: "openrouter",
      providerSettings: {
        openrouter: {
          enabled: true,
          apiKey: "sk-or-v1-test",
          defaultModel: "openrouter/auto",
          apiFlavor: "responses",
        },
      },
    } as unknown as AppSettings

    buildTeamClaudeRuntimeModel(settings)

    expect(mockCreateProviderSettingsSnapshot).toHaveBeenCalledWith({
      defaultProvider: "openrouter",
      providerSettings: settings.providerSettings,
      customProviders: undefined,
    })
    expect(mockResolveFeatureProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: "agent-team-claude-runtime",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openrouter",
        fallbackMode: "none",
      }),
      { snapshot: expect.any(Object) }
    )
    expect(mockCreateFeatureProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openrouter",
        protocol: "openai",
        apiFlavor: "responses",
        apiKey: "sk-or-v1-test",
        baseURL: "https://openrouter.ai/api/v1",
        model: "openrouter/auto",
      })
    )
  })

  it("preserves the legacy Anthropic settings fallback when provider settings cannot resolve", () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "unresolved",
      reason: "Provider is not configured.",
      attemptedProviderIds: ["openrouter"],
    })

    buildTeamClaudeRuntimeModel({
      id: "singleton",
      defaultProvider: "openrouter",
      apiKey: "legacy-anthropic-key",
      defaultModel: "claude-sonnet-4-5",
    } as AppSettings)

    expect(mockCreateFeatureProviderModel).toHaveBeenCalledWith({
      kind: "resolved",
      providerId: "anthropic",
      protocol: "anthropic",
      apiKey: "legacy-anthropic-key",
      baseURL: undefined,
      model: "claude-sonnet-4-5",
      isCustomProvider: false,
      useProxy: false,
    })
  })

  it("falls back to the legacy Anthropic model for sidecar-only provider protocols", () => {
    mockResolveFeatureProvider.mockReturnValue({
      kind: "resolved",
      providerId: "bedrock",
      protocol: "bedrock",
      apiKey: "aws-key",
      baseURL: undefined,
      model: "amazon.nova-pro-v1:0",
      isCustomProvider: false,
      useProxy: false,
    })

    buildTeamClaudeRuntimeModel({
      id: "singleton",
      defaultProvider: "bedrock",
      apiKey: "legacy-anthropic-key",
      defaultModel: "claude-sonnet-4-5",
    } as AppSettings)

    expect(mockCreateFeatureProviderModel).toHaveBeenCalledWith({
      kind: "resolved",
      providerId: "anthropic",
      protocol: "anthropic",
      apiKey: "legacy-anthropic-key",
      baseURL: undefined,
      model: "claude-sonnet-4-5",
      isCustomProvider: false,
      useProxy: false,
    })
  })
})
