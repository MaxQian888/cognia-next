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
  it("prefers the active provider's remembered model over a top-level pin", () => {
    const config = makeConfig({
      provider: "deepseek",
      model: "my-pinned-model",
      providers: { deepseek: { model: "deepseek-reasoner" } },
    })
    expect(resolveActiveModel(config)).toBe("deepseek-reasoner")
  })

  it("uses the active provider's remembered model", () => {
    const config = makeConfig({
      provider: "deepseek",
      providers: { deepseek: { apiKey: "k", model: "deepseek-reasoner" } },
    })
    expect(resolveActiveModel(config)).toBe("deepseek-reasoner")
  })

  it("falls back to the provider's catalog default when no model is remembered", () => {
    const config = makeConfig({ provider: "deepseek", providers: { deepseek: { apiKey: "k" } } })
    expect(resolveActiveModel(config)).toBe("deepseek-chat")
  })

  it("does NOT bleed a stale top-level model into another provider with a catalog default", () => {
    // Regression: a Claude id left in the global `model` pin must not show for
    // DeepSeek — the provider's own catalog default wins instead.
    const config = makeConfig({
      provider: "deepseek",
      model: "claude-opus-4-8",
      providers: {},
    })
    expect(resolveActiveModel(config)).toBe("deepseek-chat")
  })

  it("defaults to the anthropic catalog when nothing is set", () => {
    expect(resolveActiveModel(makeConfig())).toBe("claude-opus-4-8")
  })

  it("uses a top-level model only as a last resort (unknown provider, no catalog)", () => {
    expect(resolveActiveModel(makeConfig({ provider: "mystery", model: "x" }))).toBe("x")
  })

  it("returns undefined for an unknown provider with no configuration", () => {
    expect(resolveActiveModel(makeConfig({ provider: "mystery" }))).toBeUndefined()
  })
})
