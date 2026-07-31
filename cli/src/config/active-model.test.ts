import { resolveActiveModel, resolveBackendModel } from "./active-model"
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

describe("resolveBackendModel", () => {
  it("falls through to the built-in resolution when no external backend hosts", () => {
    const config = makeConfig({ provider: "deepseek", providers: { deepseek: {} } })
    expect(resolveBackendModel(config)).toBe("deepseek-chat")
    expect(resolveBackendModel({ ...config, agentBackend: "builtin" })).toBe("deepseek-chat")
  })

  it("sends NO model for an external backend the user never picked one for", () => {
    // The whole point: absent means "the agent uses its own config"
    // (`~/.codex/config.toml`). The built-in provider's catalog default is not a
    // stand-in for it — that was the bug this function exists to prevent.
    const config = makeConfig({
      provider: "anthropic",
      agentBackend: "codex",
      providers: { anthropic: { model: "claude-opus-4-8" } },
    })
    expect(resolveBackendModel(config, "codex-app-server")).toBeUndefined()
  })

  it("uses the model remembered for the resolved preset", () => {
    const config = makeConfig({
      agentBackend: "codex",
      agentBackends: { "codex-app-server": { model: "gpt-5.6-sol" } },
    })
    expect(resolveBackendModel(config, "codex-app-server")).toBe("gpt-5.6-sol")
  })

  it("falls back to the alias the user typed when the preset has no entry", () => {
    // `--backend codex` resolves to `codex-app-server` only after probing, so a
    // model stored under the alias must still be found before that happens.
    const config = makeConfig({
      agentBackend: "codex",
      agentBackends: { codex: { model: "gpt-5.2-codex" } },
    })
    expect(resolveBackendModel(config)).toBe("gpt-5.2-codex")
    expect(resolveBackendModel(config, "codex-app-server")).toBe("gpt-5.2-codex")
  })

  it("prefers the resolved preset's entry over the alias", () => {
    const config = makeConfig({
      agentBackend: "codex",
      agentBackends: { codex: { model: "shim-model" }, "codex-app-server": { model: "native" } },
    })
    expect(resolveBackendModel(config, "codex-app-server")).toBe("native")
  })

  it("keeps each external backend's memory separate from the chat providers", () => {
    // Anti-regression: the preset→provider mapping sends `claude-code` to
    // `anthropic`, so storing backend models in `config.providers` would make a
    // Claude Code model pick silently rewrite the built-in Anthropic model.
    const config = makeConfig({
      provider: "anthropic",
      agentBackend: "claude-code",
      providers: { anthropic: { model: "claude-opus-4-8" } },
      agentBackends: { "claude-code": { model: "some-acp-model" } },
    })
    expect(resolveBackendModel(config, "claude-code")).toBe("some-acp-model")
    // The built-in provider's own model is untouched by the backend memory.
    expect(resolveActiveModel(config)).toBe("claude-opus-4-8")
  })
})
