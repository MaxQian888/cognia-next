import { buildLeadExecutionConfig, LeadProviderConfigurationError } from "./lead-execution"
import type { AppSettings } from "@cognia/agent-config-types"
import type { AgentTeammate } from "@/types/agent/agent-team"

function makeLead(config: AgentTeammate["config"] = {}): Pick<AgentTeammate, "config"> {
  return { config }
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-8",
    providerSettings: {
      anthropic: { enabled: true, apiKey: "sk-ant-test", defaultModel: "claude-opus-4-8" },
    },
    ...overrides,
  } as AppSettings
}

describe("buildLeadExecutionConfig", () => {
  it("threads the app's provider snapshot through so the lead can resolve at all", () => {
    // The whole point of the module: `executeAgent` reads no store, so unless
    // these three land in its config the resolver builds zero candidates.
    const cfg = buildLeadExecutionConfig({ lead: makeLead(), settings: makeSettings() })

    expect(cfg.providerSettings).toEqual({
      anthropic: { enabled: true, apiKey: "sk-ant-test", defaultModel: "claude-opus-4-8" },
    })
    expect(cfg.defaultProvider).toBe("anthropic")
  })

  it("falls back to the application default provider and model", () => {
    const cfg = buildLeadExecutionConfig({ lead: makeLead(), settings: makeSettings() })

    expect(cfg.provider).toBeUndefined()
    expect(cfg.defaultProvider).toBe("anthropic")
    expect(cfg.model).toBe("claude-opus-4-8")
  })

  it("prefers an explicit lead provider and model over the application defaults", () => {
    const cfg = buildLeadExecutionConfig({
      lead: makeLead({ provider: "openai", model: "gpt-5.6-sol" }),
      settings: makeSettings(),
    })

    expect(cfg.provider).toBe("openai")
    expect(cfg.model).toBe("gpt-5.6-sol")
  })

  it("does not leak the app default model into a lead-pinned different provider", () => {
    // Regression guard: `executeAgent` applies `config.model ?? resolution.model`,
    // so passing the global default model alongside a pinned provider would send
    // e.g. a Claude model id to OpenAI. With no lead model, the pinned provider's
    // own configured model must win — which means sending no model at all.
    const cfg = buildLeadExecutionConfig({
      lead: makeLead({ provider: "openai" }),
      settings: makeSettings({ defaultModel: "claude-opus-4-8" }),
    })

    expect(cfg.provider).toBe("openai")
    expect(cfg.model).toBeUndefined()
  })

  it("still applies the app default model when the lead pins the app default provider", () => {
    const cfg = buildLeadExecutionConfig({
      lead: makeLead({ provider: "anthropic" }),
      settings: makeSettings({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" }),
    })

    expect(cfg.model).toBe("claude-opus-4-8")
  })

  it("passes custom providers through so a custom-provider lead resolves", () => {
    const customProviders = [
      {
        id: "my-gateway",
        name: "My Gateway",
        isCustom: true as const,
        enabled: true,
        apiProtocol: "openai",
        baseURL: "https://gateway.example/v1",
        apiKey: "sk-gw",
        defaultModel: "gpt-5.6-sol",
      },
    ]
    const cfg = buildLeadExecutionConfig({
      lead: makeLead({ provider: "my-gateway" as never }),
      settings: makeSettings({
        customProviders: customProviders as unknown as AppSettings["customProviders"],
      }),
    })

    expect(cfg.provider).toBe("my-gateway")
    expect(cfg.customProviders).toHaveLength(1)
    expect(cfg.customProviders?.[0]?.id).toBe("my-gateway")
  })

  describe("when nothing is configured", () => {
    // The pre-fix failure was `executeAgent: No candidate providers were
    // available.` — true but useless: it names no subject and no next step.
    it("throws an actionable error naming the lead and the fix", () => {
      expect(() =>
        buildLeadExecutionConfig({
          lead: makeLead(),
          settings: makeSettings({ providerSettings: {}, customProviders: [] }),
        })
      ).toThrow(LeadProviderConfigurationError)
    })

    it("names the subject and the next step in the message", () => {
      let message = ""
      try {
        buildLeadExecutionConfig({
          lead: makeLead(),
          settings: makeSettings({ providerSettings: {}, customProviders: [] }),
        })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain("lead")
      expect(message).toContain("Settings")
      expect(message).not.toContain("No candidate providers were available")
    })

    it("throws when settings have not loaded at all", () => {
      expect(() => buildLeadExecutionConfig({ lead: makeLead(), settings: null })).toThrow(
        LeadProviderConfigurationError
      )
    })

    it("sends no defaultProvider when the app has not chosen one", () => {
      // executeAgent then resolves "any" over the configured providers rather
      // than being pinned to a provider the user never picked.
      const cfg = buildLeadExecutionConfig({
        lead: makeLead(),
        settings: makeSettings({ defaultProvider: undefined, defaultModel: undefined }),
      })
      expect(cfg).not.toHaveProperty("defaultProvider")
      expect(cfg).not.toHaveProperty("model")
    })

    it("omits providerSettings entirely when only custom providers exist", () => {
      const cfg = buildLeadExecutionConfig({
        lead: makeLead(),
        settings: makeSettings({
          providerSettings: undefined,
          customProviders: [
            { id: "gw", name: "GW", baseURL: "https://x/v1" },
          ] as unknown as AppSettings["customProviders"],
        }),
      })
      expect(cfg).not.toHaveProperty("providerSettings")
      expect(cfg.customProviders).toHaveLength(1)
    })

    it("counts a custom provider as configured", () => {
      const cfg = buildLeadExecutionConfig({
        lead: makeLead(),
        settings: makeSettings({
          providerSettings: {},
          customProviders: [
            { id: "gw", name: "GW", baseURL: "https://x/v1" },
          ] as unknown as AppSettings["customProviders"],
        }),
      })
      expect(cfg.customProviders).toHaveLength(1)
    })
  })
})
