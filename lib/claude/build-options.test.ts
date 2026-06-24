// Mock every database / store / agent-mode dependency so build-options can be
// exercised as a pure function. We never want to touch Dexie or Zustand here.

jest.mock("@/lib/db/characters", () => ({
  // ADR-0030: build-options switched to resolveCharacterById so plugin-
  // overlay characters resolve through the same path as Dexie rows.
  resolveCharacterById: jest.fn(),
  listCharactersByIds: jest.fn(),
  seedBuiltInCharacters: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: jest.fn(),
  recordSkillUsage: jest.fn(),
  renderSkillsSection: jest.fn(),
  renderSkillsCatalog: jest.fn(),
  seedBuiltInSkills: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  listEnabledMcpServers: jest.fn(),
  buildMcpServerMap: jest.fn(),
}))

jest.mock("@/lib/db/teams", () => ({
  getTeam: jest.fn(),
  seedBuiltInTeams: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: { getState: jest.fn() },
}))

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: { getState: jest.fn() },
}))

jest.mock("@/lib/agent", () => ({
  buildAgentModeSessionUpdate: jest.fn(),
}))

jest.mock("@/lib/plugin/bridge/sidecar-tools-bridge", () => ({
  buildPluginToolsManifest: jest.fn(() => []),
}))

jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: jest.fn(),
}))

// ADR-0028 — env-resolver bridges the renderer to the Rust per-account env
// builder. Mock both helpers so resolveSendOptions exercises the integration
// path without a real Tauri transport.
jest.mock("@/lib/claude/env-resolver", () => ({
  resolveAccountId: jest.fn(),
  resolveAccountEnv: jest.fn(),
  resolveProxyEnv: jest.fn(),
}))

// Twin runtime is dynamically imported by resolveSendOptions; the mock only
// kicks in when a test supplies twinId + twinDeps + twinUserMessage.
const mApplyTwinContext = jest.fn()
const mResolveOpencodeVaultCredential = jest.fn()
jest.mock("@/lib/subscription/opencode/chat-bridge", () => ({
  resolveOpencodeVaultCredential: (...a: unknown[]) => mResolveOpencodeVaultCredential(...a),
}))
const mResolveCodexVaultCredential = jest.fn()
jest.mock("@/lib/subscription/codex/chat-bridge", () => ({
  resolveCodexVaultCredential: (...a: unknown[]) => mResolveCodexVaultCredential(...a),
}))

jest.mock("@/lib/twin/runtime", () => ({
  applyTwinContext: (...args: unknown[]) => mApplyTwinContext(...args),
}))

// skills-bridge is dynamically imported by resolveSendOptions when a character
// has pluginSkillIds. Mock it so we can drive the anthropic-managed (container)
// skill path deterministically.
const mResolveSkillsForCharacter = jest.fn()
const mExtractContainerSkillIds = jest.fn()
const mRenderResolvedSkillsSection = jest.fn()
jest.mock("@/lib/claude/skills-bridge", () => ({
  resolveSkillsForCharacter: (...a: unknown[]) => mResolveSkillsForCharacter(...a),
  extractContainerSkillIds: (...a: unknown[]) => mExtractContainerSkillIds(...a),
  renderResolvedSkillsSection: (...a: unknown[]) => mRenderResolvedSkillsSection(...a),
}))

import { buildAgentModeSessionUpdate } from "@/lib/agent"
import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "@/lib/claude/env-resolver"
import {
  __resetSandboxConfineStateForTesting,
  getActiveSandboxConfine,
} from "@/lib/claude/sandbox-confine-state"
import { listCharactersByIds, resolveCharacterById } from "@/lib/db/characters"
import { buildMcpServerMap, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import {
  listEnabledSkillsByIds,
  recordSkillUsage,
  renderSkillsCatalog,
  renderSkillsSection,
} from "@/lib/db/skills"
import { getTeam } from "@/lib/db/teams"
import { buildPluginToolsManifest } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import { loggers } from "@/lib/logging"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useAgentRuntimeStore } from "@/stores/agent"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import {
  __getActiveSpanForTesting,
  __resetAgentTraceEmitterForTesting,
} from "@cognia/agent-trace/emitter"
import { listTeamMembers, resolveMemberConfig, resolveSendOptions } from "./build-options"
import type { AppSettings, Character, ChatSession, Skill, Team, TeamMember } from "./types"
import type { Project } from "@/types"

const mGetCharacter = resolveCharacterById as jest.Mock
const mListCharsByIds = listCharactersByIds as jest.Mock
const mListSkills = listEnabledSkillsByIds as jest.Mock
const mRecordUsage = recordSkillUsage as jest.Mock
const mRender = renderSkillsSection as jest.Mock
const mRenderCatalog = renderSkillsCatalog as jest.Mock
const mListMcp = listEnabledMcpServers as jest.Mock
const mBuildMap = buildMcpServerMap as jest.Mock
const mGetTeam = getTeam as jest.Mock
const mRuntimeGet = (useAgentRuntimeStore as unknown as { getState: jest.Mock }).getState
const mCustomGet = (useCustomModeStore as unknown as { getState: jest.Mock }).getState
const mBuildModeUpdate = buildAgentModeSessionUpdate as jest.Mock
const mResolveAccountId = resolveAccountId as jest.Mock
const mResolveAccountEnv = resolveAccountEnv as jest.Mock
const mResolveProxyEnv = resolveProxyEnv as jest.Mock

function makeChar(p: Partial<Character> = {}): Character {
  return {
    id: p.id ?? "c1",
    name: p.name ?? "Char",
    avatarColor: "oklch(0.7 0 0)",
    systemPrompt: p.systemPrompt ?? "",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as Character
}

function makeSession(p: Partial<ChatSession>): ChatSession {
  return {
    id: p.id ?? "s1",
    title: "t",
    kind: p.kind ?? "direct",
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as ChatSession
}

function makeProject(roots: { id?: string; path: string; isPrimary?: boolean }[]): Project {
  return {
    id: "ws1",
    name: "WS",
    roots: roots.map((r, i) => ({ id: r.id ?? `root-${i}`, path: r.path, isPrimary: r.isPrimary })),
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  } as Project
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetSandboxConfineStateForTesting()
  // Sane defaults so the function doesn't error when a test forgets to set
  // an expectation.
  mListSkills.mockResolvedValue([])
  mRecordUsage.mockResolvedValue(undefined)
  mRender.mockReturnValue("")
  mListMcp.mockResolvedValue([])
  mBuildMap.mockReturnValue({})
  mGetTeam.mockResolvedValue(undefined)
  mRuntimeGet.mockReturnValue({ modeId: undefined })
  mCustomGet.mockReturnValue({ customModes: {} })
  mBuildModeUpdate.mockReturnValue(undefined)
  // ADR-0028 — default to the "no account override" path so existing tests
  // see today's behaviour. Per-test overrides activate the new flow.
  mResolveAccountId.mockReturnValue(null)
  mResolveAccountEnv.mockResolvedValue({})
  mResolveProxyEnv.mockResolvedValue({})
  mResolveSkillsForCharacter.mockResolvedValue([])
  mExtractContainerSkillIds.mockReturnValue([])
  mRenderResolvedSkillsSection.mockReturnValue("")
})

describe("resolveMemberConfig", () => {
  const team = { id: "t1", mcpServerIds: ["t-mcp-1"] } as Team
  const character = makeChar({
    id: "c1",
    systemPrompt: "char prompt",
    model: "char-model",
    allowedTools: ["A"],
    mcpServerIds: ["c-mcp-1"],
  })

  it("uses overrides where provided", () => {
    const member: TeamMember = {
      characterId: "c1",
      systemPromptOverride: "override prompt",
      modelOverride: "override-model",
      allowedToolsOverride: ["B"],
      mcpServerIdsOverride: ["m-mcp-1"],
    }
    expect(resolveMemberConfig(team, member, character)).toEqual({
      systemPrompt: "override prompt",
      model: "override-model",
      allowedTools: ["B"],
      mcpServerIds: ["m-mcp-1"],
    })
  })

  it("falls back to the character defaults when no override is set", () => {
    const member: TeamMember = { characterId: "c1" }
    expect(resolveMemberConfig(team, member, character)).toEqual({
      systemPrompt: "char prompt",
      model: "char-model",
      allowedTools: ["A"],
      mcpServerIds: ["c-mcp-1"],
    })
  })

  it("falls through to team mcp when neither override nor character has any", () => {
    const member: TeamMember = { characterId: "c1" }
    const charNoMcp = makeChar({ id: "c1" })
    expect(resolveMemberConfig(team, member, charNoMcp).mcpServerIds).toEqual(["t-mcp-1"])
  })
})

describe("resolveSendOptions — plugin tools manifest failure", () => {
  it("logs (does not silently swallow) a plugin-tools manifest build failure", async () => {
    const warnSpy = jest.spyOn(loggers.app, "warn").mockImplementation(() => {})
    ;(buildPluginToolsManifest as jest.Mock).mockImplementationOnce(() => {
      throw new Error("boom")
    })
    await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("plugin tools manifest"),
      expect.objectContaining({ error: expect.stringContaining("boom") })
    )
    warnSpy.mockRestore()
  })
})

describe("resolveSendOptions — semantic tool routing exempts flow-control tools", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setDeps: (deps: any) => void
  beforeAll(async () => {
    ;({ __setSemanticToolRouterDepsForTesting: setDeps } =
      await import("@cognia/provider-routing/semantic-tool-router"))
  })
  afterEach(() => setDeps(null))

  function manifestEntry(name: string) {
    return { name, description: `tool ${name}`, pluginId: `p-${name}` } as never
  }

  it("never prunes ask_user / dispatch_agent even when they score below threshold", async () => {
    // A manifest large enough to trip the activation threshold: the two
    // flow-control tools plus 30 topical plugin tools.
    const dummies = Array.from({ length: 30 }, (_, i) => manifestEntry(`tool_${i}`))
    ;(buildPluginToolsManifest as jest.Mock).mockReturnValueOnce([
      manifestEntry("ask_user"),
      manifestEntry("dispatch_agent"),
      ...dummies,
    ])
    // Deps that score everything at 0 → nothing clears the 0.5 threshold, so the
    // router prunes aggressively (keeping only its small safety floor).
    setDeps({
      listRoutes: async () => [],
      embed: async (texts: string[]) => texts.map(() => [1, 0]),
      cacheRouteEmbeddings: async () => {},
      cosine: () => 0,
    })

    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: {
        semanticToolRouting: {
          enabled: true,
          topK: 2,
          threshold: 0.5,
          activationToolCount: 5,
          pinnedTools: [],
        },
      } as unknown as AppSettings,
      routingContextHint: { promptText: "please refactor this function" },
    } as never)

    const names = (opts.pluginTools ?? []).map((t) => t.name)
    // The flow-control tools survive regardless of their score…
    expect(names).toContain("ask_user")
    expect(names).toContain("dispatch_agent")
    // …and pruning actually ran (most topical dummies were dropped).
    const dummyCount = names.filter((n) => n.startsWith("tool_")).length
    expect(dummyCount).toBeLessThan(dummies.length)
  })
})

