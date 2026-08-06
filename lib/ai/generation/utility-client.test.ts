import { buildUtilityLlmClient, inferCheapModel } from "./utility-client"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

const createLlmClientMock = jest.fn((config: unknown) => ({
  __config: config,
  complete: jest.fn(),
}))

jest.mock("@/lib/twin/distill/llm", () => ({
  createLlmClient: (config: unknown) => createLlmClientMock(config),
}))

function appSettings(partial: Record<string, unknown> = {}): AppSettings {
  return {
    id: "singleton",
    alwaysAllowTools: [],
    builtinTools: {},
    ...partial,
  } as unknown as AppSettings
}

beforeEach(() => createLlmClientMock.mockClear())

describe("inferCheapModel", () => {
  it("returns haiku for anthropic provider", () => {
    expect(inferCheapModel(null, appSettings({ defaultProvider: "anthropic" }))).toBe(
      "claude-haiku-4-5-20251001"
    )
  })

  it("returns gpt-4o-mini for openai provider", () => {
    expect(inferCheapModel(null, appSettings({ defaultProvider: "openai" }))).toBe("gpt-4o-mini")
  })

  it("returns undefined for unknown/custom providers", () => {
    expect(inferCheapModel(null, appSettings({ defaultProvider: "custom-llm" }))).toBeUndefined()
  })

  it("uses session providerOverride over appSettings default", () => {
    const session = { providerOverride: "openai" } as ChatSession
    expect(inferCheapModel(session, appSettings({ defaultProvider: "anthropic" }))).toBe(
      "gpt-4o-mini"
    )
  })

  it("defaults to anthropic when no provider is set", () => {
    expect(inferCheapModel(null, appSettings({}))).toBe("claude-haiku-4-5-20251001")
  })
})

describe("buildUtilityLlmClient", () => {
  it("returns null when appSettings is missing", () => {
    expect(
      buildUtilityLlmClient({ session: null, appSettings: null, featureId: "title" })
    ).toBeNull()
  })

  it("returns null when the provider is not configured", () => {
    const result = buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({ defaultProvider: "openai" }),
      featureId: "title",
    })
    expect(result).toBeNull()
    expect(createLlmClientMock).not.toHaveBeenCalled()
  })

  it("returns null when resolved but no renderer API key (base-url-only)", () => {
    const result = buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { baseURL: "http://local" } },
      }),
      featureId: "title",
    })
    expect(result).toBeNull()
  })

  it("builds a client using the cheap model preference when no override", () => {
    buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-1", defaultModel: "gpt-4o" } },
      }),
      featureId: "title",
    })
    // The cheap model preference (gpt-4o-mini) should win over the provider default.
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-1" })
    )
  })

  it("override model beats the cheap preference", () => {
    buildUtilityLlmClient({
      session: { providerOverride: "anthropic", model: "claude-x" } as ChatSession,
      appSettings: appSettings({
        defaultProvider: "openai",
        defaultModel: "gpt-4o-mini",
        providerSettings: {
          openai: { apiKey: "sk-1" },
          anthropic: { apiKey: "sk-ant" },
        },
      }),
      override: { providerOverride: "anthropic", model: "claude-haiku-4-5" },
      featureId: "title",
    })
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        apiKey: "sk-ant",
      })
    )
  })

  it("does not inject cheap preference when override.model is set", () => {
    buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-1", defaultModel: "gpt-4o" } },
      }),
      override: { model: "custom-model" },
      featureId: "title",
    })
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "custom-model" })
    )
  })

  it("cheap preference beats session model for known providers", () => {
    buildUtilityLlmClient({
      session: { model: "expensive-session-model" } as ChatSession,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-1", defaultModel: "gpt-4o" } },
      }),
      featureId: "label",
    })
    // gpt-4o-mini (cheap preference) wins over expensive-session-model
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" })
    )
  })

  it("falls back to session model for unknown providers (no cheap preference)", () => {
    buildUtilityLlmClient({
      session: { model: "session-model", providerOverride: "custom-llm" } as ChatSession,
      appSettings: appSettings({
        defaultProvider: "custom-llm",
        providerSettings: { "custom-llm": { apiKey: "sk-custom", defaultModel: "llm-v1" } },
      }),
      featureId: "label",
    })
    // No cheap preference for custom-llm → session model used
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "session-model" })
    )
  })
})
