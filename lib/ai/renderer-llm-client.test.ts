const mockCreateLlmClient = jest.fn((..._args: unknown[]) => ({ complete: jest.fn() }))

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

  it("[ACC:OFF-01] hands back the client it built while Router + Fusion is off", () => {
    // The default for every user: the ledger seam is a pass-through, so a
    // utility call is byte-for-byte the call it was before ADR-0188.
    const built = { complete: jest.fn() }
    mockCreateLlmClient.mockReturnValueOnce(built)
    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: makeSettings(),
      featureId: "conversation-title",
    })
    expect(client).toBe(built)
  })

  it("wraps the client for the ledger once the utility switch is on", () => {
    const built = { complete: jest.fn() }
    mockCreateLlmClient.mockReturnValueOnce(built)
    const client = buildRendererLlmClient({
      session: makeSession(),
      appSettings: makeSettings({
        routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
      }),
      featureId: "conversation-title",
    })
    expect(client).not.toBe(built)
    expect(typeof client?.complete).toBe("function")
  })

  it("routes a workflow's own call to the agents/workflows surface, not the utility one", () => {
    const built = { complete: jest.fn() }
    mockCreateLlmClient.mockReturnValueOnce(built)
    // `agentsWorkflows` is off here, so this one is untouched even though the
    // utility switch is on: a surface is opted into on its own (D36).
    expect(
      buildRendererLlmClient({
        session: makeSession(),
        appSettings: makeSettings({
          routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
        }),
        featureId: "workflow-node",
        ledgerSurface: "agentsWorkflows",
      })
    ).toBe(built)
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

  it('treats a session model of "auto" as unset — the placeholder is not a model id', () => {
    // The send path resolves "auto" through the routing engine; a renderer-side
    // utility call has no engine, so forwarding "auto" verbatim would hand a
    // provider a model it does not have.
    const client = buildRendererLlmClient({
      session: makeSession({ model: "auto" }),
      appSettings: makeSettings(),
      featureId: "conversation-title",
    })
    expect(client).not.toBeNull()
    const arg = mockCreateLlmClient.mock.calls[0][0] as unknown as { model?: string }
    expect(arg.model).toBe("claude-sonnet-4-6")
  })

  it("treats an enabled mapping alias as a placeholder, a disabled one as a real id", () => {
    const mappings = [
      {
        id: "m1",
        alias: "fast",
        providers: [{ providerId: "anthropic", modelId: "claude-haiku-4-5" }],
        distribution: "priority",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "m2",
        alias: "slow-alias",
        providers: [{ providerId: "anthropic", modelId: "claude-x" }],
        distribution: "priority",
        enabled: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const settings = makeSettings({ modelMappings: mappings })

    buildRendererLlmClient({
      session: makeSession({ model: "fast" }),
      appSettings: settings,
      featureId: "f",
    })
    let arg = mockCreateLlmClient.mock.calls.at(-1)?.[0] as unknown as { model?: string }
    expect(arg.model).toBe("claude-sonnet-4-6")

    // A DISABLED alias name is not a routing placeholder: if a session carries
    // it, it is a concrete (if unusual) model id and stays verbatim.
    buildRendererLlmClient({
      session: makeSession({ model: "slow-alias" }),
      appSettings: settings,
      featureId: "f",
    })
    arg = mockCreateLlmClient.mock.calls.at(-1)?.[0] as unknown as { model?: string }
    expect(arg.model).toBe("slow-alias")
  })
})