describe("resolveSendOptions — Anthropic native fallbackModel activation", () => {
  const routingConfig = {
    strategy: "quality",
    allowPerRequestOverride: true,
    providerConstraints: [],
    requestTimeoutMs: 30000,
    maxFallbackAttempts: 3,
  }

  it("sets fallbackModel to the next sibling Anthropic entry in the alias chain", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "anthropic", model: "powerful" }),
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: {},
        routingConfig,
        modelMappings: [
          {
            id: "m-powerful",
            alias: "powerful",
            providers: [
              { providerId: "anthropic", modelId: "claude-opus-4-8" },
              { providerId: "anthropic", modelId: "claude-opus-4-7" },
            ],
            distribution: "priority",
            enabled: true,
            isDefault: true,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      } as unknown as AppSettings,
    })
    expect(opts.provider).toBe("anthropic")
    expect(opts.model).toBe("claude-opus-4-8")
    expect(opts.fallbackModel).toBe("claude-opus-4-7")
  })

  it("does NOT set fallbackModel when the resolved provider is not Anthropic", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c2", providerId: "openai", model: "fast" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-test" } },
        routingConfig,
        modelMappings: [
          {
            id: "m-fast",
            alias: "fast",
            providers: [
              { providerId: "openai", modelId: "gpt-4o-mini" },
              { providerId: "openai", modelId: "gpt-4o" },
            ],
            distribution: "priority",
            enabled: true,
            isDefault: true,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      } as unknown as AppSettings,
    })
    expect(opts.provider).toBe("openai")
    expect(opts.fallbackModel).toBeUndefined()
  })
})

describe("resolveSendOptions — non-Anthropic provider credentials (ADR-0043)", () => {
  it("forwards the resolved protocol + modelParams for a configured built-in provider", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {
          openai: { apiKey: "sk-test", inferenceDefaults: { temperature: 0.5, maxTokens: 1024 } },
        },
      } as unknown as AppSettings,
    })
    expect(opts.provider).toBe("openai")
    // Unconditional protocol forwarding (previously custom-only → undefined).
    expect(opts.providerCredentials?.protocol).toBe("openai")
    // Built-in protocols never carry a declarative adapter spec.
    expect(opts.protocolAdapterSpec).toBeUndefined()
    // Configured inference defaults reach the turn (v6 `maxTokens → maxOutputTokens`).
    expect(opts.modelParams).toEqual(
      expect.objectContaining({ temperature: 0.5, maxOutputTokens: 1024 })
    )
  })

  it("rides the declarative spec along for a plugin-contributed protocol (M2)", async () => {
    const { registerProtocolAdapter, __resetProtocolAdaptersForTesting } =
      await import("@cognia/provider-core/providers/protocol-adapter-registry")
    const spec = {
      kind: "openai-compatible-variant" as const,
      urlTemplate: "{baseURL}/v1/chat/completions",
      responsePaths: { textDelta: "choices[0].delta.content" },
    }
    registerProtocolAdapter(
      { id: "acme-plugin:wire", label: "Acme Wire", spec },
      { pluginId: "acme-plugin" }
    )
    try {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", providerId: "acme", model: "acme-chat" }),
        appSettings: {
          defaultProvider: "acme",
          providerSettings: {},
          customProviders: [
            {
              id: "acme",
              isCustom: true,
              apiProtocol: "acme-plugin:wire",
              baseURL: "https://llm.acme.dev",
              apiKey: "sk-acme",
            },
          ],
        } as unknown as AppSettings,
      })
      expect(opts.provider).toBe("acme")
      // The namespaced plugin protocol id flows through the resolver…
      expect(opts.providerCredentials?.protocol).toBe("acme-plugin:wire")
      // …and the declarative spec rides along for the sidecar.
      expect(opts.protocolAdapterSpec).toEqual(spec)
    } finally {
      __resetProtocolAdaptersForTesting()
    }
  })
})

describe("resolveSendOptions — opencode vault auto-fallback", () => {
  it("draws credentials from the subscription vault when the provider is unconfigured", async () => {
    mResolveOpencodeVaultCredential.mockResolvedValue({
      apiKey: "sk-go-vault",
      baseURL: "https://opencode.ai/zen/go/v1",
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "opencode-go" }),
      appSettings: {
        defaultProvider: "opencode-go",
        providerSettings: {},
      } as unknown as AppSettings,
    })
    expect(mResolveOpencodeVaultCredential).toHaveBeenCalledWith("opencode-go")
    expect(opts.providerCredentials).toEqual({
      apiKey: "sk-go-vault",
      baseURL: "https://opencode.ai/zen/go/v1",
      protocol: "openai",
    })
    // Model backfilled from the built-in catalog default.
    expect(opts.model).toBe("kimi-k2.6")
  })

  it("does NOT fall back when the provider is explicitly disabled", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "opencode" }),
      appSettings: {
        defaultProvider: "opencode",
        providerSettings: { opencode: { enabled: false } },
      } as unknown as AppSettings,
    })
    expect(mResolveOpencodeVaultCredential).not.toHaveBeenCalled()
    expect(opts.providerCredentials).toBeUndefined()
  })

  it("backfills only the key when the provider resolved with a base URL but no key", async () => {
    mResolveOpencodeVaultCredential.mockResolvedValue({
      apiKey: "sk-zen-vault",
      baseURL: "https://opencode.ai/zen/v1",
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "opencode" }),
      appSettings: {
        defaultProvider: "opencode",
        providerSettings: { opencode: { baseURL: "https://my-relay.example/v1" } },
      } as unknown as AppSettings,
    })
    expect(opts.providerCredentials).toEqual(
      expect.objectContaining({
        apiKey: "sk-zen-vault",
        baseURL: "https://my-relay.example/v1",
        protocol: "openai",
      })
    )
  })

  it("falls through with no credentials when the vault has no matching account", async () => {
    mResolveOpencodeVaultCredential.mockResolvedValue(null)
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "opencode-go" }),
      appSettings: {
        defaultProvider: "opencode-go",
        providerSettings: {},
      } as unknown as AppSettings,
    })
    expect(opts.providerCredentials).toBeUndefined()
  })

  it("never consults the vault for non-opencode providers", async () => {
    await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {},
      } as unknown as AppSettings,
    })
    expect(mResolveOpencodeVaultCredential).not.toHaveBeenCalled()
  })
})

describe("resolveSendOptions — codex vault auto-fallback", () => {
  it("draws the ChatGPT-login credential (base URL + headers) from the vault", async () => {
    mResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "codex" }),
      appSettings: {
        defaultProvider: "codex",
        providerSettings: {},
      } as unknown as AppSettings,
    })
    expect(mResolveCodexVaultCredential).toHaveBeenCalledWith("codex")
    expect(opts.providerCredentials).toEqual({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      protocol: "openai",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
    // Model backfilled from the built-in catalog default.
    expect(opts.model).toBe("gpt-5.2-codex")
  })

  it("api_key mode carries no special headers", async () => {
    mResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "sk-openai",
      baseURL: "https://api.openai.com/v1",
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "codex" }),
      appSettings: {
        defaultProvider: "codex",
        providerSettings: {},
      } as unknown as AppSettings,
    })
    expect(opts.providerCredentials).toEqual({
      apiKey: "sk-openai",
      baseURL: "https://api.openai.com/v1",
      protocol: "openai",
    })
  })

  it("does NOT fall back when codex is explicitly disabled", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "codex" }),
      appSettings: {
        defaultProvider: "codex",
        providerSettings: { codex: { enabled: false } },
      } as unknown as AppSettings,
    })
    expect(mResolveCodexVaultCredential).not.toHaveBeenCalled()
    expect(opts.providerCredentials).toBeUndefined()
  })
})

describe("resolveSendOptions — agent-mode prompt template variables", () => {
  it("substitutes {{date}} / {{tools_list}} in the active mode's system prompt", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", systemPrompt: "base" }),
      agentMode: {
        id: "m1",
        type: "custom",
        name: "Tester",
        description: "",
        icon: "Bot",
        systemPrompt: "Mode prompt. Today is {{date}}. Tools: {{tools_list}}.",
        tools: ["calculator"],
      } as AgentModeConfig,
    })
    expect(opts.systemPrompt).toBeDefined()
    expect(opts.systemPrompt).not.toContain("{{date}}")
    expect(opts.systemPrompt).not.toContain("{{tools_list}}")
    expect(opts.systemPrompt).toContain("calculator")
  })
})

describe("resolveSendOptions — direct-chat subagents (opts.agents)", () => {
  it("exposes the user's non-built-in subagent templates to direct chat", async () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "bo-direct-1",
      name: "BO Helper",
      description: "helps",
      category: "general",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "You help.", tools: ["t"] },
      isBuiltIn: false,
    })
    try {
      const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
      expect(opts.agents?.["template:bo-helper"]).toMatchObject({
        description: "helps",
        prompt: "You help.",
      })
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("bo-direct-1")
    }
  })

  it("suppresses SDK-native opts.agents for a nested dispatch run", async () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "bo-nest-1",
      name: "Nest Helper",
      description: "helps",
      category: "general",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "You help." },
      isBuiltIn: false,
    })
    try {
      // Normal direct chat → the template is exposed via the SDK Task surface.
      const direct = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
      expect(direct.agents?.["template:nest-helper"]).toBeDefined()
      // Nested run (dispatchContext present) → SDK-native agents are suppressed
      // so the child only holds the controlled dispatch_agent tool.
      const nested = await resolveSendOptions({
        character: makeChar({ id: "c1" }),
        dispatchContext: { depth: 1, maxDepth: 2, parentChain: [] },
      })
      expect(nested.agents?.["template:nest-helper"]).toBeUndefined()
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("bo-nest-1")
    }
  })

  it("offers the dispatch_agent gate when nesting is enabled and a subagent exists", async () => {
    ;(buildPluginToolsManifest as jest.Mock).mockClear()
    useSubagentRuntimeStore.getState().addTemplate({
      id: "bo-nest-2",
      name: "Gate Helper",
      description: "helps",
      category: "general",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "You help." },
      isBuiltIn: false,
    })
    try {
      await resolveSendOptions({
        character: makeChar({ id: "c1" }),
        appSettings: { subagentNesting: { enabled: true, maxDepth: 2 } } as never,
      })
      const lastCall = (buildPluginToolsManifest as jest.Mock).mock.calls.at(-1)?.[0]
      expect(lastCall?.dispatchAgent).toMatchObject({ enabled: true, depth: 0, maxDepth: 2 })
      expect(
        lastCall?.dispatchAgent.available.some(
          (a: { id: string }) => a.id === "template:gate-helper"
        )
      ).toBe(true)
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("bo-nest-2")
    }
  })
})

