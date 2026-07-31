import { buildUtilityLlmClient } from "./utility-client"
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

  it("returns null when no model can be determined", () => {
    const result = buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-1" } },
      }),
      featureId: "title",
    })
    expect(result).toBeNull()
  })

  it("builds a client using the provider default model + key", () => {
    buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-1", defaultModel: "gpt-4o-mini" } },
      }),
      featureId: "title",
    })
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-1" })
    )
  })

  it("override provider/model beats session and app defaults", () => {
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

  it("falls back to the session model when no override model is set", () => {
    buildUtilityLlmClient({
      session: { model: "session-model" } as ChatSession,
      appSettings: appSettings({
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-1" } },
      }),
      featureId: "label",
    })
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "session-model" })
    )
  })

  it("falls back to the app default model last", () => {
    buildUtilityLlmClient({
      session: null,
      appSettings: appSettings({
        defaultProvider: "openai",
        defaultModel: "app-default",
        providerSettings: { openai: { apiKey: "sk-1" } },
      }),
      featureId: "label",
    })
    expect(createLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "app-default" })
    )
  })
})
