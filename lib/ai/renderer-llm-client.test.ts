import { buildRendererLlmClient } from "./renderer-llm-client"
import type { AppSettings, ChatSession } from "@/lib/claude/types"

/**
 * Exercises the real provider-resolution chain
 * (`createProviderSettingsSnapshot` + `resolveFeatureProvider`); the eventual
 * `createLlmClient` SDK import is lazy, so no network/SDK loads here.
 */

function makeSettings(over: Record<string, unknown> = {}): AppSettings {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    providerSettings: { anthropic: { apiKey: "sk-test", enabled: true } },
    ...over,
  } as unknown as AppSettings
}

function makeSession(over: Record<string, unknown> = {}): ChatSession {
  return { id: "s1", ...over } as unknown as ChatSession
}

describe("buildRendererLlmClient", () => {
  it("returns null when appSettings is missing", () => {
    expect(
      buildRendererLlmClient({ session: makeSession(), appSettings: null, featureId: "f" })
    ).toBeNull()
    expect(
      buildRendererLlmClient({ session: makeSession(), appSettings: undefined, featureId: "f" })
    ).toBeNull()
  })

  it("builds a client when the default provider resolves with a key", () => {
    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: makeSettings(),
      featureId: "conversation-title",
    })
    expect(client).not.toBeNull()
    expect(typeof client?.complete).toBe("function")
  })

  it("returns null when the resolved provider has no renderer key", () => {
    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: makeSettings({ providerSettings: {} }),
      featureId: "f",
    })
    expect(client).toBeNull()
  })

  it("returns null when no model can be determined", () => {
    const client = buildRendererLlmClient({
      session: makeSession({ model: undefined }),
      appSettings: makeSettings({ defaultModel: undefined }),
      featureId: "f",
    })
    expect(client).toBeNull()
  })

  it("honors the explicit provider + model override", () => {
    const settings = makeSettings({
      providerSettings: {
        anthropic: { apiKey: "sk-a", enabled: true },
        openai: { apiKey: "sk-o", enabled: true },
      },
    })
    const client = buildRendererLlmClient({
      session: makeSession({ model: "gpt-x" }),
      appSettings: settings,
      featureId: "timeline-label",
      providerOverride: "openai",
      modelOverride: "gpt-label",
    })
    expect(client).not.toBeNull()
  })

  it("returns null when the override provider is unconfigured", () => {
    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: makeSettings(),
      featureId: "f",
      providerOverride: "ghost",
    })
    expect(client).toBeNull()
  })
})