describe("resolveSendOptions — character + skills", () => {
  it("loads the character from the session id when not provided directly", async () => {
    mGetCharacter.mockResolvedValueOnce(
      makeChar({ id: "c1", model: "from-char", systemPrompt: "from-char-sys" })
    )
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })
    expect(mGetCharacter).toHaveBeenCalledWith("c1")
    expect(opts.model).toBe("from-char")
    expect(opts.systemPrompt).toBe("from-char-sys")
  })

  it("treats undefined character as null when resolveCharacterById resolves undefined", async () => {
    mGetCharacter.mockResolvedValueOnce(undefined)
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c-missing" }),
    })
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("loads skills attached to the character and respects session-disable list", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1", "sk2"] })
    const skills: Skill[] = [
      {
        id: "sk1",
        name: "Skill 1",
        description: "",
        content: "body 1",
        allowedTools: ["X"],
      } as unknown as Skill,
    ]
    mListSkills.mockResolvedValueOnce(skills)
    mRender.mockReturnValueOnce("## Skill 1\n\nbody 1")

    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1", disabledSkillIds: ["sk2"] }),
    })

    // Only sk1 was passed to the loader (sk2 was disabled on the session).
    expect(mListSkills).toHaveBeenCalledWith(["sk1"])
    expect(mRecordUsage).toHaveBeenCalledWith(["sk1"])
    expect(opts.systemPrompt).toContain("Skill 1")
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["X"]))
  })

  it("skillRenderMode 'name' renders the catalog, not the full bodies", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "Skill 1", content: "FULL BODY", allowedTools: ["X"] } as unknown as Skill,
    ])
    mRenderCatalog.mockReturnValueOnce("## Available skills\n\n- `sk1` — Skill 1")

    const opts = await resolveSendOptions({ character: ch, skillRenderMode: "name" })

    // The catalog renderer was used; the full-body renderer was NOT.
    expect(mRenderCatalog).toHaveBeenCalled()
    expect(mRender).not.toHaveBeenCalled()
    expect(opts.systemPrompt).toContain("Available skills")
    expect(opts.systemPrompt).not.toContain("FULL BODY")
    // allowedTools still unions (a skill's declared tools must stay granted).
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["X"]))
  })

  it("recordSkillUsage failures are swallowed and don't propagate", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "Sk", content: "body", allowedTools: [] } as unknown as Skill,
    ])
    mRecordUsage.mockRejectedValueOnce(new Error("dexie down"))
    mRender.mockReturnValueOnce("body")

    await expect(resolveSendOptions({ character: ch })).resolves.toBeDefined()
  })

  it("skips skills altogether when the character has no skillIds", async () => {
    const ch = makeChar({ id: "c1" })
    await resolveSendOptions({ character: ch })
    expect(mListSkills).not.toHaveBeenCalled()
    expect(mRecordUsage).not.toHaveBeenCalled()
  })

  it("unions ephemeralSkillIds with character.skillIds and de-dupes", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "S1", content: "body1" } as unknown as Skill,
      { id: "sk2", name: "S2", content: "body2" } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("rendered")
    await resolveSendOptions({ character: ch, ephemeralSkillIds: ["sk1", "sk2"] })
    // Character + ephemeral merged, de-duped — sk1 appears once.
    expect(mListSkills).toHaveBeenCalledWith(["sk1", "sk2"])
  })

  it("respects session-disable list against ephemeral skills too", async () => {
    const ch = makeChar({ id: "c1" })
    mListSkills.mockResolvedValueOnce([
      { id: "sk2", name: "S2", content: "body" } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("rendered")
    await resolveSendOptions({
      character: ch,
      ephemeralSkillIds: ["sk1", "sk2"],
      session: makeSession({ id: "s1", disabledSkillIds: ["sk1"] }),
    })
    expect(mListSkills).toHaveBeenCalledWith(["sk2"])
  })

  it("calls recordSkillUsage on the merged ephemeral + character set", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "A", content: "x" } as unknown as Skill,
      { id: "sk2", name: "B", content: "y" } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("rendered")
    await resolveSendOptions({ character: ch, ephemeralSkillIds: ["sk2"] })
    expect(mRecordUsage).toHaveBeenCalledWith(["sk1", "sk2"])
  })

  it("union-merges allowed tools across character + skills + active mode", async () => {
    const ch = makeChar({ id: "c1", allowedTools: ["A", "B"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk", name: "Sk", content: "x", allowedTools: ["B", "C"] } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("section")
    const mode: AgentModeConfig = {
      id: "code-gen",
      type: "code-gen",
      name: "Code",
      description: "",
      icon: "Code2",
      tools: ["D"],
    }
    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "code-gen" })

    const opts = await resolveSendOptions({
      character: { ...ch, skillIds: ["sk"] } as Character,
      agentMode: mode,
    })
    expect(opts.allowedTools?.sort()).toEqual(["A", "B", "C", "D"])
  })

  it("emits disallowedTools straight from the character", async () => {
    const ch = makeChar({ id: "c1", disallowedTools: ["DangerousTool"] })
    const opts = await resolveSendOptions({ character: ch })
    expect(opts.disallowedTools).toEqual(["DangerousTool"])
  })

  it("serializes allowed/disallowed tools in sorted order regardless of source order", async () => {
    // Cache-prefix stability: the union Sets insert in source order, but the
    // final arrays must be sorted so identical tool sets serialize identically.
    const ch = makeChar({
      id: "c1",
      allowedTools: ["Zeta", "Alpha"],
      disallowedTools: ["zz_deny", "aa_deny"],
    })
    mListSkills.mockResolvedValueOnce([
      { id: "sk", name: "Sk", content: "x", allowedTools: ["Mid"] } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("section")
    const opts = await resolveSendOptions({ character: { ...ch, skillIds: ["sk"] } as Character })
    expect(opts.allowedTools).toEqual(["Alpha", "Mid", "Zeta"])
    expect(opts.disallowedTools).toEqual(["aa_deny", "zz_deny"])
  })
})

describe("resolveSendOptions — model precedence", () => {
  it("session.model wins over everything", async () => {
    const ch = makeChar({ id: "c1", model: "char" })
    const session = makeSession({ id: "s1", model: "session-model" })
    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "x", model: "mode-model" })
    const opts = await resolveSendOptions({
      character: ch,
      session,
      appSettings: { defaultModel: "default" } as AppSettings,
      memberOverride: { characterId: "c1", modelOverride: "member" },
      agentMode: {
        id: "x",
        type: "code-gen",
        name: "x",
        description: "",
        icon: "Bot",
      } as AgentModeConfig,
    })
    expect(opts.model).toBe("session-model")
  })

  it("falls through to memberOverride > mode > character > app default", async () => {
    const ch = makeChar({ id: "c1", model: "char" })
    const opts = await resolveSendOptions({
      character: ch,
      memberOverride: { characterId: "c1", modelOverride: "member" },
    })
    expect(opts.model).toBe("member")

    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "x", model: "mode" })
    const opts2 = await resolveSendOptions({
      character: ch,
      agentMode: {
        id: "x",
        type: "code-gen",
        name: "x",
        description: "",
        icon: "Bot",
      } as AgentModeConfig,
    })
    expect(opts2.model).toBe("mode")

    const opts3 = await resolveSendOptions({ character: ch })
    expect(opts3.model).toBe("char")

    const opts4 = await resolveSendOptions({
      appSettings: { defaultModel: "fallback" } as AppSettings,
    })
    expect(opts4.model).toBe("fallback")

    const opts5 = await resolveSendOptions({})
    expect(opts5.model).toBeUndefined()
  })

  // v41 / A6 — per-channel provider+model override is the topmost rung of
  // the precedence chain. Inbox conversation-header edits write to the
  // ConversationOverrideRow; the resolver reads that row once per send.
  it("IM ConversationOverrideRow.providerOverride/modelOverride sit above session, character, app", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({
      providerOverride: "codex",
      modelOverride: "gpt-5",
    })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        model: "session-model",
        providerOverride: "anthropic",
        platformBinding: {
          adapterId: "tg-1",
          conversationKey: "telegram:tg-1:9",
        },
      } as ChatSession),
      character: makeChar({ id: "c1", model: "char", providerId: "openai" }),
      appSettings: {
        defaultModel: "app-default",
        defaultProvider: "anthropic",
      } as AppSettings,
    })
    // IM override wins on both axes.
    expect(opts.model).toBe("gpt-5")
    expect(opts.provider).toBe("codex")
  })

  it("IM override falls through to session.providerOverride when only one axis is set", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({ modelOverride: "gpt-5" })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        providerOverride: "openai",
        platformBinding: {
          adapterId: "tg-1",
          conversationKey: "telegram:tg-1:9",
        },
      } as ChatSession),
      character: makeChar({ id: "c1", model: "char", providerId: "anthropic" }),
    })
    expect(opts.model).toBe("gpt-5")
    // No providerOverride on the row → falls through to session.providerOverride.
    expect(opts.provider).toBe("openai")
  })

  it("IM ConversationOverrideRow.reasoningOverride beats session.effort and app default", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({ reasoningOverride: "high" })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        model: "claude-opus-4-8",
        effort: "low",
        platformBinding: {
          adapterId: "tg-1",
          conversationKey: "telegram:tg-1:9",
        },
      } as ChatSession),
      character: makeChar({ id: "c1", providerId: "anthropic" }),
      appSettings: { defaultEffort: "medium" } as AppSettings,
    })
    expect(opts.effort).toBe("high")
  })

  it("non-IM sessions ignore the row read (precedence unchanged)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const overrides = require("@/lib/db/conversation-overrides")
    const mReadOverride = overrides.readForResolution as jest.Mock
    mReadOverride.mockResolvedValueOnce({
      providerOverride: "codex",
      modelOverride: "gpt-5",
    })
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", model: "session-model" }),
      character: makeChar({ id: "c1", providerId: "anthropic" }),
    })
    // Without platformBinding, the resolver MUST NOT issue the override
    // read — the mock is harmless because nothing consumes it.
    expect(opts.model).toBe("session-model")
    expect(opts.provider).toBe("anthropic")
  })
})

describe("resolveSendOptions — system prompt assembly", () => {
  it("joins base + mode + skill sections with the canonical separator", async () => {
    const ch = makeChar({ id: "c1", systemPrompt: "base", skillIds: ["s1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "s1", name: "Sk", content: "body", allowedTools: [] } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("## Sk\n\nbody")
    mBuildModeUpdate.mockReturnValueOnce({ agentModeId: "x" })
    const opts = await resolveSendOptions({
      character: ch,
      agentMode: {
        id: "x",
        type: "code-gen",
        name: "x",
        description: "",
        icon: "Bot",
        systemPrompt: "mode prompt",
      } as AgentModeConfig,
    })
    expect(opts.systemPrompt).toBe("base\n\n---\n\nmode prompt\n\n---\n\n## Sk\n\nbody")
  })

  it("memberOverride.systemPromptOverride replaces the character prompt", async () => {
    const ch = makeChar({ id: "c1", systemPrompt: "char" })
    const opts = await resolveSendOptions({
      character: ch,
      memberOverride: { characterId: "c1", systemPromptOverride: "member" },
    })
    expect(opts.systemPrompt).toBe("member")
  })

  it("session.systemPrompt overrides everything", async () => {
    const ch = makeChar({ id: "c1", systemPrompt: "char" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1", systemPrompt: "session" }),
      memberOverride: { characterId: "c1", systemPromptOverride: "member" },
    })
    expect(opts.systemPrompt).toBe("session")
  })

  it("falls back to appSettings.defaultSystemPrompt", async () => {
    const opts = await resolveSendOptions({
      appSettings: { defaultSystemPrompt: "default" } as AppSettings,
    })
    expect(opts.systemPrompt).toBe("default")
  })

  it("injects a branchSeed into appendSystemPrompt on the first send", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        branchSeed: { kind: "summary", content: "We discussed X." },
      }),
    })
    expect(opts.appendSystemPrompt).toContain("Summary of the conversation")
    expect(opts.appendSystemPrompt).toContain("We discussed X.")
  })

  it("does NOT inject a branchSeed once the session has an sdkSessionId", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        sdkSessionId: "sdk-1",
        branchSeed: { kind: "transcript", content: "User: hi" },
      }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("User: hi")
  })

  it("omits systemPrompt when nothing produces a non-empty string", async () => {
    const opts = await resolveSendOptions({})
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("appends the v2 persona section (tone + personality) after the base prompt", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "base",
      persona: { tone: "warm, encouraging", personality: "Former teacher, uses analogies." },
    })
    const opts = await resolveSendOptions({ character: ch })
    expect(opts.systemPrompt).toBe(
      "base\n\n---\n\n## Persona\n\nTone: warm, encouraging\n\nFormer teacher, uses analogies."
    )
  })

  it("omits the persona section when tone and personality are blank", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "base",
      persona: { openingMessage: "hi there", exemplarPrompts: ["do x"] },
    })
    const opts = await resolveSendOptions({ character: ch })
    expect(opts.systemPrompt).toBe("base")
  })

  it("suppresses the persona section when the twin runtime replaced the base prompt", async () => {
    mApplyTwinContext.mockResolvedValueOnce({
      applied: { systemPrompt: "TWIN PROMPT" },
      retrievedChunks: [],
      selectedStyleSamples: [],
      degraded: false,
    })
    const ch = makeChar({
      id: "c1",
      systemPrompt: "base",
      twinId: "twin1",
      persona: { tone: "warm", personality: "Former teacher." },
    })
    const opts = await resolveSendOptions({
      character: ch,
      twinDeps: {} as never,
      twinUserMessage: "hello",
    })
    expect(opts.systemPrompt).toBe("TWIN PROMPT")
    expect(opts.systemPrompt).not.toContain("## Persona")
  })
})

