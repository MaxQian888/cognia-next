import { resolveActiveModel } from "./active-model"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "./schema"

jest.mock("@/lib/ai/model-options", () => ({
  catalogModelIds: (provider: string) =>
    provider === "anthropic"
      ? ["claude-opus-4-8", "claude-sonnet-4-6"]
      : provider === "deepseek"
        ? ["deepseek-chat", "deepseek-reasoner"]
        : [],
}))

function makeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_RESOLVED_CONFIG.builtinTools },
    providers: {},
    cwd: "/tmp",
    ...over,
  }
}

describe("resolveActiveModel", () => {
  it("prefers an explicit top-level model", () => {
    const config = makeConfig({
      provider: "deepseek",
      model: "my-pinned-model",
      providers: { deepseek: { model: "deepseek-reasoner" } },
    })
    expect(resolveActiveModel(config)).toBe("my-pinned-model")
  })

  it("falls back to the active provider's configured model", () => {
    const config = makeConfig({
      provider: "deepseek",
      providers: { deepseek: { apiKey: "k", model: "deepseek-reasoner" } },
    })
    expect(resolveActiveModel(config)).toBe("deepseek-reasoner")
  })

  it("falls back to the provider's catalog default when no model is configured", () => {
    const config = makeConfig({ provider: "deepseek", providers: { deepseek: { apiKey: "k" } } })
    expect(resolveActiveModel(config)).toBe("deepseek-chat")
  })

  it("defaults to the anthropic catalog when nothing is set", () => {
    expect(resolveActiveModel(makeConfig())).toBe("claude-opus-4-8")
  })

  it("returns undefined for an unknown provider with no configuration", () => {
    expect(resolveActiveModel(makeConfig({ provider: "mystery" }))).toBeUndefined()
  })
})
