import {
  buildProviderRegistration,
  canSwitchProvider,
  ccswitchProviderRefId,
  ccswitchApiKeyEnv,
} from "./provider"
import { ANTHROPIC_FALLBACK_MODEL_ID } from "@cognia/provider-types/built-in-provider-catalog"
import type { CcswitchProvider } from "@/types/ccswitch"

function provider(overrides: Partial<CcswitchProvider>): CcswitchProvider {
  return {
    id: "p1",
    kind: "claude",
    name: "Anthropic Official",
    apiKey: "sk-ant-x",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  }
}

describe("ccswitchProviderRefId", () => {
  it("prefixes the id", () => {
    expect(ccswitchProviderRefId(provider({ id: "abc" }))).toBe("ccswitch:claude:abc")
  })
})

describe("buildProviderRegistration", () => {
  const kimi = (): CcswitchProvider =>
    provider({
      id: "kimi",
      name: "Kimi",
      kind: "claude",
      apiKey: "sk-moon",
      baseUrl: "https://api.moonshot.cn/anthropic",
      model: "kimi-k2-0905",
      opusModel: "kimi-k2-thinking",
      sonnetModel: "kimi-k2-0905",
      haikuModel: "kimi-k2-turbo",
      smallFastModel: "kimi-k2-turbo",
      customHeaders: { "anthropic-beta": "context-1m-2025-08-07" },
    })

  it("registers the relay's tier models under the anthropic provider", () => {
    const reg = buildProviderRegistration(kimi(), {})
    expect(reg).not.toBeNull()
    const a = reg!.providerSettings.anthropic
    expect(a.enabled).toBe(true)
    expect(a.apiKey).toBe("sk-moon")
    expect(a.baseURL).toBe("https://api.moonshot.cn/anthropic")
    expect(a.customHeaders).toEqual(kimi().customHeaders)
    // Deduped by id, priority order preserved (opus, sonnet(dupe id dropped),
    // haiku, small-fast(dupe id dropped), primary(dupe id dropped)).
    expect(a.enabledModels).toEqual(["kimi-k2-thinking", "kimi-k2-0905", "kimi-k2-turbo"])
    expect(reg!.defaultProvider).toBe("anthropic")
    // Primary = ANTHROPIC_MODEL.
    expect(reg!.defaultModel).toBe("kimi-k2-0905")
  })

  it("stamps a 1M context window on every tier when the beta header is present", () => {
    const reg = buildProviderRegistration(kimi(), {})
    const models = reg!.providerSettings.anthropic.discoveredModels ?? []
    expect(models).toHaveLength(3)
    expect(models.every((m) => m.contextLength === 1_000_000)).toBe(true)
    expect(models[0]).toMatchObject({ id: "kimi-k2-thinking", name: "Kimi · Opus" })
    expect(reg!.customHeaders).toEqual({ "anthropic-beta": "context-1m-2025-08-07" })
  })

  it("does not stamp 1M without a context-1m header", () => {
    const reg = buildProviderRegistration({ ...kimi(), customHeaders: undefined }, {})
    const models = reg!.providerSettings.anthropic.discoveredModels ?? []
    expect(models.every((m) => m.contextLength === undefined)).toBe(true)
    expect(reg!.customHeaders).toEqual({})
  })

  it("preserves other providers when merging the anthropic slot", () => {
    const reg = buildProviderRegistration(kimi(), {
      providerSettings: {
        openai: { providerId: "openai", defaultModel: "gpt-4o", enabled: true },
      },
    })
    expect(reg!.providerSettings.openai).toBeDefined()
    expect(reg!.providerSettings.anthropic).toBeDefined()
  })

  it("is provider-agnostic — a GLM coding-plan relay registers identically", () => {
    // Same code path as Kimi, keyed off env shape not provider identity: GLM's
    // Anthropic-compatible coding endpoint declares its own tier models + 1M
    // header and must surface with zero provider-specific handling.
    const glm = provider({
      id: "glm",
      name: "GLM Coding",
      kind: "claude",
      apiKey: "glm-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      model: "glm-4.6",
      sonnetModel: "glm-4.6",
      haikuModel: "glm-4.5-air",
      customHeaders: { "anthropic-beta": "context-1m-2025-08-07" },
    })
    const reg = buildProviderRegistration(glm, {})
    expect(reg).not.toBeNull()
    expect(reg!.providerSettings.anthropic.enabledModels).toEqual(["glm-4.6", "glm-4.5-air"])
    expect(reg!.defaultModel).toBe("glm-4.6")
    const models = reg!.providerSettings.anthropic.discoveredModels ?? []
    expect(models.every((m) => m.contextLength === 1_000_000)).toBe(true)
    expect(models.map((m) => m.name)).toEqual(["GLM Coding · Sonnet", "GLM Coding · Haiku"])
  })

  it("registers a single-model relay that only declares ANTHROPIC_MODEL", () => {
    // Many coding plans set just ANTHROPIC_MODEL (no tier overrides) — still
    // must produce a one-model registration, not an empty group.
    const reg = buildProviderRegistration(
      provider({ id: "solo", name: "Solo Plan", kind: "claude", model: "some-coder-model" }),
      {}
    )
    expect(reg!.providerSettings.anthropic.enabledModels).toEqual(["some-coder-model"])
    expect(reg!.defaultModel).toBe("some-coder-model")
  })

  it("returns null for non-claude kinds", () => {
    expect(buildProviderRegistration(provider({ kind: "codex" }), {})).toBeNull()
    expect(buildProviderRegistration(provider({ kind: "gemini" }), {})).toBeNull()
  })

  it("updates credentials and the endpoint even when no models are declared", () => {
    const reg = buildProviderRegistration(provider({ model: undefined }), {})!
    expect(reg.defaultModel).toBe(ANTHROPIC_FALLBACK_MODEL_ID)
    expect(reg.providerSettings.anthropic).toMatchObject({
      apiKey: "sk-ant-x",
      baseURL: "https://api.anthropic.com",
    })
  })

  it("clears relay credentials, endpoint and headers for an official provider", () => {
    const reg = buildProviderRegistration(provider({ apiKey: undefined, baseUrl: undefined }), {
      providerSettings: {
        anthropic: {
          providerId: "anthropic",
          apiKey: "old",
          enabled: true,
          defaultModel: "old-model",
          baseURL: "https://old.test",
          customHeaders: { "X-Route": "old" },
        },
      },
    })!
    expect(reg.providerSettings.anthropic.apiKey).toBeUndefined()
    expect(reg.providerSettings.anthropic.baseURL).toBeUndefined()
    expect(reg.providerSettings.anthropic.customHeaders).toEqual({})
  })

  it("does not guess a missing app type", () => {
    expect(canSwitchProvider(provider({ kind: undefined }))).toBe(false)
    expect(canSwitchProvider(provider({ kind: "claude" }))).toBe(true)
    expect(canSwitchProvider(provider({ kind: "codex" }))).toBe(false)
  })
})

describe("ccswitchApiKeyEnv", () => {
  it("restores the selected relay per turn without an OAuth account", () => {
    expect(
      ccswitchApiKeyEnv({
        activeProviderId: "ccswitch:claude:native",
        apiKey: "key",
        apiBaseUrl: "http://127.0.0.1:18994/a",
        providerSettings: {
          anthropic: {
            providerId: "anthropic",
            enabled: true,
            defaultModel: "native-model",
            customHeaders: { "X-Route": "native" },
          },
        },
      })
    ).toEqual({
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18994/a",
      ANTHROPIC_CUSTOM_HEADERS: "X-Route: native",
    })
  })
  it("does not turn another app, a manual provider or an official login into a relay", () => {
    for (const activeProviderId of ["ccswitch:codex:x", "anthropic", undefined])
      expect(ccswitchApiKeyEnv({ activeProviderId, apiKey: "key" })).toBeNull()
    expect(ccswitchApiKeyEnv({ activeProviderId: "ccswitch:claude:x" })).toBeNull()
  })
})