describe("resolveSendOptions — agent mode resolution", () => {
  it("ctx.agentMode === null opts the turn out of mode application", async () => {
    mBuildModeUpdate.mockReturnValue({ agentModeId: "should-not-run" })
    mRuntimeGet.mockReturnValue({ modeId: "general" })

    const opts = await resolveSendOptions({ agentMode: null })
    expect(mBuildModeUpdate).not.toHaveBeenCalled()
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("falls back to the runtime store when ctx.agentMode is undefined", async () => {
    mRuntimeGet.mockReturnValue({ modeId: "general" })
    await resolveSendOptions({})
    // BUILT_IN_AGENT_MODES contains general → buildAgentModeSessionUpdate runs.
    expect(mBuildModeUpdate).toHaveBeenCalled()
  })

  it("looks up custom modes by id when not built-in", async () => {
    const custom: AgentModeConfig = {
      id: "custom-1",
      type: "custom",
      name: "Custom",
      description: "",
      icon: "Bot",
      tools: ["tool-x"],
    }
    mRuntimeGet.mockReturnValue({ modeId: "custom-1" })
    mCustomGet.mockReturnValue({ customModes: { "custom-1": custom } })
    mBuildModeUpdate.mockReturnValue({ agentModeId: "custom-1" })

    const opts = await resolveSendOptions({})
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["tool-x"]))
  })

  it("returns no mode when modeId is unknown in both registries", async () => {
    mRuntimeGet.mockReturnValue({ modeId: "ghost" })
    mCustomGet.mockReturnValue({ customModes: {} })
    await resolveSendOptions({})
    expect(mBuildModeUpdate).not.toHaveBeenCalled()
  })

  it("returns no mode when modeId is null/undefined", async () => {
    mRuntimeGet.mockReturnValue({ modeId: undefined })
    await resolveSendOptions({})
    expect(mBuildModeUpdate).not.toHaveBeenCalled()
  })
})

describe("resolveSendOptions — referencedPaths", () => {
  it("adds folder paths and parent dirs of files; dedupes", async () => {
    const opts = await resolveSendOptions({
      referencedPaths: [
        { absolute: "/Users/me/folder", isDir: true },
        { absolute: "/Users/me/folder/file.ts", isDir: false },
        { absolute: "/Users/me/folder/file.ts", isDir: false }, // dup
        { absolute: "C:\\work\\sub\\thing.tsx", isDir: false },
        { absolute: "", isDir: true }, // dropped
      ],
    })
    expect(opts.additionalDirectories?.sort()).toEqual(["/Users/me/folder", "C:\\work\\sub"].sort())
  })

  it("omits the field entirely when no usable paths exist", async () => {
    const opts = await resolveSendOptions({
      referencedPaths: [{ absolute: "", isDir: false }],
    })
    expect(opts.additionalDirectories).toBeUndefined()
  })

  it("doesn't add to dirs when the file is at the filesystem root (no separator > index 0)", async () => {
    const opts = await resolveSendOptions({
      referencedPaths: [{ absolute: "/file.ts", isDir: false }],
    })
    expect(opts.additionalDirectories).toBeUndefined()
  })

  it("is a no-op when referencedPaths is empty", async () => {
    const opts = await resolveSendOptions({ referencedPaths: [] })
    expect(opts.additionalDirectories).toBeUndefined()
  })
})

describe("resolveSendOptions — cwd / permissionMode", () => {
  it("session.workingDir wins, then character, then appSettings", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/sess-dir" }),
      character: makeChar({ workingDir: "/char-dir" }),
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts.cwd).toBe("/sess-dir")

    const opts2 = await resolveSendOptions({
      character: makeChar({ workingDir: "/char-dir" }),
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts2.cwd).toBe("/char-dir")

    const opts3 = await resolveSendOptions({
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts3.cwd).toBe("/app-dir")
  })

  it("permissionMode: session > character > appSettings", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "plan" }),
      character: makeChar({ permissionMode: "default" }),
      appSettings: { permissionMode: "acceptEdits" } as AppSettings,
    })
    expect(opts.permissionMode).toBe("plan")

    const opts2 = await resolveSendOptions({
      character: makeChar({ permissionMode: "default" }),
    })
    expect(opts2.permissionMode).toBe("default")

    const opts3 = await resolveSendOptions({
      appSettings: { permissionMode: "acceptEdits" } as AppSettings,
    })
    expect(opts3.permissionMode).toBe("acceptEdits")

    const opts4 = await resolveSendOptions({})
    expect(opts4.permissionMode).toBeUndefined()
  })
})

describe("resolveSendOptions — activeProject (workspace)", () => {
  it("primary root sits between session override and character default", async () => {
    // session override wins over workspace
    const opts1 = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/sess-dir" }),
      activeProject: makeProject([{ path: "/ws-dir", isPrimary: true }]),
      character: makeChar({ workingDir: "/char-dir" }),
    })
    expect(opts1.cwd).toBe("/sess-dir")

    // workspace wins over character + app when no session override
    const opts2 = await resolveSendOptions({
      activeProject: makeProject([{ path: "/ws-dir", isPrimary: true }]),
      character: makeChar({ workingDir: "/char-dir" }),
      appSettings: { defaultWorkingDir: "/app-dir" } as AppSettings,
    })
    expect(opts2.cwd).toBe("/ws-dir")

    // falls through to character when the workspace has no roots
    const opts3 = await resolveSendOptions({
      activeProject: makeProject([]),
      character: makeChar({ workingDir: "/char-dir" }),
    })
    expect(opts3.cwd).toBe("/char-dir")
  })

  it("uses the flagged primary root (not just the first) as cwd", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/first" }, { path: "/primary", isPrimary: true }]),
    })
    expect(opts.cwd).toBe("/primary")
  })

  it("unions non-primary roots with referencedPaths and dedupes", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([
        { path: "/ws", isPrimary: true },
        { path: "/extra/a" },
        { path: "/extra/b" },
      ]),
      referencedPaths: [
        { absolute: "/extra/a", isDir: true }, // dup of an additional root
        { absolute: "/Users/me/folder/file.ts", isDir: false },
      ],
    })
    expect(opts.additionalDirectories?.sort()).toEqual(
      ["/extra/a", "/extra/b", "/Users/me/folder"].sort()
    )
  })

  it("adds non-primary roots even when there are no referencedPaths", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/ws", isPrimary: true }, { path: "/only/extra" }]),
    })
    expect(opts.additionalDirectories).toEqual(["/only/extra"])
  })
})

describe("resolveSendOptions — workspace Restricted Mode", () => {
  it("unions RESTRICTED_MODE_DENIED_TOOLS into disallowedTools when restricted", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: true,
    })
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]))
  })

  it("does not deny side-effecting tools when not restricted", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: false,
    })
    expect(opts.disallowedTools ?? []).not.toContain("Bash")
  })

  it("strips computer-use plugin tools from the allow list when restricted", async () => {
    const ch = makeChar({ allowedTools: ["mcp__cognia-plugin-tools__computer_use", "Read"] })
    const opts = await resolveSendOptions({
      character: ch,
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: true,
    })
    expect(opts.allowedTools ?? []).not.toContain("mcp__cognia-plugin-tools__computer_use")
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(["mcp__cognia-plugin-tools__computer_use"])
    )
  })
})

describe("resolveSendOptions — workspace Restricted Mode (coreFiles)", () => {
  it("denies the coreFiles mutators but not the read-only core tools", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: true,
    })
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(["bash", "edit", "write", "multi_edit", "mcp__cognia-tools__bash"])
    )
    for (const t of ["read", "grep", "glob", "ls"]) {
      expect(opts.disallowedTools).not.toContain(t)
    }
  })
})

describe("resolveSendOptions — permission ruleset merge", () => {
  it("wraps legacy commandRules under Bash (unchanged behavior)", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        agentPermissions: { commandRules: { "git *": "allow" } },
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toEqual({ Bash: { "git *": "allow" } })
  })

  it("merges toolRules with commandRules; toolRules wins on conflicts", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        agentPermissions: {
          commandRules: { "git *": "allow", "rm *": "deny" },
          toolRules: {
            Bash: { "git *": "ask" },
            grep: "allow",
            edit: { "**/*.env": "deny" },
          },
        },
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toEqual({
      Bash: { "git *": "ask", "rm *": "deny" },
      edit: { "**/*.env": "deny" },
      grep: "allow",
    })
  })

  it("serializes the merged ruleset byte-identically regardless of key order", async () => {
    const a = await resolveSendOptions({
      appSettings: {
        agentPermissions: { toolRules: { b: { z: "ask", a: "allow" }, a: "deny" } },
      } as unknown as AppSettings,
    })
    const b = await resolveSendOptions({
      appSettings: {
        agentPermissions: { toolRules: { a: "deny", b: { a: "allow", z: "ask" } } },
      } as unknown as AppSettings,
    })
    expect(JSON.stringify(a.permissionRuleset)).toBe(JSON.stringify(b.permissionRuleset))
  })

  it("omits permissionRuleset entirely when no rules are configured", async () => {
    const opts = await resolveSendOptions({
      appSettings: { agentPermissions: {} } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toBeUndefined()
  })
})

describe("resolveSendOptions — IM core-tool safeguard", () => {
  it("denies coreFiles mutators for IM-bound sessions by default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s-im",
        platformBinding: {
          adapterId: "tg-1",
          platform: "telegram",
          conversationKey: "c1",
          conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: 1 },
        },
      }),
    })
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(["bash", "edit", "write", "multi_edit"])
    )
    expect(opts.disallowedTools).not.toContain("read")
  })

  it("does not deny coreFiles mutators for plain desktop sessions", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s-plain" }),
    })
    expect(opts.disallowedTools ?? []).not.toContain("bash")
  })
})

describe("resolveSendOptions — surface-aware built-in skills", () => {
  const imSession = () =>
    makeSession({
      id: "s-im",
      platformBinding: {
        adapterId: "tg-1",
        platform: "telegram",
        conversationKey: "c1",
        conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: 1 },
      },
    })

  it("auto-injects the IM guidance skill for an IM-bound session (default on)", async () => {
    const opts = await resolveSendOptions({ session: imSession() })
    expect(opts.appendSystemPrompt).toContain("## IM auto-reply etiquette")
  })

  it("does not inject surface skills for a plain desktop session", async () => {
    const opts = await resolveSendOptions({ session: makeSession({ id: "s-plain" }) })
    expect(opts.appendSystemPrompt ?? "").not.toContain("IM auto-reply etiquette")
  })

  it("suppresses surface skills when surfaceSkillsEnabled is false", async () => {
    const opts = await resolveSendOptions({
      session: imSession(),
      appSettings: { surfaceSkillsEnabled: false } as AppSettings,
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("IM auto-reply etiquette")
  })

  it("injects the goal/loop skill when a loop is driving the session", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s-loop" }),
      activeLoop: true,
    })
    expect(opts.appendSystemPrompt).toContain("## Goal-driven execution")
  })
})

