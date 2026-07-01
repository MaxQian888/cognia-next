/**
 * @jest-environment node
 */
import { toBuildContext } from "./to-build-context"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "./schema"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

function cfg(p: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const base: ResolvedConfig = {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: "/work",
    ...p,
  }
  // Mirror loadConfig: a top-level `model` is remembered under the active
  // provider so resolveActiveModel (per-provider precedence) returns it.
  if (base.model && !base.providers[base.provider]?.model) {
    base.providers = {
      ...base.providers,
      [base.provider]: { ...base.providers[base.provider], model: base.model },
    }
  }
  return base
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

  it("falls back to the default base prompt when none is configured", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ cwd: "/work/here" }),
    })
    const prompt = (ctx.session as { systemPrompt?: string }).systemPrompt ?? ""
    expect(prompt).toContain("Working directory: /work/here")
    expect(prompt).toMatch(/prefer the `edit` tool/i)
    expect(ctx.appSettings?.defaultSystemPrompt).toContain("Working directory: /work/here")
  })

  it("lets a user-configured systemPrompt win over the default base prompt", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ systemPrompt: "be terse" }),
    })
    const prompt = (ctx.session as { systemPrompt?: string }).systemPrompt ?? ""
    expect(prompt).toBe("be terse")
    expect(prompt).not.toContain("Working directory")
  })

  it("appends the output-style instruction to the system prompt", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ systemPrompt: "Base prompt.", outputStyle: "concise" }),
    })
    const prompt = (ctx.session as { systemPrompt?: string }).systemPrompt ?? ""
    expect(prompt.startsWith("Base prompt.")).toBe(true)
    expect(prompt).toContain("Concise")
    expect(ctx.appSettings?.defaultSystemPrompt).toContain("Concise")
  })

  it("forwards thinkingLevel as session.effort for a reasoning-capable model", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "anthropic", model: "claude-opus-4-8", thinkingLevel: "high" }),
    })
    expect((ctx.session as { effort?: string }).effort).toBe("high")
  })

  it("omits session.effort when the model does not support effort", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" }),
    })
    expect((ctx.session as { effort?: string }).effort).toBeUndefined()
  })

  it("omits session.effort when the thinking level is off / unset", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "anthropic", model: "claude-opus-4-8", thinkingLevel: "off" }),
    })
    expect((ctx.session as { effort?: string }).effort).toBeUndefined()
  })

  it("injects the CLI seams: agentMode null, empty preloadedMcpServers", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg() })
    expect(ctx.agentMode).toBeNull()
    expect(ctx.preloadedMcpServers).toEqual([])
  })

  it("omits the interactive flag by default (one-shot / subagent)", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg() })
    expect((ctx as { interactive?: boolean }).interactive).toBeUndefined()
  })

  it("threads interactive:true so the live TUI turn keeps partials (idle-watchdog feed)", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg(), interactive: true })
    expect((ctx as { interactive?: boolean }).interactive).toBe(true)
  })

  it("threads provided MCP servers + ephemeral skill ids into the seams", () => {
    const mcpServers = [
      { id: "mcp_fs", name: "fs", transport: "stdio" as const, config: {}, enabled: true },
    ]
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg(),
      mcpServers: mcpServers as never,
      ephemeralSkillIds: ["skill-a"],
    })
    expect(ctx.preloadedMcpServers).toBe(mcpServers)
    expect((ctx as { ephemeralSkillIds?: string[] }).ephemeralSkillIds).toEqual(["skill-a"])
  })

  it("defaults skillRenderMode to 'name' (progressive disclosure)", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg() })
    expect((ctx as { skillRenderMode?: string }).skillRenderMode).toBe("name")
  })

  it("maps config.skillLoadMode 'full' to skillRenderMode 'full'", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ skillLoadMode: "full" }),
    })
    expect((ctx as { skillRenderMode?: string }).skillRenderMode).toBe("full")
  })

  it("defaults the model to the active provider's catalog when none is set", () => {
    // No model configured + provider deepseek → a deepseek model, never a stale
    // Anthropic id (which would make the ai-sdk turn end with no assistant text).
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg({ provider: "deepseek" }) })
    expect(ctx.session?.model).toBeTruthy()
    expect(ctx.session?.model).toMatch(/deepseek/i)
    expect(ctx.appSettings?.defaultModel).toBe(ctx.session?.model)
  })

  it("forwards a subscription token as the bearer apiKey for OpenAI-protocol providers", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "opencode-go",
        providers: { "opencode-go": { authToken: "sub-tok" } },
      }),
    })
    const settings = ctx.appSettings?.providerSettings as
      | Record<string, { apiKey?: string }>
      | undefined
    expect(settings?.["opencode-go"]?.apiKey).toBe("sub-tok")
  })

  it("never folds an Anthropic subscription token into providerSettings (it goes via env)", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "anthropic", providers: { anthropic: { authToken: "oauth" } } }),
    })
    const settings = ctx.appSettings?.providerSettings as
      | Record<string, { apiKey?: string }>
      | undefined
    expect(settings?.anthropic?.apiKey).toBeUndefined()
    expect(ctx.preloadedEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" })
  })

  it("forwards builtinTools toggles into appSettings", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ builtinTools: { ...DEFAULT_BUILTIN_TOOLS, process: true } }),
    })
    expect(ctx.appSettings?.builtinTools?.process).toBe(true)
  })

  it("maps the skillTool / slashCommandTool config into selfInvokeTools (default off)", () => {
    const off = toBuildContext({ sessionId: "s1", now: NOW, config: cfg({}) })
    expect(off.appSettings?.selfInvokeTools).toEqual({ skill: false, slashCommand: false })
    const on = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ skillTool: true, slashCommandTool: true }),
    })
    expect(on.appSettings?.selfInvokeTools).toEqual({ skill: true, slashCommand: true })
  })

  it("forces cache optimization on so the prompt prefix stays cache-stable", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg({}) })
    expect(ctx.appSettings?.cacheOptimizationEnabled).toBe(true)
  })

  it("defaults session.kind to direct", () => {
    const ctx = toBuildContext({ sessionId: "s1", now: NOW, config: cfg() })
    expect(ctx.session?.kind).toBe("direct")
  })

  it("forwards sessionKind so the workflow-editor (copilot) path activates", () => {
    const ctx = toBuildContext({
      sessionId: "workflow:w1",
      now: NOW,
      config: cfg(),
      sessionKind: "workflow-editor",
    })
    expect(ctx.session?.kind).toBe("workflow-editor")
    expect(ctx.session?.id).toBe("workflow:w1")
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

  it("backfills the catalog gateway base URL for a built-in openai-compat provider configured with only a key", () => {
    // opencode-go rides the openai protocol at its own gateway. Without a base
    // URL the openai client hits api.openai.com and rejects the key. The CLI
    // must backfill the catalog default since (unlike desktop) it has no
    // add-provider step and no vault fallback outside Tauri.
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "opencode-go",
        providers: { "opencode-go": { apiKey: "sk-go" } },
      }),
    })
    expect(ctx.appSettings?.providerSettings?.["opencode-go"]).toEqual({
      enabled: true,
      apiKey: "sk-go",
      baseURL: "https://opencode.ai/zen/go/v1",
    })
  })

  it("backfills the deepseek gateway base URL too", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "deepseek", providers: { deepseek: { apiKey: "sk-d" } } }),
    })
    expect(ctx.appSettings?.providerSettings?.deepseek?.baseURL).toBe("https://api.deepseek.com/v1")
  })

  it("lets an explicit config base URL win over the catalog default", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "deepseek",
        providers: { deepseek: { apiKey: "sk-d", baseURL: "https://proxy/v1" } },
      }),
    })
    expect(ctx.appSettings?.providerSettings?.deepseek?.baseURL).toBe("https://proxy/v1")
  })

  it("does not inject a base URL into providerSettings for native Anthropic", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({ provider: "anthropic", providers: { anthropic: { apiKey: "sk-ant" } } }),
    })
    expect(ctx.appSettings?.providerSettings?.anthropic?.baseURL).toBeUndefined()
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

  it("forwards a subscription token as CLAUDE_CODE_OAUTH_TOKEN", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "anthropic",
        providers: { anthropic: { authToken: "oauth-tok" } },
      }),
    })
    expect(ctx.preloadedEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" })
  })

  it("carries both subscription token and api key when both are present", () => {
    const ctx = toBuildContext({
      sessionId: "s1",
      now: NOW,
      config: cfg({
        provider: "anthropic",
        providers: { anthropic: { authToken: "oauth-tok", apiKey: "sk-ant" } },
      }),
    })
    expect(ctx.preloadedEnv).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok",
      ANTHROPIC_API_KEY: "sk-ant",
    })
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
