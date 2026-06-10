/**
 * @jest-environment node
 */
import { toBuildContext } from "./to-build-context"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "./schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

function cfg(p: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: "/work",
    ...p,
  }
}

const NOW = 1_700_000_000_000

describe("toBuildContext — session + appSettings shaping", () => {
  it("feeds model/provider/systemPrompt/cwd/permissionMode through the fields resolveSendOptions reads", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "openai",
        model: "gpt-x",
        systemPrompt: "be terse",
        permissionMode: "acceptEdits",
        cwd: "/proj",
      }),
    })
    // session is highest precedence in resolveSendOptions for these fields.
    expect(ctx.session).toMatchObject({
      id: "s1",
      kind: "direct",
      model: "gpt-x",
      providerOverride: "openai",
      systemPrompt: "be terse",
      workingDir: "/proj",
      permissionMode: "acceptEdits",
    })
    expect(ctx.appSettings?.defaultProvider).toBe("openai")
    expect(ctx.appSettings?.builtinTools).toEqual(ctx.appSettings?.builtinTools)
  })

  it("injects the CLI seams: agentMode null, empty preloadedMcpServers", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg() })
    expect(ctx.agentMode).toBeNull()
    expect(ctx.preloadedMcpServers).toEqual([])
  })

  it("forwards builtinTools toggles into appSettings", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ builtinTools: { ...DEFAULT_BUILTIN_TOOLS, process: true } }),
    })
    expect(ctx.appSettings?.builtinTools?.process).toBe(true)
  })
})

describe("toBuildContext — provider credentials", () => {
  it("builds providerSettings from config.providers (for the ai-sdk path)", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "openai",
        providers: { openai: { apiKey: "sk-o", baseURL: "https://x", model: "gpt-y" } },
      }),
    })
    expect(ctx.appSettings?.providerSettings?.openai).toEqual({
      enabled: true,
      apiKey: "sk-o",
      baseURL: "https://x",
      defaultModel: "gpt-y",
    })
  })

  it("emits customProviders for entries with an explicit protocol", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "my-llm",
        providers: { "my-llm": { apiKey: "k", baseURL: "https://h/v1", protocol: "openai" } },
      }),
    })
    expect(ctx.appSettings?.customProviders).toEqual([
      { id: "my-llm", name: "my-llm", protocol: "openai", baseURL: "https://h/v1", apiKey: "k" },
    ])
  })

  it("omits customProviders when no entry carries a protocol", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ providers: { anthropic: { apiKey: "k" } } }),
    })
    expect(ctx.appSettings?.customProviders).toBeUndefined()
  })
})

describe("toBuildContext — preloadedEnv (native Anthropic auth)", () => {
  it("maps the anthropic key + base url into env for the native path", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "anthropic",
        providers: { anthropic: { apiKey: "sk-ant", baseURL: "https://api.x" } },
      }),
    })
    expect(ctx.preloadedEnv).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://api.x",
    })
  })

  it("is empty for non-Anthropic providers (ai-sdk path uses providerCredentials)", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "openai", providers: { openai: { apiKey: "sk-o" } } }),
    })
    expect(ctx.preloadedEnv).toEqual({})
  })
})

describe("toBuildContext — allowedTools shim", () => {
  it("attaches a character carrying allowedTools when configured", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ allowedTools: ["Read", "Bash"] }),
    })
    expect(ctx.character?.allowedTools).toEqual(["Read", "Bash"])
    expect(ctx.character?.systemPrompt).toBe("") // never leaks; session prompt wins
  })

  it("uses no character when allowedTools is unset", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg() })
    expect(ctx.character).toBeNull()
  })
})