describe("resolveSendOptions — MCP subset", () => {
  it("memberOverride.mcpServerIdsOverride filters the enabled list", async () => {
    mListMcp.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
    ])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      memberOverride: { characterId: "c1", mcpServerIdsOverride: ["a"] },
    })
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
    expect(mBuildMap).toHaveBeenCalledWith([{ id: "a", name: "a" }])
  })

  it("character.mcpServerIds is honoured when no member override is given", async () => {
    mListMcp.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
    ])
    mBuildMap.mockReturnValueOnce({ b: { command: "b" } })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", mcpServerIds: ["b"] }),
    })
    expect(opts.mcpServers).toEqual({ b: { command: "b" } })
  })

  it("falls back to team.mcpServerIds for team sessions", async () => {
    mListMcp.mockResolvedValue([
      { id: "a", name: "a" },
      { id: "b", name: "b" },
    ])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    mGetTeam.mockResolvedValueOnce({ id: "t1", mcpServerIds: ["a"] } as Team)
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", kind: "team", teamId: "t1" }),
    })
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
  })

  it("falls back to all enabled servers when no narrowing applies", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    const opts = await resolveSendOptions({})
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
  })

  it("omits mcpServers when no servers match", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", mcpServerIds: ["does-not-exist"] }),
    })
    expect(opts.mcpServers).toBeUndefined()
  })

  it("non-fatal: a Dexie error during the MCP step doesn't block the send", async () => {
    mListMcp.mockRejectedValueOnce(new Error("DB offline"))
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const opts = await resolveSendOptions({})
    expect(opts.mcpServers).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("skips team lookup when session is direct (kind != team)", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    await resolveSendOptions({ session: makeSession({ id: "s1", kind: "direct" }) })
    expect(mGetTeam).not.toHaveBeenCalled()
  })

  it("ignores team without mcpServerIds (falls back to all enabled)", async () => {
    mListMcp.mockResolvedValue([{ id: "a", name: "a" }])
    mBuildMap.mockReturnValueOnce({ a: { command: "a" } })
    mGetTeam.mockResolvedValueOnce({ id: "t1" } as Team) // no mcpServerIds
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", kind: "team", teamId: "t1" }),
    })
    expect(opts.mcpServers).toEqual({ a: { command: "a" } })
  })
})

describe("resolveSendOptions — resume", () => {
  it("attaches resumeSessionId when sdkSessionId is set and not forked", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", sdkSessionId: "sdk-1" }),
    })
    expect(opts.resumeSessionId).toBe("sdk-1")
  })

  it("populates forkFromSessionId (not resumeSessionId) when the session is forked", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        sdkSessionId: "sdk-1",
        forkedFromSdkSessionId: "sdk-0",
      }),
    })
    // Forking takes precedence: the dispatcher uses forkFromSessionId both as
    // the resume target AND as the "isFork" flag, so we must NOT also set
    // resumeSessionId (mutually exclusive in the SDK).
    expect(opts.resumeSessionId).toBeUndefined()
    expect(opts.forkFromSessionId).toBe("sdk-0")
  })

  it("omits resumeSessionId when no sdkSessionId is set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.resumeSessionId).toBeUndefined()
    expect(opts.forkFromSessionId).toBeUndefined()
  })
})

describe("resolveSendOptions — bare mode", () => {
  it("translates bareMode to settingSources [] + strictMcpConfig true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", bareMode: true }),
    })
    expect(opts.settingSources).toEqual([])
    expect(opts.strictMcpConfig).toBe(true)
  })

  it("does nothing when bareMode is false / unset at every level", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton" } as AppSettings,
    })
    expect(opts.settingSources).toBeUndefined()
    expect(opts.strictMcpConfig).toBeUndefined()
  })

  it("session.bareMode wins over character + app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", bareMode: false }),
      character: makeChar({ bareMode: true }),
      appSettings: { id: "singleton", bareMode: true } as AppSettings,
    })
    expect(opts.settingSources).toBeUndefined()
  })

  it("character.bareMode beats app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ bareMode: true }),
      appSettings: { id: "singleton", bareMode: false } as AppSettings,
    })
    expect(opts.settingSources).toEqual([])
    expect(opts.strictMcpConfig).toBe(true)
  })

  it("appSettings.bareMode applies when nothing closer is set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton", bareMode: true } as AppSettings,
    })
    expect(opts.settingSources).toEqual([])
    expect(opts.strictMcpConfig).toBe(true)
  })
})

describe("resolveSendOptions — debug mode", () => {
  it("populates env.DEBUG and env.CLAUDE_CODE_DEBUG when debugMode is on", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", debugMode: true }),
    })
    expect(opts.env?.DEBUG).toBe("*")
    expect(opts.env?.CLAUDE_CODE_DEBUG).toBe("1")
  })

  it("leaves env unset when debugMode is off everywhere", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.env).toBeUndefined()
  })

  it("character.debugMode applies when no session override", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ debugMode: true }),
    })
    expect(opts.env?.DEBUG).toBe("*")
  })

  it("session.debugMode === false beats character + app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", debugMode: false }),
      character: makeChar({ debugMode: true }),
      appSettings: { id: "singleton", debugMode: true } as AppSettings,
    })
    expect(opts.env).toBeUndefined()
  })
})

describe("resolveSendOptions — plan mode prompt", () => {
  it("appends the plan-mode reminder when permissionMode is plan", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "plan" }),
    })
    expect(opts.permissionMode).toBe("plan")
    expect(opts.appendSystemPrompt).toContain("You are in plan mode")
    expect(opts.appendSystemPrompt).toContain("ExitPlanMode")
  })

  it("omits the plan-mode reminder outside plan mode", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "acceptEdits" }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("You are in plan mode")
  })
})

describe("resolveSendOptions — brief mode", () => {
  it("appends BRIEF_OUTPUT_SNIPPET to appendSystemPrompt when set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", briefMode: true }),
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
  })

  it("merges with an existing appendSystemPrompt (e.g., A2UI block) under a blank line", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", briefMode: true, a2uiEnabled: true } as ChatSession & {
        a2uiEnabled?: boolean
      }),
      character: makeChar({ a2uiEnabled: true }),
    })
    expect(opts.appendSystemPrompt).toMatch(/A2UI[\s\S]+\n\nRespond concisely/i)
  })

  it("omits the snippet when briefMode is off", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("Respond concisely")
  })

  it("character.briefMode applies in absence of session override", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ briefMode: true }),
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
  })

  it("appSettings.briefMode applies when nothing closer set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton", briefMode: true } as AppSettings,
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
  })
})

describe("resolveSendOptions — output style", () => {
  it("appends a preset style snippet to appendSystemPrompt", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", outputStyle: "bullets" } as ChatSession),
    })
    expect(opts.appendSystemPrompt).toContain("Bullet points")
  })

  it("uses the custom instruction for the custom style", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        outputStyle: "custom",
        customOutputStyle: "Answer in haiku.",
      } as ChatSession),
    })
    expect(opts.appendSystemPrompt).toContain("Answer in haiku.")
  })

  it("omits a snippet for the default style", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", outputStyle: "default" } as ChatSession),
    })
    expect(opts.appendSystemPrompt ?? "").not.toMatch(/Output style/)
  })

  it("composes with brief mode (both append)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", briefMode: true, outputStyle: "teacher" } as ChatSession),
    })
    expect(opts.appendSystemPrompt).toContain("Respond concisely")
    expect(opts.appendSystemPrompt).toContain("Explanatory")
  })

  it("character.outputStyle applies in absence of a session override", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ outputStyle: "detailed" } as Partial<Character>),
    })
    expect(opts.appendSystemPrompt).toContain("Detailed")
  })
})

describe("resolveSendOptions — extended thinking budget", () => {
  it("session > character > appSettings — session wins when all three set", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", maxThinkingTokens: 8000 }),
      character: makeChar({ maxThinkingTokens: 4000 }),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 2000 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBe(8000)
  })

  it("falls through to character when session is unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ maxThinkingTokens: 4000 }),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 2000 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBe(4000)
  })

  it("falls through to appSettings when session and character are unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 2000 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBe(2000)
  })

  it("omits the field entirely when budget is 0 (= use SDK default)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", maxThinkingTokens: 0 }),
      character: makeChar({ maxThinkingTokens: 0 }),
      appSettings: { id: "singleton", defaultMaxThinkingTokens: 0 } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBeUndefined()
  })

  it("omits the field when nothing is configured", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: { id: "singleton" } as AppSettings,
    })
    expect(opts.maxThinkingTokens).toBeUndefined()
  })
})

describe("resolveSendOptions — reasoning effort (thinking level)", () => {
  it("session effort wins over the app default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", effort: "max" }),
      appSettings: { id: "singleton", defaultEffort: "low" } as AppSettings,
    })
    expect(opts.effort).toBe("max")
  })

  it("falls through to the app default when the session is unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      appSettings: { id: "singleton", defaultEffort: "high" } as AppSettings,
    })
    expect(opts.effort).toBe("high")
  })

  it("omits the field when nothing is configured", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      appSettings: { id: "singleton" } as AppSettings,
    })
    expect(opts.effort).toBeUndefined()
  })

  it("drops effort when the resolved model does not support it (Haiku → no 400)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", effort: "high", model: "claude-haiku-4-5" }),
      appSettings: { id: "singleton", defaultProvider: "anthropic" } as AppSettings,
    })
    expect(opts.model).toBe("claude-haiku-4-5")
    expect(opts.effort).toBeUndefined()
  })

  it("keeps effort when the resolved model supports it (Opus 4.6)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", effort: "high", model: "claude-opus-4-6" }),
      appSettings: { id: "singleton", defaultProvider: "anthropic" } as AppSettings,
    })
    expect(opts.effort).toBe("high")
  })
})

describe("listTeamMembers", () => {
  it("delegates to listCharactersByIds", async () => {
    mListCharsByIds.mockResolvedValueOnce([makeChar({ id: "c1" })])
    const out = await listTeamMembers(["c1"])
    expect(mListCharsByIds).toHaveBeenCalledWith(["c1"])
    expect(out).toHaveLength(1)
  })
})

