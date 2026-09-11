const mockCreateLlmClient = jest.fn(() => ({ complete: jest.fn() }))

jest.mock("@/lib/twin/distill/llm", () => ({
  createLlmClient: (...args: unknown[]) => mockCreateLlmClient(...(args as [])),
}))

import { buildRendererLlmClient } from "./renderer-llm-client"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { externalAgentProviderId } from "@/lib/ai/agent/external/session-models"

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
  beforeEach(() => {
    mockCreateLlmClient.mockClear()
  })

  it("returns null when appSettings is missing", () => {
    expect(
      buildRendererLlmClient({ session: makeSession(), appSettings: null, featureId: "f" })
    ).toBeNull()
    expect(
      buildRendererLlmClient({ session: makeSession(), appSettings: undefined, featureId: "f" })
    ).toBeNull()
  })

  it("still builds a client when the app default belongs to an external agent", () => {
    // The marker names no provider, so `providerId` used to resolve to nothing
    // and this factory returned null for every renderer-side feature
    // (conversation titles, timeline labels, the /goal judge) as long as the
    // app default pointed at an agent. And `commandcode/...` is that agent's
    // vocabulary: sending it to a provider base URL is a guaranteed 4xx.
    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: makeSettings({
        defaultModel: "commandcode/meta/muse-spark-1.3-contributor",
        defaultProvider: externalAgentProviderId("pi-rpc"),
        providerSettings: {
          anthropic: { apiKey: "sk-test", enabled: true, defaultModel: "claude-sonnet-4-6" },
        },
      }),
      featureId: "conversation-title",
    })

    expect(client).not.toBeNull()
    // Asserted on a real call, not vacuously over an empty list.
    expect(mockCreateLlmClient).toHaveBeenCalledTimes(1)
    const arg = mockCreateLlmClient.mock.calls[0][0] as unknown as {
      model?: string
      provider?: string
    }
    expect(arg.model).toBe("claude-sonnet-4-6")
    expect(arg.provider).not.toContain("cognia:external-agent")
  })

  it("ignores an external-agent session override rather than resolving nothing", () => {
    // An external-agent conversation still wants a title. The row's marker is a
    // lane stamp, so a renderer-side utility call falls through to the app
    // default (here anthropic) instead of failing to resolve a provider.
    const client = buildRendererLlmClient({
      session: makeSession({
        providerOverride: externalAgentProviderId("pi-rpc"),
        model: "commandcode/meta/muse-spark-1.3-contributor",
      }),
      appSettings: makeSettings(),
      featureId: "conversation-title",
    })

    expect(client).not.toBeNull()
    const arg = mockCreateLlmClient.mock.calls[0][0] as unknown as { model?: string }
    expect(arg.model).not.toBe("commandcode/meta/muse-spark-1.3-contributor")
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

  it("forwards a resolved provider apiFlavor into createLlmClient", () => {
    const settings = makeSettings({
      defaultProvider: "openai",
      providerSettings: {
        openai: {
          apiKey: "sk-o",
          baseURL: "https://gateway.example/v1",
          defaultModel: "gpt-proxy",
          enabled: true,
          apiFlavor: "responses",
        },
      },
    })

    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: settings,
      featureId: "timeline-label",
    })

    expect(client).not.toBeNull()
    expect(mockCreateLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-proxy",
        baseURL: "https://gateway.example/v1",
        apiFlavor: "responses",
      })
    )
  })

  it("allows Azure renderer utility clients and forwards apiFlavor", () => {
    const settings = makeSettings({
      defaultProvider: "azure",
      providerSettings: {
        azure: {
          apiKey: "sk-azure",
          baseURL: "https://example.openai.azure.com",
          defaultModel: "gpt-5",
          enabled: true,
          apiFlavor: "responses",
        },
      },
    })

    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: settings,
      featureId: "conversation-title",
    })

    expect(client).not.toBeNull()
    expect(mockCreateLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure",
        model: "gpt-5",
        baseURL: "https://example.openai.azure.com",
        apiFlavor: "responses",
      })
    )
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