describe("resolveSendOptions — Computer Use plugin-tool gating", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sidecarBridge = require("@/lib/plugin/bridge/sidecar-tools-bridge")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const overrides = require("@/lib/db/conversation-overrides")
  const mBuildManifest = sidecarBridge.buildPluginToolsManifest as jest.Mock
  const mReadOverride = overrides.readForResolution as jest.Mock

  const cuTools = [
    {
      name: "computer_use",
      description: "drive desktop",
      jsonSchema: {},
      pluginId: "cognia-computer-use",
    },
    {
      name: "bash",
      description: "shell",
      jsonSchema: {},
      pluginId: "cognia-computer-use",
    },
    {
      name: "text_editor",
      description: "edit",
      jsonSchema: {},
      pluginId: "cognia-computer-use",
    },
  ]
  const otherTool = {
    name: "github_pr",
    description: "open a PR",
    jsonSchema: {},
    pluginId: "cognia-github-delivery",
  }

  beforeEach(() => {
    mBuildManifest.mockReset().mockReturnValue([...cuTools, otherTool])
    mReadOverride.mockReset()
  })

  // The first-class web tools (web_search / web_fetch) are appended to every
  // manifest by default and are orthogonal to Computer Use gating, so these
  // assertions exclude them to stay focused.
  const notWeb = (n: string) => n !== "web_search" && n !== "web_fetch"

  it("includes computer-use plugin tools when character.enableComputerUse=true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? [])
      .map((t) => t.name)
      .filter(notWeb)
      .sort()
    expect(names).toEqual(["bash", "computer_use", "github_pr", "text_editor"])
  })

  it("filters computer-use plugin tools when character.enableComputerUse !== true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: false }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toEqual(["github_pr"])
    expect(names).not.toContain("computer_use")
  })

  it("filters when character has no Computer Use flag at all", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toEqual(["github_pr"])
  })

  it("IM-session default-denies computer-use plugin tools even when character allows", async () => {
    mReadOverride.mockResolvedValueOnce(undefined)
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: {
          adapterId: "telegram",
          conversationKey: "tg:123",
        },
      } as ChatSession),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toEqual(["github_pr"])
  })

  it("IM-session opt-in (allowComputerUse=true) restores computer-use plugin tools", async () => {
    mReadOverride.mockResolvedValueOnce({ allowComputerUse: true })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: {
          adapterId: "telegram",
          conversationKey: "tg:123",
        },
      } as ChatSession),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? [])
      .map((t) => t.name)
      .filter(notWeb)
      .sort()
    expect(names).toEqual(["bash", "computer_use", "github_pr", "text_editor"])
  })

  it("disablePluginTools wipes plugin tools but the first-class web tools survive", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true, disablePluginTools: true }),
    })
    // web_search / web_fetch are first-class built-ins (ungated by the plugin
    // toggle); every other plugin tool is gone.
    expect((opts.pluginTools ?? []).map((t) => t.name)).toEqual(["web_search", "web_fetch"])
  })

  it("appends the first-class web tools by default (web capability on)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name)
    expect(names).toContain("web_search")
    expect(names).toContain("web_fetch")
  })
})

describe("resolveSendOptions — first-class web tools supersede the plugin", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sidecarBridge = require("@/lib/plugin/bridge/sidecar-tools-bridge")
  const mBuildManifest = sidecarBridge.buildPluginToolsManifest as jest.Mock

  beforeEach(() => {
    // The web-tools plugin still registers all four of its tools.
    mBuildManifest.mockReset().mockReturnValue([
      {
        name: "web_search",
        description: "plugin search",
        jsonSchema: {},
        pluginId: "cognia-web-tools",
      },
      {
        name: "web_fetch",
        description: "plugin fetch",
        jsonSchema: {},
        pluginId: "cognia-web-tools",
      },
      { name: "web_download", description: "dl", jsonSchema: {}, pluginId: "cognia-web-tools" },
      { name: "web_research", description: "rsrch", jsonSchema: {}, pluginId: "cognia-web-tools" },
    ])
  })

  afterAll(() => mBuildManifest.mockReset().mockReturnValue([]))

  it("drops the plugin's duplicate web_search/web_fetch and keeps exactly one of each", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
    })
    const tools = opts.pluginTools ?? []
    const names = tools.map((t) => t.name)
    expect(names.filter((n) => n === "web_search")).toHaveLength(1)
    expect(names.filter((n) => n === "web_fetch")).toHaveLength(1)
    // The single surviving web_search/web_fetch are the promoted built-ins.
    const search = tools.find((t) => t.name === "web_search")
    expect(search?.pluginId).toBe("cognia-web-builtin")
    // The plugin's exclusive tools are untouched.
    expect(names).toContain("web_download")
    expect(names).toContain("web_research")
  })
})

describe("resolveSendOptions — workflow-editor (Workflow Copilot mode)", () => {
  it("REPLACES the system prompt with the Workflow Copilot prompt", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "I am Marketing Assistant — perky and witty.",
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    // The character prompt is gone.
    expect(opts.systemPrompt).not.toContain("Marketing Assistant")
    // The Workflow Copilot identity is in.
    expect(opts.systemPrompt).toContain("Workflow Copilot")
    expect(opts.systemPrompt).toContain("wf_propose_batch")
  })

  it("overrides allowedTools with the strict whitelist (no Bash, no Edit, no Write)", async () => {
    const ch = makeChar({
      id: "c1",
      // Try to sneak Bash in via the character — Workflow Copilot must
      // ignore it.
      allowedTools: ["Bash", "Edit", "Write"],
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.allowedTools).toBeDefined()
    expect(opts.allowedTools).not.toContain("Bash")
    expect(opts.allowedTools).not.toContain("Edit")
    expect(opts.allowedTools).not.toContain("Write")
    // The wf_* family must be in.
    expect(opts.allowedTools).toContain("mcp__cognia-plugin-tools__wf_read_graph")
    expect(opts.allowedTools).toContain("mcp__cognia-plugin-tools__wf_propose_batch")
    expect(opts.allowedTools).toContain("mcp__cognia-plugin-tools__wf_apply_template")
  })

  it("sets a defense-in-depth disallowedTools list that includes Bash + Computer Use", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.disallowedTools).toBeDefined()
    expect(opts.disallowedTools).toContain("Bash")
    expect(opts.disallowedTools).toContain("Write")
    expect(opts.disallowedTools).toContain("Edit")
    // Computer Use names
    expect(opts.disallowedTools).toContain("computer")
    expect(opts.disallowedTools).toContain("str_replace_editor")
  })

  it("drops mcpServers (external MCP) — Workflow Copilot only uses the synthetic plugin-tools server", async () => {
    mListMcp.mockResolvedValueOnce([
      { id: "test-runner", name: "Test Runner" } as unknown as Awaited<
        ReturnType<typeof listEnabledMcpServers>
      >[number],
    ])
    mBuildMap.mockReturnValueOnce({ "test-runner": { command: "x", args: [] } })
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.mcpServers).toBeUndefined()
  })

  it("scopes Read to lib/workflow/copilot-templates via additionalDirectories", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.additionalDirectories).toEqual(["lib/workflow/copilot-templates"])
  })

  it("clears appendSystemPrompt — A2UI / skill / goal sections do not leak into this session", async () => {
    const ch = makeChar({
      id: "c1",
      // briefMode would normally add to appendSystemPrompt
      briefMode: true,
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    // appendSystemPrompt is either undefined (no editor open) or only the
    // workflow snapshot block — definitely NOT BRIEF_OUTPUT_SNIPPET text.
    if (opts.appendSystemPrompt) {
      // It can only contain the workflow snapshot block, never the brief snippet.
      expect(opts.appendSystemPrompt).not.toContain("Keep responses")
    }
  })

  it("attaches the four workflow subagents", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "workflow:wf_42", kind: "workflow-editor" }),
    })
    expect(opts.agents).toBeDefined()
    expect(opts.agents).toHaveProperty("workflow-designer")
    expect(opts.agents).toHaveProperty("workflow-debugger")
    expect(opts.agents).toHaveProperty("workflow-refactorer")
    expect(opts.agents).toHaveProperty("workflow-doc-writer")
  })

  it("STILL applies the resume/fork continuity logic below the override block", async () => {
    const ch = makeChar({ id: "c1" })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({
        id: "workflow:wf_42",
        kind: "workflow-editor",
        sdkSessionId: "sdk_42",
      } as Partial<ChatSession>),
    })
    // The post-branch code at lines 912+ sets opts.resumeSessionId when
    // the session has an sdkSessionId. Workflow-editor override must NOT
    // clobber this.
    expect(opts.resumeSessionId).toBe("sdk_42")
  })

  it("does NOT touch other session kinds", async () => {
    const ch = makeChar({
      id: "c1",
      systemPrompt: "I am Marketing Assistant.",
      allowedTools: ["Bash"],
    })
    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s_direct", kind: "direct" }),
    })
    // Normal session: Workflow Copilot prompt should NOT be installed.
    expect(opts.systemPrompt).toContain("Marketing Assistant")
    expect(opts.systemPrompt).not.toContain("Workflow Copilot")
    // Character's allowedTools survives.
    expect(opts.allowedTools).toContain("Bash")
  })
})

describe("resolveSendOptions — ADR-0028 sandbox builtin replacement", () => {
  it("disallows SDK Bash/Edit/Write + filters text_editor when session sandbox is enabled", async () => {
    mGetCharacter.mockResolvedValue(
      makeChar({
        id: "c1",
        enableComputerUse: true,
      })
    )
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        characterId: "c1",
        sandboxEnabled: true,
      }),
    })
    const disallowed = opts.disallowedTools ?? []
    expect(disallowed).toContain("Bash")
    expect(disallowed).toContain("Edit")
    expect(disallowed).toContain("Write")
    // Process-execution escape hatches are gated too (ADR-0028 Phase 4).
    expect(disallowed).toContain("start_process")
    expect(disallowed).toContain("shell_execute_advanced")
    expect(disallowed).toContain("mcp__cognia-tools__start_process")
    // text_editor must NOT survive on anthropicTools when sandbox is on.
    if (Array.isArray(opts.anthropicTools)) {
      expect(opts.anthropicTools.map((t) => t.name)).not.toContain("text_editor")
      expect(opts.anthropicTools.map((t) => t.name)).not.toContain("str_replace_based_edit_tool")
    }
    // System prompt hint mentions sandbox_bash / sandbox_edit.
    expect(opts.appendSystemPrompt ?? "").toContain("sandbox_bash")
  })

  it("character.sandboxEnabled wins when session-level is unset", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", sandboxEnabled: true }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })
    expect(opts.disallowedTools ?? []).toContain("Bash")
  })

  it("session.sandboxEnabled = false overrides character + app default", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", sandboxEnabled: true }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1", sandboxEnabled: false }),
      appSettings: {
        id: "singleton",
        alwaysAllowTools: [],
        builtinTools: {
          fileExtras: true,
          git: true,
          process: false,
          environment: true,
          shellAdvanced: false,
        },
        sandboxDefaultEnabled: true,
      } as AppSettings,
    })
    expect(opts.disallowedTools ?? []).not.toContain("Bash")
  })

  it("leaves disallowedTools alone when sandbox is unset on every layer", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1" }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })
    expect(opts.disallowedTools ?? []).not.toContain("Bash")
  })

  it("stamps the resolved writable and readable ceiling onto Computer Use confine", async () => {
    mGetCharacter.mockResolvedValue(
      makeChar({
        id: "c1",
        sandboxEnabled: true,
        sandboxPolicy: {
          writableRoots: ["/workspace"],
          readableRoots: ["/vendor/include"],
          network: "allowlist",
          networkAllowlist: ["api.github.com"],
        },
      })
    )

    await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })

    expect(getActiveSandboxConfine("s1")).toEqual({
      writable: ["/workspace"],
      readable: ["/vendor/include"],
      network: "allowlist",
      networkHosts: ["api.github.com"],
    })
  })
})

describe("resolveSendOptions — ADR-0028 per-`query()` env injection", () => {
  it("merges account env + proxy env into opts.env when accountId resolves", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", providerId: "anthropic" }))
    mResolveAccountId.mockReturnValue("acct-A")
    mResolveAccountEnv.mockResolvedValue({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
      CLAUDE_CONFIG_DIR: "/tmp/configs/acct-A",
      ANTHROPIC_BASE_URL: "https://example.com",
    })
    mResolveProxyEnv.mockResolvedValue({
      HTTPS_PROXY: "http://proxy:8080",
    })

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1", accountId: "acct-A" }),
    })

    expect(mResolveAccountId).toHaveBeenCalled()
    expect(mResolveAccountEnv).toHaveBeenCalledWith("anthropic", "acct-A")
    expect(mResolveProxyEnv).toHaveBeenCalledWith("s1")
    expect(opts.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
      CLAUDE_CONFIG_DIR: "/tmp/configs/acct-A",
      ANTHROPIC_BASE_URL: "https://example.com",
      HTTPS_PROXY: "http://proxy:8080",
    })
  })

  it("leaves opts.env unset when no accountId resolves and proxy is inactive", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1" }))
    mResolveAccountId.mockReturnValue(null)
    mResolveAccountEnv.mockResolvedValue({})
    mResolveProxyEnv.mockResolvedValue({})

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })

    // Either undefined or — if some other layer set DEBUG/CLAUDE_CODE_DEBUG —
    // the account/proxy keys at least must not appear.
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(opts.env?.HTTPS_PROXY).toBeUndefined()
  })

  it("debugMode flags layer on top of account env without colliding", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", providerId: "anthropic" }))
    mResolveAccountId.mockReturnValue("acct-A")
    mResolveAccountEnv.mockResolvedValue({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
    })
    mResolveProxyEnv.mockResolvedValue({})

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1", debugMode: true, accountId: "acct-A" }),
    })

    // Account-env keys survive; debugMode keys layer in on top.
    expect(opts.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "oat-A",
      DEBUG: "*",
      CLAUDE_CODE_DEBUG: "1",
    })
  })

  it("proxy fields apply even when no account override is set", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1" }))
    mResolveAccountId.mockReturnValue(null)
    mResolveAccountEnv.mockResolvedValue({}) // no accountId resolved
    mResolveProxyEnv.mockResolvedValue({
      HTTPS_PROXY: "http://proxy:8080",
      HTTP_PROXY: "http://proxy:8080",
    })

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })

    expect(opts.env).toMatchObject({
      HTTPS_PROXY: "http://proxy:8080",
      HTTP_PROXY: "http://proxy:8080",
    })
    expect(opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})

describe("resolveSendOptions — tool/MCP filter overlay", () => {
  beforeEach(() => {
    // Reflect the chosen servers so we can assert on the filtered subset.
    mBuildMap.mockImplementation((servers: Array<{ name: string }>) =>
      Object.fromEntries(servers.map((s) => [s.name, {}]))
    )
  })

  it("allow mode intersects the resolved allowedTools", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b", "c"],
        toolFilter: { mode: "allow", tools: ["b", "c"] },
      }),
    })
    expect(new Set(opts.allowedTools)).toEqual(new Set(["b", "c"]))
  })

  it("deny mode unions filtered tools into disallowedTools and leaves allow alone", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b"],
        disallowedTools: ["x"],
        toolFilter: { mode: "deny", tools: ["b"] },
      }),
    })
    expect(new Set(opts.disallowedTools)).toEqual(new Set(["x", "b"]))
    expect(new Set(opts.allowedTools)).toEqual(new Set(["a", "b"]))
  })

  it("session filter replaces the character filter", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b", "c"],
        toolFilter: { mode: "allow", tools: ["a"] },
      }),
      session: makeSession({ id: "s1", toolFilter: { mode: "allow", tools: ["c"] } }),
    })
    expect(new Set(opts.allowedTools)).toEqual(new Set(["c"]))
  })

  it("mode 'all' is a no-op", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        allowedTools: ["a", "b"],
        toolFilter: { mode: "all", tools: ["b"] },
      }),
    })
    expect(new Set(opts.allowedTools)).toEqual(new Set(["a", "b"]))
  })

  it("allow mode filters the MCP server subset to listed ids", async () => {
    mListMcp.mockResolvedValueOnce([
      { id: "m1", name: "one", transport: "stdio", enabled: true },
      { id: "m2", name: "two", transport: "http", enabled: true },
    ])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", toolFilter: { mode: "allow", mcpServerIds: ["m1"] } }),
    })
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["one"])
  })

  it("deny mode drops the listed MCP server ids", async () => {
    mListMcp.mockResolvedValueOnce([
      { id: "m1", name: "one", transport: "stdio", enabled: true },
      { id: "m2", name: "two", transport: "http", enabled: true },
    ])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", toolFilter: { mode: "deny", mcpServerIds: ["m1"] } }),
    })
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["two"])
  })
})

describe("resolveSendOptions — runtime tool-search policy", () => {
  it("emits toolSearchEnabled + always-load lists when enabled globally", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        id: "singleton",
        toolSearchRuntime: {
          enabled: true,
          alwaysLoadServers: ["cognia-tools"],
          alwaysLoadTools: ["git_status"],
        },
      } as unknown as AppSettings,
    })
    expect(opts.toolSearchEnabled).toBe(true)
    expect(opts.alwaysLoadServers).toEqual(["cognia-tools"])
    expect(opts.alwaysLoadTools).toEqual(["git_status"])
  })

  it("character override replaces the global runtime policy", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        id: "singleton",
        toolSearchRuntime: { enabled: true, alwaysLoadServers: ["global"] },
      } as unknown as AppSettings,
      character: makeChar({
        id: "c1",
        toolSearchRuntimeOverride: { enabled: true, alwaysLoadServers: ["char"] },
      }),
    })
    expect(opts.alwaysLoadServers).toEqual(["char"])
  })

  it("leaves toolSearchEnabled unset when disabled", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.toolSearchEnabled).toBeUndefined()
  })
})

describe("resolveSendOptions — unified LSP (sendOptions.lsp)", () => {
  it("resolves builtin + user layers onto opts.lsp when enabled with a cwd", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: {
        lsp: {
          enabled: true,
          servers: [{ id: "lsp_custom", name: "Lua", languages: ["lua"], command: "lua-ls" }],
        },
      } as AppSettings,
    })
    expect(opts.lsp?.enabled).toBe(true)
    const ids = (opts.lsp?.servers ?? []).map((srv) => srv.id)
    expect(ids).toContain("typescript")
    expect(ids).toContain("lsp_custom")
    // jsdom is not Tauri — the managed install dir stays unset.
    expect(opts.lsp?.installDir).toBeUndefined()
    expect(opts.lsp?.autoInstall).toBe(true)
  })

  it("falls back to the legacy builtinTools.lsp toggle when settings.lsp.enabled is unset", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: { builtinTools: { lsp: true } } as AppSettings,
    })
    expect(opts.lsp?.enabled).toBe(true)
  })

  it("omits opts.lsp without a cwd", async () => {
    const opts = await resolveSendOptions({
      appSettings: { lsp: { enabled: true, servers: [] } } as unknown as AppSettings,
    })
    expect(opts.lsp).toBeUndefined()
  })

  it("omits opts.lsp when the master toggle is off", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: { lsp: { enabled: false, servers: [] } } as unknown as AppSettings,
    })
    expect(opts.lsp).toBeUndefined()
  })

  it("propagates autoInstall: false", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workingDir: "/proj" }),
      appSettings: {
        lsp: { enabled: true, servers: [], autoInstall: false },
      } as unknown as AppSettings,
    })
    expect(opts.lsp?.autoInstall).toBe(false)
  })
})

describe("desktop-independent DI seams (standalone CLI)", () => {
  // The standalone agent CLI cannot reach Dexie or the Rust account/proxy
  // resolvers, so it injects pre-resolved data via ctx. These tests assert the
  // seams short-circuit the Dexie/IPC calls AND that the desktop path (fields
  // left undefined) is byte-identical to before.

  describe("preloadedMcpServers", () => {
    it("uses the injected list verbatim and never touches Dexie", async () => {
      const injected = [{ id: "cli-mcp", name: "CLI MCP" }] as unknown as Awaited<
        ReturnType<typeof listEnabledMcpServers>
      >
      mBuildMap.mockReturnValueOnce({ "cli-mcp": { command: "x", args: [] } })
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        preloadedMcpServers: injected,
      })
      expect(mListMcp).not.toHaveBeenCalled()
      expect(mBuildMap).toHaveBeenCalledWith(injected)
      expect(opts.mcpServers).toEqual({ "cli-mcp": { command: "x", args: [] } })
    })

    it("empty array means no MCP and still skips Dexie", async () => {
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        preloadedMcpServers: [],
      })
      expect(mListMcp).not.toHaveBeenCalled()
      expect(opts.mcpServers).toBeUndefined()
    })

    it("desktop path (undefined) still queries Dexie", async () => {
      await resolveSendOptions({ session: makeSession({ id: "s1" }) })
      expect(mListMcp).toHaveBeenCalled()
    })
  })

  describe("preloadedEnv", () => {
    it("forwards the injected env and skips the Rust account/proxy resolvers", async () => {
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        preloadedEnv: { ANTHROPIC_API_KEY: "sk-cli", HTTPS_PROXY: "http://p" },
      })
      expect(mResolveAccountEnv).not.toHaveBeenCalled()
      expect(mResolveProxyEnv).not.toHaveBeenCalled()
      expect(opts.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-cli", HTTPS_PROXY: "http://p" })
    })

    it("null means no env and still skips the resolvers", async () => {
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        preloadedEnv: null,
      })
      expect(mResolveAccountEnv).not.toHaveBeenCalled()
      expect(mResolveProxyEnv).not.toHaveBeenCalled()
      expect(opts.env).toBeUndefined()
    })

    it("desktop path (undefined) still calls the Rust resolvers", async () => {
      await resolveSendOptions({ session: makeSession({ id: "s1" }) })
      expect(mResolveAccountEnv).toHaveBeenCalled()
      expect(mResolveProxyEnv).toHaveBeenCalled()
    })
  })

  describe("onBuildOptions plugin hook (ADR-0026 §4 §B)", () => {
    it("applies a plugin's returned patch as the final option tweak", async () => {
      const hooks = await import("@/lib/plugin/messaging/hooks-system")
      const spy = jest
        .spyOn(hooks.getPluginEventHooks(), "dispatchBuildOptions")
        .mockResolvedValue({
          sessionId: "s1",
          model: "patched-model",
          appendSystemPrompt: "PATCHED",
        })
      try {
        const opts = await resolveSendOptions({
          character: makeChar({ id: "c1" }),
          session: makeSession({ id: "s1", characterId: "c1" }),
        })
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }))
        expect(opts.model).toBe("patched-model")
        expect(opts.appendSystemPrompt).toBe("PATCHED")
      } finally {
        spy.mockRestore()
      }
    })

    it("leaves options untouched when no plugin returns a patch", async () => {
      const hooks = await import("@/lib/plugin/messaging/hooks-system")
      // dispatcher echoes the input back unchanged (no registered plugins).
      const spy = jest
        .spyOn(hooks.getPluginEventHooks(), "dispatchBuildOptions")
        .mockImplementation(async (input) => input)
      try {
        const opts = await resolveSendOptions({
          character: makeChar({ id: "c1", model: "base-model" }),
          session: makeSession({ id: "s1", characterId: "c1" }),
        })
        expect(opts.model).toBe("base-model")
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe("parent permission ceiling (fail-closed clamp)", () => {
    const {
      getResolvedPermissionCeiling,
      __clearAllDispatchContextsForTesting,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("@/lib/claude/agents/dispatch-context-registry")

    beforeEach(() => {
      __clearAllDispatchContextsForTesting()
    })

    it("intersects allowedTools — a child cannot widen beyond the parent", async () => {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", allowedTools: ["Read", "Bash", "Edit"] }),
        permissionCeiling: { allowedTools: ["Read"] },
      })
      expect(opts.allowedTools).toEqual(["Read"])
    })

    it("unions disallowedTools — a parent deny always cascades", async () => {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", allowedTools: ["Read"], disallowedTools: ["Write"] }),
        permissionCeiling: { disallowedTools: ["Bash"] },
      })
      expect(opts.disallowedTools).toEqual(["Bash", "Write"])
    })

    it("clamps permissionMode down to the lesser-permissive of parent and child", async () => {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", permissionMode: "bypassPermissions" }),
        permissionCeiling: { permissionMode: "plan" },
      })
      expect(opts.permissionMode).toBe("plan")
    })

    it("a restricted parent caps a child that declared NO allow-list (no widening to all)", async () => {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1" }), // no allowedTools ⇒ "all"
        permissionCeiling: { allowedTools: ["Read", "Grep"] },
      })
      expect(opts.allowedTools).toEqual(["Grep", "Read"])
    })

    it("an unrestricted parent (no allow-list) imposes no ceiling", async () => {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", allowedTools: ["Read", "Bash"] }),
        permissionCeiling: {},
      })
      expect(opts.allowedTools).toEqual(["Bash", "Read"])
    })

    it("runs AFTER the plugin onBuildOptions hook — a plugin cannot re-open a forbidden tool", async () => {
      const hooks = await import("@/lib/plugin/messaging/hooks-system")
      const spy = jest
        .spyOn(hooks.getPluginEventHooks(), "dispatchBuildOptions")
        // Malicious/over-eager plugin tries to re-add Bash after the union pass.
        .mockResolvedValue({
          sessionId: "s1",
          model: "claude-opus-4-7",
          allowedTools: ["Read", "Bash"],
        })
      try {
        const opts = await resolveSendOptions({
          character: makeChar({ id: "c1", allowedTools: ["Read"] }),
          session: makeSession({ id: "s1", characterId: "c1" }),
          permissionCeiling: { allowedTools: ["Read"] },
        })
        expect(opts.allowedTools).toEqual(["Read"]) // Bash dropped by the final clamp
      } finally {
        spy.mockRestore()
      }
    })

    it("records the resolved ceiling keyed by session id (post-clamp)", async () => {
      await resolveSendOptions({
        character: makeChar({ id: "c1", allowedTools: ["Read", "Bash"] }),
        session: makeSession({ id: "sess-rec", characterId: "c1" }),
        permissionCeiling: { allowedTools: ["Read"] },
      })
      expect(getResolvedPermissionCeiling("sess-rec")).toEqual({
        allowedTools: ["Read"],
      })
    })

    it("leaves tools untouched and records nothing extra when no ceiling is given", async () => {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", allowedTools: ["Read", "Bash"] }),
        session: makeSession({ id: "sess-noceil", characterId: "c1" }),
      })
      expect(opts.allowedTools).toEqual(["Bash", "Read"])
      // Still deposits its own resolved surface for any child it might dispatch.
      expect(getResolvedPermissionCeiling("sess-noceil")?.allowedTools).toEqual(["Bash", "Read"])
    })
  })
})

describe("native Anthropic web tools (Tier C opt-in)", () => {
  const webNames = (opts: Awaited<ReturnType<typeof resolveSendOptions>>): string[] =>
    (opts.pluginTools ?? []).map((t) => t.name)

  it("surfaces the custom web tools by default", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(webNames(opts)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
    expect(opts.allowedTools ?? []).not.toContain("WebSearch")
  })

  it("swaps to native WebSearch/WebFetch on the Anthropic path when opted in", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { webTools: { enabled: true, nativeOnAnthropic: true } } as AppSettings,
    })
    expect(webNames(opts)).not.toContain("web_search")
    expect(webNames(opts)).not.toContain("web_fetch")
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]))
  })

  it("keeps the custom tools for non-Anthropic providers even when opted in", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: { webTools: { enabled: true, nativeOnAnthropic: true } } as AppSettings,
    })
    expect(webNames(opts)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
    expect(opts.allowedTools ?? []).not.toContain("WebSearch")
  })

  it("un-disallows WebSearch/WebFetch when opted in", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", disallowedTools: ["WebSearch", "Bash"] }),
      appSettings: { webTools: { enabled: true, nativeOnAnthropic: true } } as AppSettings,
    })
    expect(opts.disallowedTools ?? []).not.toContain("WebSearch")
    expect(opts.disallowedTools ?? []).toContain("Bash")
  })
})

describe("agent self-invocation tools (Skill / SlashCommand)", () => {
  const toolNames = (opts: Awaited<ReturnType<typeof resolveSendOptions>>): string[] =>
    (opts.pluginTools ?? []).map((t) => t.name)

  it("does not surface Skill / SlashCommand by default (opt-in)", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(toolNames(opts)).not.toContain("Skill")
    expect(toolNames(opts)).not.toContain("SlashCommand")
  })

  it("appends the Skill tool when selfInvokeTools.skill is on", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { skill: true } } as AppSettings,
    })
    expect(toolNames(opts)).toContain("Skill")
  })

  it("appends the SlashCommand tool when selfInvokeTools.slashCommand is on", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { slashCommand: true } } as AppSettings,
    })
    expect(toolNames(opts)).toContain("SlashCommand")
  })

  it("appends team-collaboration tools only on a team session with the flag on", async () => {
    const teamSession = makeSession({ id: "s1", characterId: "c1", kind: "team" })
    const opts = await resolveSendOptions({
      session: teamSession,
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { teamCollaboration: true } } as AppSettings,
    })
    expect(toolNames(opts)).toContain("team_send_message")
    expect(toolNames(opts)).toContain("team_delegate")
  })

  it("does NOT append team-collaboration tools on a non-team session even with the flag", async () => {
    const directSession = makeSession({ id: "s1", characterId: "c1", kind: "direct" })
    const opts = await resolveSendOptions({
      session: directSession,
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { teamCollaboration: true } } as AppSettings,
    })
    expect(toolNames(opts)).not.toContain("team_send_message")
  })
})

describe("anthropic-managed (container) skills", () => {
  it("warns and does NOT set containerSkillIds — the SDK cannot attach uploaded skill_ids", async () => {
    const char = makeChar({ id: "c1", pluginSkillIds: ["plg-managed"] })
    mResolveSkillsForCharacter.mockResolvedValue([
      {
        id: "plg-managed",
        name: "Managed",
        description: "",
        source: "plugin",
        containerSkillId: "sk-1",
        containerSkillVersion: "1.0.0",
      },
    ])
    mExtractContainerSkillIds.mockReturnValue([{ skill_id: "sk-1", version: "1.0.0" }])
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    const opts = await resolveSendOptions({ character: char })

    // The dead-drop is gone: the field is never populated…
    expect(opts.containerSkillIds).toBeUndefined()
    // …and the user is told the managed skill won't run (named explicitly).
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot be attached"))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sk-1"))

    warn.mockRestore()
  })

  it("does not warn when no managed skills are resolved", async () => {
    const char = makeChar({ id: "c1", pluginSkillIds: ["plg-inline"] })
    mResolveSkillsForCharacter.mockResolvedValue([
      { id: "plg-inline", name: "Inline", description: "", source: "plugin", body: "do things" },
    ])
    mExtractContainerSkillIds.mockReturnValue([])
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    const opts = await resolveSendOptions({ character: char })

    expect(opts.containerSkillIds).toBeUndefined()
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("cannot be attached"))

    warn.mockRestore()
  })
})

describe("includePartialMessages (token-level streaming gate)", () => {
  it("enables on an interactive send by default (no setting)", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.includePartialMessages).toBe(true)
  })

  it("respects streamPartialMessages = false", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { streamPartialMessages: false } as AppSettings,
    })
    expect(opts.includePartialMessages).toBeUndefined()
  })

  it("does NOT enable on a connector send (conversationKey set)", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      conversationKey: "telegram:123",
    })
    expect(opts.includePartialMessages).toBeUndefined()
  })

  it("does NOT enable on a standalone/headless send (preloadedEnv provided)", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      preloadedEnv: null,
      preloadedMcpServers: [],
    })
    expect(opts.includePartialMessages).toBeUndefined()
  })
})

describe("maxBudgetUsd from active goal (/goal cost ceiling)", () => {
  const activeGoal = (maxBudgetUsd?: number) =>
    ({
      id: "g1",
      sessionId: "s1",
      status: "active",
      turnsUsed: 0,
      tokensUsed: 0,
      config: {
        maxTurns: 20,
        maxTokens: 200_000,
        maxJudgeFailures: 3,
        timeoutMs: 1,
        ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      },
    }) as unknown as import("@/types/goal").Goal

  it("forwards a positive goal budget to opts.maxBudgetUsd", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      activeGoal: activeGoal(3.5),
    })
    expect(opts.maxBudgetUsd).toBe(3.5)
  })

  it("does not set maxBudgetUsd when the goal has no (or zero) budget", async () => {
    const none = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      activeGoal: activeGoal(undefined),
    })
    expect(none.maxBudgetUsd).toBeUndefined()
    const zero = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      activeGoal: activeGoal(0),
    })
    expect(zero.maxBudgetUsd).toBeUndefined()
  })

  it("does not set maxBudgetUsd without an active goal", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.maxBudgetUsd).toBeUndefined()
  })
})

describe("resolveSendOptions — agent-trace root span minting", () => {
  const HEX32 = /^[0-9a-f]{32}$/
  const HEX16 = /^[0-9a-f]{16}$/

  afterEach(() => {
    __resetAgentTraceEmitterForTesting()
  })

  it("does NOT mint a root span unless emitTrace is set (opt-in)", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.traceId).toBeUndefined()
    expect(opts.spanId).toBeUndefined()
  })

  it("mints traceId + spanId with W3C shapes when emitTrace is true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s-trace" }),
      character: makeChar({ id: "c1" }),
      emitTrace: true,
    })
    expect(opts.traceId).toMatch(HEX32)
    expect(opts.spanId).toMatch(HEX16)
  })

  it("stamps the root span surface from traceSurface and carries session/provider metadata", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s-conn" }),
      character: makeChar({ id: "c1" }),
      emitTrace: true,
      traceSurface: "connector",
      conversationKey: "conv-9",
      routingContextHint: { promptText: "hello there" },
    })
    const span = __getActiveSpanForTesting(opts.spanId!)
    expect(span).toBeDefined()
    expect(span?.surface).toBe("connector")
    expect(span?.sessionId).toBe("s-conn")
    expect(span?.operationName).toBe("invoke_agent")
    expect(span?.inputPreview).toBe("hello there")
    expect(span?.metadata).toMatchObject({ conversationKey: "conv-9" })
    // parentSpanId is absent on a root span.
    expect(span?.parentSpanId).toBeUndefined()
  })

  it("stamps a parentTrace verbatim and does NOT mint a new root span", async () => {
    const parentTrace = { traceId: "a".repeat(32), rootSpanId: "b".repeat(16) }
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s-child" }),
      character: makeChar({ id: "c1" }),
      emitTrace: true,
      parentTrace,
    })
    // Verbatim stamping — fresh ids would differ (random), so equality proves
    // no new span was minted.
    expect(opts.traceId).toBe(parentTrace.traceId)
    expect(opts.spanId).toBe(parentTrace.rootSpanId)
    expect(__getActiveSpanForTesting(parentTrace.rootSpanId)).toBeUndefined()
  })
})

describe("resolveSendOptions — forwardSubagentText (SDK-subagent bridge)", () => {
  it("enables forwardSubagentText for team and workflow-editor sessions", async () => {
    const team = await resolveSendOptions({
      session: makeSession({ id: "s-team", kind: "team" }),
      character: makeChar({ id: "c1" }),
    })
    expect(team.forwardSubagentText).toBe(true)

    const wf = await resolveSendOptions({
      session: makeSession({ id: "workflow:wf1", kind: "workflow-editor" }),
      character: makeChar({ id: "c1" }),
    })
    expect(wf.forwardSubagentText).toBe(true)
  })

  it("leaves forwardSubagentText off for a direct chat session", async () => {
    const direct = await resolveSendOptions({
      session: makeSession({ id: "s-direct", kind: "direct" }),
      character: makeChar({ id: "c1" }),
    })
    expect(direct.forwardSubagentText).toBeUndefined()
  })
})
