// Mock every database / store / agent-mode dependency so build-options can be
// exercised as a pure function. We never want to touch Dexie or Zustand here.

// Paired by default — the standalone (BYOK) branch is opted into per-test.
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: jest.fn(() => false),
  getMobileRuntimeMode: jest.fn(() => undefined),
  setMobileRuntimeMode: jest.fn(),
}))

jest.mock("@/lib/db/characters", () => ({
  // ADR-0030: build-options switched to resolveCharacterById so plugin-
  // overlay characters resolve through the same path as Dexie rows.
  resolveCharacterById: jest.fn(),
  listCharactersByIds: jest.fn(),
  seedBuiltInCharacters: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: jest.fn(),
  listSkillsByIds: jest.fn(),
  recordSkillUsage: jest.fn(),
  renderSkillsSection: jest.fn(),
  renderSkillsCatalog: jest.fn(),
  seedBuiltInSkills: jest.fn().mockResolvedValue(undefined),
  // Pure resolver — keep the real implementation so the effective-skill
  // precedence the send path depends on is exercised, not stubbed.
  activeEffectiveSkillIds: jest.requireActual("@/lib/db/skills").activeEffectiveSkillIds,
}))

jest.mock("@/lib/db/skill-resources", () => ({
  listResourcesForSkill: jest.fn(),
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  listEnabledMcpServers: jest.fn(),
  buildMcpServerMap: jest.fn(),
  buildMcpServerMapResolved: jest.fn(),
  buildMcpDisallowedToolNames:
    jest.requireActual("@/lib/db/mcp-servers").buildMcpDisallowedToolNames,
  // Real implementation: it is what expands glob deny rules, and the send-path
  // assertions below are about the tool names it emits.
  resolveMcpDisallowedToolNames:
    jest.requireActual("@/lib/db/mcp-servers").resolveMcpDisallowedToolNames,
}))

jest.mock("@/lib/db/teams", () => ({
  getTeam: jest.fn(),
  seedBuiltInTeams: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: { getState: jest.fn() },
}))

// Since ADR-0117 the send path resolves the turn's mode from the SESSION's
// composition, not the app-wide `modeId`. That reads `compositionForSession`
// off the store module directly, so it needs its own mock — driving `modeId`
// alone no longer decides anything.
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useAgentRuntimeStore: { getState: jest.fn(() => ({})) },
  compositionForSession: jest.fn(() => ({ presetId: "standard" })),
}))

jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: { getState: jest.fn() },
}))

jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: { getState: jest.fn() },
}))

// Dynamically imported only on the API-key-rotation persist path (ADR-0043
// Phase 3) — mocked so that path never touches Dexie/Zustand in this file.
const mockSetProviderConfig = jest.fn().mockResolvedValue(undefined)
const mockUpdateCustomProvider = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      setProviderConfig: (...args: unknown[]) => mockSetProviderConfig(...args),
      updateCustomProvider: (...args: unknown[]) => mockUpdateCustomProvider(...args),
    }),
  },
}))

jest.mock("@/lib/agent/mode-session-update", () => ({
  buildAgentModeSessionUpdate: jest.fn(),
}))

jest.mock("@/lib/plugin/bridge/sidecar-tools-bridge", () => ({
  buildPluginToolsManifest: jest.fn(() => []),
}))

const mockHasWorkspaceFsBackend = jest.fn(() => true)
jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => mockHasWorkspaceFsBackend(),
}))

// Pro IDE reachability — drives whether the editor write tools and their
// consent tier are surfaced at all. Defaults off so every existing expectation
// keeps describing a non-desktop shell.
const mockLocalCapabilities = jest.fn<string[], []>(() => [])
const mockHostProfile = { value: "desktop" as string }
jest.mock("@/lib/platform/capabilities", () => {
  const actual = jest.requireActual("@/lib/platform/capabilities")
  return {
    ...actual,
    detectLocalCapabilities: () => mockLocalCapabilities(),
    detectHostProfile: () => mockHostProfile.value,
    hasCapability: (cap: string, caps?: string[]) =>
      (caps ?? mockLocalCapabilities()).includes(cap),
  }
})

jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: jest.fn(),
}))

// W1 multi-bot — instance-level AI binding defaults. The resolver hoists ONE
// adapter-row read (threaded `ctx.imAdapterRow` or this fallback) that feeds
// the model/provider/effort chains and the A2UI capability block.
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
}))

// ADR-0028 — env-resolver bridges the renderer to the Rust per-account env
// builder. Mock both helpers so resolveSendOptions exercises the integration
// path without a real Tauri transport.
jest.mock("@/lib/claude/env-resolver", () => ({
  resolveAccountId: jest.fn(),
  resolveAccountEnv: jest.fn(),
  resolveProxyEnv: jest.fn(),
}))

const mockGetAgentEnvSecret = jest.fn()
jest.mock("@/lib/agent/agent-env-keyring", () => ({
  loadAgentEnvSecret: (...args: unknown[]) => mockGetAgentEnvSecret(...args),
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

// Project-scoped RAG (workspace knowledge base) — dynamically imported by
// resolveSendOptions. Mock so we can drive the injected section deterministically.
const mApplyProjectKnowledge = jest.fn()
jest.mock("@/lib/project-knowledge/runtime/apply-project-context", () => ({
  applyProjectKnowledgeContext: (...args: unknown[]) => mApplyProjectKnowledge(...args),
}))

const mApplyAgentKnowledge = jest.fn()
jest.mock("@/lib/knowledge-base/runtime/apply-agent-knowledge-context", () => ({
  applyAgentKnowledgeContextFromDb: (...args: unknown[]) => mApplyAgentKnowledge(...args),
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

// Desktop probe. Defaults to `false` — the same value the real `isTauri()`
// returns under Jest — so every pre-existing expectation is unchanged; the
// desktop-only vector tools flip it per-test.
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isNativeMobile: jest.fn(() => false),
}))

const mockBuildSupportContext = jest.fn(async (..._args: unknown[]) => "SUPPORT_CONTEXT")
jest.mock("@/lib/support-agent/context", () => {
  const actual = jest.requireActual("@/lib/support-agent/context")
  return {
    ...actual,
    buildSupportAgentContext: (...args: unknown[]) => mockBuildSupportContext(...args),
    isSupportDiagnosticsEnabled: () => true,
  }
})

import { isTauri } from "@/lib/tauri"
import { isNativeMobile } from "@/lib/platform/detect"
import { buildAgentModeSessionUpdate } from "@/lib/agent/mode-session-update"
import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "@/lib/claude/env-resolver"
import {
  __resetSandboxSessionRuntimeForTesting,
  HOST_FALLBACK_RUNTIME_REF,
  sandboxSessionRuntime,
} from "@/lib/sandbox/session-runtime"
import { listCharactersByIds, resolveCharacterById } from "@/lib/db/characters"
import { buildMcpServerMapResolved, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import {
  listEnabledSkillsByIds,
  listSkillsByIds,
  recordSkillUsage,
  renderSkillsCatalog,
  renderSkillsSection,
} from "@/lib/db/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { getTeam } from "@/lib/db/teams"
import { BUILT_IN_SKILL_CATALOG, builtinSkillId } from "@/lib/skills/built-in-catalog"
import { buildPluginToolsManifest } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import { loggers } from "@cognia/logging"
import * as standaloneMode from "@/lib/runtime/standalone-mode"
import { ProviderRoutingEngine, RoutingNoCandidatesError } from "@cognia/provider-routing"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { useAgentRuntimeStore } from "@/stores/agent"
import { compositionForSession } from "@/stores/agent/agent-runtime-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import {
  __getActiveSpanForTesting,
  __resetAgentTraceEmitterForTesting,
} from "@cognia/agent-trace/emitter"
import {
  _resetImPromptMemosForTest,
  listTeamMembers,
  resolveMemberConfig,
  resolveSendOptions,
} from "./build-options"
import type { BuildOptionsContext } from "./build-options"
import {
  EXTERNAL_AGENT_PROVIDER_ID,
  externalAgentProviderId,
} from "@/lib/ai/agent/external/session-models"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type {
  AppSettings,
  Character,
  ChatSession,
  Skill,
  Team,
  TeamMember,
} from "@cognia/agent-config-types"
import { RESOLVED_SPEC_VERSION } from "@cognia/agent-config-types/agent-execution"
import type { Project } from "@/types"

const mGetCharacter = resolveCharacterById as jest.Mock
const mListCharsByIds = listCharactersByIds as jest.Mock
const mListSkills = listEnabledSkillsByIds as jest.Mock
const mListSkillsByIds = listSkillsByIds as jest.Mock
const mRecordUsage = recordSkillUsage as jest.Mock
const mRender = renderSkillsSection as jest.Mock
const mRenderCatalog = renderSkillsCatalog as jest.Mock
const mListSkillResources = listResourcesForSkill as jest.Mock
const mListMcp = listEnabledMcpServers as jest.Mock
const mBuildMap = buildMcpServerMapResolved as jest.Mock
const mGetTeam = getTeam as jest.Mock
const mRuntimeGet = (useAgentRuntimeStore as unknown as { getState: jest.Mock }).getState
const mCompositionForSession = compositionForSession as jest.MockedFunction<
  typeof compositionForSession
>

/** Point the turn at a preset the way a session selection would. */
function selectPreset(presetId: string, authority?: string) {
  mCompositionForSession.mockReturnValue({
    presetId,
    ...(authority ? { authority: authority as never } : {}),
  })
}
const mCustomGet = (useCustomModeStore as unknown as { getState: jest.Mock }).getState
const mPluginGet = (usePluginStore as unknown as { getState: jest.Mock }).getState
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

/** Names of the plugin/self-invocation tools resolveSendOptions surfaces. */
const toolNames = (opts: Awaited<ReturnType<typeof resolveSendOptions>>): string[] =>
  (opts.pluginTools ?? []).map((t) => t.name)

beforeEach(() => {
  jest.clearAllMocks()
  // Sane defaults so the function doesn't error when a test forgets to set
  // an expectation.
  mListSkills.mockResolvedValue([])
  mListSkillsByIds.mockResolvedValue([])
  mRecordUsage.mockResolvedValue(undefined)
  mRender.mockReturnValue("")
  mRenderCatalog.mockReturnValue("")
  mListSkillResources.mockResolvedValue([])
  mListMcp.mockResolvedValue([])
  mBuildMap.mockReturnValue({})
  mGetTeam.mockResolvedValue(undefined)
  mRuntimeGet.mockReturnValue({ modeId: undefined })
  // Production-faithful default: `defaultComposition` is always populated, so
  // a session with no explicit choice still runs Standard (→ the `general`
  // built-in, which contributes no prompt and no tools).
  mCompositionForSession.mockReturnValue({ presetId: "standard" })
  mCustomGet.mockReturnValue({ customModes: {} })
  mPluginGet.mockReturnValue({ plugins: {}, getAllModes: () => [] })
  mBuildModeUpdate.mockReturnValue(undefined)
  // ADR-0028 — default to the "no account override" path so existing tests
  // see today's behaviour. Per-test overrides activate the new flow.
  mResolveAccountId.mockReturnValue(null)
  mResolveAccountEnv.mockResolvedValue({})
  mResolveProxyEnv.mockResolvedValue({})
  mResolveSkillsForCharacter.mockResolvedValue([])
  mExtractContainerSkillIds.mockReturnValue([])
  mRenderResolvedSkillsSection.mockReturnValue("")
  mockHasWorkspaceFsBackend.mockReturnValue(true)
})

/**
 * An install whose web access resolves to Cognia's host-routed pair: a
 * configured search provider (so `web_search` is not withheld) and the explicit
 * preference for it over a runtime native.
 */
const COGNIA_WEB_SETTINGS = {
  webTools: { enabled: true, preferCognia: true },
  searchProviders: {
    tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
  },
} as unknown as AppSettings

describe("resolveSendOptions — editor workspace tool", () => {
  it("exposes read_active_editor only when an active workspace is present", async () => {
    const withoutWorkspace = await resolveSendOptions({ character: makeChar() })
    expect(toolNames(withoutWorkspace)).not.toContain("read_active_editor")

    const withWorkspace = await resolveSendOptions({
      character: makeChar(),
      activeProject: makeProject([{ path: "/work/project", isPrimary: true }]),
    })
    expect(toolNames(withWorkspace)).toContain("read_active_editor")

    mockHasWorkspaceFsBackend.mockReturnValue(false)
    const withoutBackend = await resolveSendOptions({
      character: makeChar(),
      activeProject: makeProject([{ path: "/work/project", isPrimary: true }]),
    })
    expect(toolNames(withoutBackend)).not.toContain("read_active_editor")
  })
})

describe("resolveSendOptions — session working set", () => {
  it("surfaces the core tool and concise guidance for persisted sessions", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ disablePluginTools: true }),
      session: makeSession({ id: "working-session" }),
    })

    expect(toolNames(opts)).toContain("working_set")
    expect(opts.appendSystemPrompt).toContain("Use working_set")
  })

  it("does not surface session state for a transient call without a session", async () => {
    const opts = await resolveSendOptions({ character: makeChar() })
    expect(toolNames(opts)).not.toContain("working_set")
  })
})

describe("resolveSendOptions — Cognia Support safety", () => {
  it("replaces normal Agent overlays with read-only docs and redacted diagnostics context", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "char_builtin_support",
        systemPrompt: "SUPPORT_IDENTITY",
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash", "Write"],
        mcpServerIds: ["unsafe"],
        executionPolicy: {
          envBindings: [{ name: "TOKEN", kind: "secret", secretRef: "secret-ref" }],
        },
      }),
      activeProject: makeProject([{ path: "/private/project", isPrimary: true }]),
      trustedWorkspaceRoots: ["/private/project"],
      preloadedMcpServers: [],
      preloadedEnv: { SECRET: "value" },
      twinUserMessage: "diagnose this runtime error",
      appSettings: { id: "singleton", language: "en" } as AppSettings,
    })

    expect(mockGetAgentEnvSecret).not.toHaveBeenCalled()
    expect(mockBuildSupportContext).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "diagnose this runtime error", diagnosticsEnabled: true })
    )
    expect(opts).toMatchObject({
      permissionMode: "plan",
      toolSurface: "none",
      allowedTools: [],
      mcpServers: {},
      systemPrompt: "SUPPORT_IDENTITY\n\nSUPPORT_CONTEXT",
    })
    expect(opts).not.toHaveProperty("cwd")
    expect(opts).not.toHaveProperty("env")
    expect(opts).not.toHaveProperty("agents")
    expect(opts).not.toHaveProperty("builtinTools")
    expect(opts).not.toHaveProperty("pluginTools")
    expect(opts).not.toHaveProperty("lsp")
  })
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

describe("resolveSendOptions — workflow skills guarantee the typed runner tool", () => {
  const workflowSkill = {
    id: "sk-wf",
    name: "Summarizer",
    content: "graph-bodied",
    kind: "workflow",
    workflowId: "wf1",
    status: "enabled",
  }

  it("appends wf_run_workflow_typed when a kind:workflow skill is active and the plugin is absent", async () => {
    mListSkills.mockResolvedValueOnce([workflowSkill])
    ;(buildPluginToolsManifest as jest.Mock).mockReturnValueOnce([])

    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", skillIds: ["sk-wf"] }),
    } as never)

    const names = toolNames(opts)
    expect(names).toContain("wf_run_workflow_typed")
    const entry = (opts.pluginTools ?? []).find((t) => t.name === "wf_run_workflow_typed")
    expect(entry?.pluginId).toBe("cognia-workflow-ai")
  })

  it("does not duplicate the runner when the workflow-ai plugin already manifests it", async () => {
    mListSkills.mockResolvedValueOnce([workflowSkill])
    ;(buildPluginToolsManifest as jest.Mock).mockReturnValueOnce([
      {
        name: "wf_run_workflow_typed",
        description: "from plugin",
        jsonSchema: {},
        pluginId: "cognia-workflow-ai",
      },
    ])

    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", skillIds: ["sk-wf"] }),
    } as never)

    const matches = (opts.pluginTools ?? []).filter((t) => t.name === "wf_run_workflow_typed")
    expect(matches).toHaveLength(1)
    expect(matches[0]?.description).toBe("from plugin")
  })

  it("does not inject the runner when no workflow skill is active", async () => {
    mListSkills.mockResolvedValueOnce([
      { id: "sk-md", name: "Plain", content: "body", status: "enabled" },
    ])
    ;(buildPluginToolsManifest as jest.Mock).mockReturnValueOnce([])

    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", skillIds: ["sk-md"] }),
    } as never)

    expect(toolNames(opts)).not.toContain("wf_run_workflow_typed")
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

describe("resolveSendOptions — opt-in Auto routing", () => {
  const routingConfig = {
    strategy: "quality",
    allowPerRequestOverride: true,
    providerConstraints: [],
    requestTimeoutMs: 30000,
    maxFallbackAttempts: 3,
  }
  const mapping = (alias: string, modelId: string) => ({
    id: `m-${alias}`,
    alias,
    providers: [{ providerId: "anthropic", modelId }],
    distribution: "priority",
    enabled: true,
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
  })
  const tierMappings = [
    mapping("fast", "claude-haiku-4-5-20251001"),
    mapping("balanced", "claude-sonnet-4-6"),
    mapping("powerful", "claude-opus-4-8"),
  ]
  // Guarantees scoreDifficulty >= the powerful threshold (fenced code +
  // reasoning keywords + length + many sentences all saturate).
  const HARD_PROMPT =
    "Please implement and optimize this algorithm step-by-step. Analyze the architecture. Prove correctness. Debug the derivative. ```ts\nfor (;;) {}\n```. " +
    "Refactor the recursive proof into a multi-step analysis of the optimization theorem. ".repeat(
      30
    )
  const settings = (autoRouting?: unknown): AppSettings =>
    ({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      providerSettings: {},
      routingConfig,
      modelMappings: tierMappings,
      ...(autoRouting ? { autoRouting } : {}),
    }) as unknown as AppSettings

  it("is a no-op when disabled (concrete model is untouched)", async () => {
    const opts = await resolveSendOptions({
      appSettings: settings(),
      routingContextHint: { promptText: HARD_PROMPT },
    })
    expect(opts.model).toBe("claude-sonnet-4-6")
    expect(opts.autoRouting).toBeUndefined()
  })

  it("routes a hard prompt to the powerful tier and stamps the decision", async () => {
    const opts = await resolveSendOptions({
      appSettings: settings({
        enabled: true,
        defaultSelection: "auto",
        thresholds: { balanced: 0.34, powerful: 0.67 },
        candidateAliases: ["fast", "balanced", "powerful"],
      }),
      routingContextHint: { promptText: HARD_PROMPT },
    })
    expect(opts.autoRouting?.tier).toBe("powerful")
    expect(opts.autoRouting?.score).toBeGreaterThanOrEqual(0.67)
    // The alias engine then resolved the tier to its concrete model.
    expect(opts.model).toBe("claude-opus-4-8")
    expect(opts.aliasResolution?.alias).toBe("powerful")
  })

  it("routes an easy prompt to the fast tier", async () => {
    const opts = await resolveSendOptions({
      appSettings: settings({
        enabled: true,
        defaultSelection: "auto",
        thresholds: { balanced: 0.34, powerful: 0.67 },
        candidateAliases: ["fast", "balanced", "powerful"],
      }),
      routingContextHint: { promptText: "hi" },
    })
    expect(opts.autoRouting?.tier).toBe("fast")
    expect(opts.model).toBe("claude-haiku-4-5-20251001")
  })

  it("never re-routes an explicitly-typed alias", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "auto-alias", providerId: "anthropic", model: "fast" }),
      appSettings: settings({
        enabled: true,
        thresholds: { balanced: 0.34, powerful: 0.67 },
        candidateAliases: ["fast", "balanced", "powerful"],
      }),
      routingContextHint: { promptText: HARD_PROMPT },
    })
    // Typed "fast" wins; auto never fires.
    expect(opts.autoRouting).toBeUndefined()
    expect(opts.aliasResolution?.alias).toBe("fast")
  })

  it("is a no-op when the prompt text is empty", async () => {
    const opts = await resolveSendOptions({
      appSettings: settings({
        enabled: true,
        thresholds: { balanced: 0.34, powerful: 0.67 },
        candidateAliases: ["fast", "balanced", "powerful"],
      }),
      routingContextHint: { promptText: "" },
    })
    expect(opts.model).toBe("claude-sonnet-4-6")
    expect(opts.autoRouting).toBeUndefined()
  })

  it("falls back to the concrete model when an auto tier has no eligible deployment", async () => {
    // Force the alias engine to report zero candidates for the auto-picked tier.
    const spy = jest
      .spyOn(ProviderRoutingEngine.prototype, "planRoute")
      .mockRejectedValue(new RoutingNoCandidatesError("powerful"))
    try {
      const opts = await resolveSendOptions({
        appSettings: settings({
          enabled: true,
          defaultSelection: "auto",
          thresholds: { balanced: 0.34, powerful: 0.67 },
          candidateAliases: ["fast", "balanced", "powerful"],
        }),
        routingContextHint: { promptText: HARD_PROMPT },
      })
      // Auto rewrote the model to a tier, resolution threw → we revert to the
      // concrete default model instead of hard-failing the send.
      expect(opts.model).toBe("claude-sonnet-4-6")
      expect(opts.autoRouting).toBeUndefined()
      expect(opts.aliasResolution).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it("rethrows for an explicitly-typed alias with no eligible deployment", async () => {
    const spy = jest
      .spyOn(ProviderRoutingEngine.prototype, "planRoute")
      .mockRejectedValue(new RoutingNoCandidatesError("fast"))
    try {
      await expect(
        resolveSendOptions({
          character: makeChar({ id: "typed", providerId: "anthropic", model: "fast" }),
          appSettings: settings({
            enabled: true,
            thresholds: { balanced: 0.34, powerful: 0.67 },
            candidateAliases: ["fast", "balanced", "powerful"],
          }),
          routingContextHint: { promptText: HARD_PROMPT },
        })
      ).rejects.toBeInstanceOf(RoutingNoCandidatesError)
    } finally {
      spy.mockRestore()
    }
  })

  it("is a no-op when no candidate alias is enabled in modelMappings", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        providerSettings: {},
        routingConfig,
        modelMappings: [mapping("reasoning", "claude-opus-4-8")],
        autoRouting: {
          enabled: true,
          thresholds: { balanced: 0.34, powerful: 0.67 },
          candidateAliases: ["fast", "balanced", "powerful"],
        },
      } as unknown as AppSettings,
      routingContextHint: { promptText: HARD_PROMPT },
    })
    expect(opts.model).toBe("claude-sonnet-4-6")
    expect(opts.autoRouting).toBeUndefined()
  })
})

describe("resolveSendOptions — non-Anthropic provider credentials (ADR-0043)", () => {
  it("forwards Bedrock default-chain selection without resolved AWS credentials", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "bedrock-character",
        providerId: "bedrock",
        model: "us.amazon.nova-lite-v1:0",
      }),
      appSettings: {
        defaultProvider: "bedrock",
        providerSettings: {
          bedrock: {
            enabled: true,
            defaultModel: "us.amazon.nova-lite-v1:0",
            bedrock: {
              authMode: "default-chain",
              region: "us-east-1",
              profile: "engineering",
              roleArn: "arn:aws:iam::123456789012:role/Cognia",
            },
          },
        },
      } as unknown as AppSettings,
    })

    expect(opts.providerCredentials).toEqual({
      apiKey: undefined,
      baseURL: undefined,
      protocol: "bedrock",
      bedrockAuthMode: "default-chain",
      region: "us-east-1",
      profile: "engineering",
      roleArn: "arn:aws:iam::123456789012:role/Cognia",
    })
    expect(JSON.stringify(opts.providerCredentials)).not.toContain("secretAccessKey")
  })

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

  it("fills the OpenRouter catalog base URL for a key-only built-in entry (no api.openai.com leak)", async () => {
    // Repro of the reported bug: an OpenRouter key with no stored base URL must
    // resolve to openrouter.ai, NOT default the openai client to api.openai.com.
    const opts = await resolveSendOptions({
      character: makeChar({
        id: "c1",
        providerId: "openrouter",
        model: "poolside/laguna-m.1:free",
      }),
      appSettings: {
        defaultProvider: "openrouter",
        providerSettings: {
          openrouter: { apiKey: "sk-or-v1-xxx" },
        },
      } as unknown as AppSettings,
    })
    expect(opts.provider).toBe("openrouter")
    expect(opts.providerCredentials?.apiKey).toBe("sk-or-v1-xxx")
    expect(opts.providerCredentials?.protocol).toBe("openai")
    expect(opts.providerCredentials?.baseURL).toBe("https://openrouter.ai/api/v1")
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

describe("resolveSendOptions — multi-API-key rotation (ADR-0043 Phase 3)", () => {
  // Deterministic microtask flush for the fire-and-forget persist call,
  // which the code intentionally does not await before returning `opts`.
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it("overrides the single-key credential with the round-robin-selected pool key", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {
          openai: {
            apiKey: "sk-solo",
            apiKeys: ["sk-pool-0", "sk-pool-1"],
            apiKeyRotationEnabled: true,
            apiKeyRotationStrategy: "round-robin",
            currentKeyIndex: 0,
          },
        },
      } as unknown as AppSettings,
    })
    // currentKeyIndex 0 -> round-robin advances to pool[1], NOT the plain apiKey.
    expect(opts.providerCredentials?.apiKey).toBe("sk-pool-1")
  })

  it("persists the rotation advance onto the built-in provider row", async () => {
    await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {
          openai: {
            apiKey: "sk-solo",
            apiKeys: ["sk-pool-0", "sk-pool-1"],
            apiKeyRotationEnabled: true,
            currentKeyIndex: -1,
          },
        },
      } as unknown as AppSettings,
    })
    await flush()
    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        currentKeyIndex: 0,
        apiKeyUsageStats: expect.objectContaining({
          "sk-pool-0": expect.objectContaining({ usageCount: 1 }),
        }),
      })
    )
    expect(mockUpdateCustomProvider).not.toHaveBeenCalled()
  })

  it("persists the rotation advance onto the custom provider row instead", async () => {
    await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "acme", model: "acme-chat" }),
      appSettings: {
        defaultProvider: "acme",
        providerSettings: {},
        customProviders: [
          {
            id: "acme",
            isCustom: true,
            protocol: "openai",
            baseURL: "https://llm.acme.dev",
            apiKey: "sk-solo",
            apiKeys: ["sk-pool-0"],
            apiKeyRotationEnabled: true,
            currentKeyIndex: -1,
          },
        ],
      } as unknown as AppSettings,
    })
    await flush()
    expect(mockUpdateCustomProvider).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ currentKeyIndex: 0 })
    )
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("leaves the plain apiKey untouched when rotation is disabled", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {
          openai: { apiKey: "sk-solo", apiKeys: ["sk-pool-0", "sk-pool-1"] },
        },
      } as unknown as AppSettings,
    })
    expect(opts.providerCredentials?.apiKey).toBe("sk-solo")
    await flush()
    expect(mockSetProviderConfig).not.toHaveBeenCalled()
  })

  it("does not block the turn when the persist call rejects", async () => {
    mockSetProviderConfig.mockRejectedValueOnce(new Error("dexie unavailable"))
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: {
          openai: {
            apiKey: "sk-solo",
            apiKeys: ["sk-pool-0"],
            apiKeyRotationEnabled: true,
            currentKeyIndex: -1,
          },
        },
      } as unknown as AppSettings,
    })
    expect(opts.providerCredentials?.apiKey).toBe("sk-pool-0")
    await flush()
    expect(warnSpy).toHaveBeenCalledWith(
      "api key rotation advance persist failed",
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })
})

describe("resolveSendOptions — compaction config", () => {
  it("threads the resolved compaction config and strips draft fields", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { compaction: { enabled: true } } as unknown as AppSettings,
    })
    expect(opts.compaction?.enabled).toBe(true)
    expect(opts.compaction?.maxSummaryTokens).toBe(500)
    expect(opts.compaction?.strategy).toBeDefined()
    // No alternate summary provider/model configured → no summary block.
    expect(opts.compaction?.summary).toBeUndefined()
    // Draft-only keys never reach the wire object.
    expect((opts.compaction as Record<string, unknown>).summaryProvider).toBeUndefined()
    expect((opts.compaction as Record<string, unknown>).summaryModel).toBeUndefined()
  })

  it("resolves an alternate cheap summary provider's credentials", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }), // turn provider = anthropic (default)
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: { openai: { apiKey: "sk-summary" } },
        compaction: {
          enabled: true,
          compressionModel: { provider: "openai", model: "gpt-4o-mini", maxSummaryTokens: 256 },
        },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.maxSummaryTokens).toBe(256)
    expect(opts.compaction?.summary?.model).toBe("gpt-4o-mini")
    expect(opts.compaction?.summary?.protocol).toBe("openai")
    expect(opts.compaction?.summary?.credentials?.apiKey).toBe("sk-summary")
  })

  it("does not emit an unauthenticated summary credential for a keyless CLOUD provider", async () => {
    // deepseek is a cloud built-in (apiKeyRequired) whose base URL auto-fills
    // from the catalog. With no key configured, the summary must fall back to
    // the main model instead of firing an unauthenticated request that 401s at
    // compaction time.
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: { deepseek: { enabled: true } },
        compaction: {
          enabled: true,
          compressionModel: { provider: "deepseek", model: "deepseek-chat" },
        },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.summary).toBeUndefined()
  })

  it("allows a keyless LOCAL summary provider (Ollama) to resolve with just a base URL", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: { ollama: { enabled: true } },
        compaction: {
          enabled: true,
          compressionModel: { provider: "ollama", model: "llama3" },
        },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.summary?.model).toBe("llama3")
    expect(opts.compaction?.summary?.credentials?.baseURL).toBeTruthy()
    expect(opts.compaction?.summary?.credentials?.apiKey).toBeUndefined()
  })

  it("carries providerId on a Codex summary bound to a relay preset (host can't identify it)", async () => {
    // The relay's host is neither *.openai.com nor chatgpt.com, so `providerId`
    // is the ONLY thing that tells the sidecar to route this to /responses.
    mResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "sk-relay",
      baseURL: "https://ai-pixel.online",
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: {},
        compaction: {
          enabled: true,
          compressionModel: { provider: "codex", model: "gpt-5.6-sol" },
        },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.summary?.providerId).toBe("codex")
    expect(opts.compaction?.summary?.credentials?.baseURL).toBe("https://ai-pixel.online")
  })

  it("resolves a Codex summary provider from the subscription vault when settings have no key", async () => {
    mResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }), // turn provider = anthropic (default)
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: {},
        compaction: {
          enabled: true,
          compressionModel: { provider: "codex", model: "gpt-5.2-codex" },
        },
      } as unknown as AppSettings,
    })
    expect(mResolveCodexVaultCredential).toHaveBeenCalledWith("codex", null)
    expect(opts.compaction?.summary).toEqual({
      model: "gpt-5.2-codex",
      protocol: "openai",
      // Travels with `credentials`: the sidecar needs the id (not just the base
      // URL) to route codex to the Responses API behind a relay preset.
      providerId: "codex",
      credentials: {
        apiKey: "chatgpt-bearer",
        baseURL: "https://chatgpt.com/backend-api/codex",
        headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
      },
    })
  })

  it("backfills Codex summary provider headers from the vault when settings provide the key", async () => {
    mResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }), // turn provider = anthropic (default)
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: {
          codex: {
            apiKey: "chatgpt-bearer",
            baseURL: "https://chatgpt.com/backend-api/codex",
          },
        },
        compaction: {
          enabled: true,
          compressionModel: { provider: "codex", model: "gpt-5.2-codex" },
        },
      } as unknown as AppSettings,
    })
    expect(mResolveCodexVaultCredential).toHaveBeenCalledWith("codex", null)
    expect(opts.compaction?.summary?.credentials).toEqual({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
  })

  it("resolves an OpenCode summary provider from the subscription vault when settings have no key", async () => {
    mResolveOpencodeVaultCredential.mockResolvedValue({
      apiKey: "sk-go-vault",
      baseURL: "https://opencode.ai/zen/go/v1",
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }), // turn provider = anthropic (default)
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: {},
        compaction: {
          enabled: true,
          compressionModel: { provider: "opencode-go", model: "kimi-k2.6" },
        },
      } as unknown as AppSettings,
    })
    expect(mResolveOpencodeVaultCredential).toHaveBeenCalledWith("opencode-go", null)
    expect(opts.compaction?.summary).toEqual({
      model: "kimi-k2.6",
      protocol: "openai",
      providerId: "opencode-go",
      credentials: {
        apiKey: "sk-go-vault",
        baseURL: "https://opencode.ai/zen/go/v1",
      },
    })
  })

  it("reuses the turn provider when only a summary model is configured", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o" }),
      appSettings: {
        defaultProvider: "openai",
        providerSettings: { openai: { apiKey: "sk-test" } },
        compaction: { enabled: true, compressionModel: { model: "gpt-4o-mini" } },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.summary).toEqual({ model: "gpt-4o-mini" })
  })

  it("omits the summary block when the alternate provider is unconfigured", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: {
        defaultProvider: "anthropic",
        providerSettings: {},
        compaction: { enabled: true, compressionModel: { provider: "openai" } },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.summary).toBeUndefined()
  })

  it("pins the catalog window so the sidecar trigger ignores its 128k deepseek floor", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "deepseek", model: "deepseek-v4-pro" }),
      appSettings: {
        defaultProvider: "deepseek",
        providerSettings: { deepseek: { apiKey: "sk-ds" } },
        compaction: { enabled: true },
      } as unknown as AppSettings,
    })
    // deepseek-v4-pro is 1M in the provider catalog — NOT the regex table's
    // 128k floor that would auto-compact at ~107k. The catalog states a round
    // decimal 1_000_000; this used to read 1_048_576 because the inline entry
    // shadowed the catalog and carried the binary value.
    expect(opts.compaction?.contextWindow).toBe(1_000_000)
  })

  it("omits contextWindow when compaction is disabled", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "deepseek", model: "deepseek-v4-pro" }),
      appSettings: {
        defaultProvider: "deepseek",
        providerSettings: { deepseek: { apiKey: "sk-ds" } },
        compaction: { enabled: false },
      } as unknown as AppSettings,
    })
    expect(opts.compaction?.contextWindow).toBeUndefined()
  })

  it("appends the post-compaction recovery snippet only when ctx.postCompaction is set", async () => {
    const base = {
      character: makeChar({ id: "c1" }),
      appSettings: { compaction: { enabled: true } } as unknown as AppSettings,
    }
    const without = await resolveSendOptions(base)
    expect(without.appendSystemPrompt ?? "").not.toContain("Post-compaction recovery")

    const withRecovery = await resolveSendOptions({
      ...base,
      postCompaction: { phaseNumber: 1, durableInstructions: "Keep the kanban in sync" },
    })
    expect(withRecovery.appendSystemPrompt).toContain("Post-compaction recovery")
    expect(withRecovery.appendSystemPrompt).toContain("Keep the kanban in sync")
  })

  it("does not append recovery when compaction is disabled", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { compaction: { enabled: false } } as unknown as AppSettings,
      postCompaction: { phaseNumber: 1 },
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("Post-compaction recovery")
  })
})

describe("resolveSendOptions — visual output routing (ADR-0139)", () => {
  it("appends the routing table to every send", async () => {
    // Resident, not a skill: "chart artifact, mermaid fence, A2UI or canvas?"
    // has to be answered before the model knows a skill exists.
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.appendSystemPrompt).toContain("Choosing how to show something")
    expect(opts.appendSystemPrompt).toContain("chart-design")
    expect(opts.appendSystemPrompt).toContain("diagram-design")
  })

  it("withholds the dock-only surfaces from an IM-bound session", async () => {
    // An IM thread has no artifact dock, so a fenced chart or canvas artifact
    // reaches the reader as raw JSON.
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      session: makeSession({
        id: "im-session",
        platformBinding: {
          adapterId: "adp_1",
          platform: "lark",
          conversationKey: "oc_1",
        },
      } as Partial<ChatSession>),
    })
    expect(opts.appendSystemPrompt).toContain("Choosing how to show something")
    expect(opts.appendSystemPrompt).toContain("no artifact dock")
    expect(opts.appendSystemPrompt).not.toContain("chart-design")
  })

  it("does not advertise authoring when the user disables it", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { artifacts: { agentAuthoring: false } } as AppSettings,
    })
    expect(opts.appendSystemPrompt).toContain("markdown table")
    expect(opts.appendSystemPrompt).not.toContain("artifact_create")
    expect(opts.appendSystemPrompt).not.toContain("chart-design")
  })

  it("uses the fenced route when the final filter removes artifact tools", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", toolFilter: { mode: "allow", tools: ["Read"] } }),
      appSettings: { artifacts: { agentAuthoring: true, autoCreate: true } } as AppSettings,
    })
    expect(opts.appendSystemPrompt).toContain("fenced chart payload")
    expect(opts.appendSystemPrompt).not.toContain("artifact_create")
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
    expect(mResolveOpencodeVaultCredential).toHaveBeenCalledWith("opencode-go", null)
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
    expect(mResolveCodexVaultCredential).toHaveBeenCalledWith("codex", null)
    expect(opts.providerCredentials).toEqual({
      apiKey: "chatgpt-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
      protocol: "openai",
      headers: { "ChatGPT-Account-Id": "acct_123", "OAI-Product-Sku": "codex" },
    })
    // Model backfilled from the built-in catalog default.
    expect(opts.model).toBe("gpt-5.6-sol")
  })

  it("uses the session/default resolver's selected Codex account", async () => {
    mResolveAccountId.mockReturnValueOnce("selected-account")
    mResolveCodexVaultCredential.mockResolvedValue({
      apiKey: "selected-bearer",
      baseURL: "https://chatgpt.com/backend-api/codex",
    })

    await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "codex" }),
      appSettings: { defaultProvider: "codex", providerSettings: {} } as unknown as AppSettings,
    })

    expect(mResolveCodexVaultCredential).toHaveBeenCalledWith("codex", "selected-account")
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

describe("resolveSendOptions — the agent mode's A2UI switch", () => {
  // The custom-mode editor has always written `a2uiEnabled` onto the mode
  // record (two switches do), and nothing read it: the control changed no
  // turn. It now sits between the session's explicit toggle and the
  // character's standing default.
  const a2uiMode = (a2uiEnabled: boolean) =>
    ({
      id: "m-a2ui",
      type: "custom",
      name: "Painter",
      description: "",
      icon: "Bot",
      a2uiEnabled,
    }) as AgentModeConfig

  it("turns A2UI on for a turn running under a mode that asks for it", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      agentMode: a2uiMode(true),
    })
    expect(opts.appendSystemPrompt ?? "").toMatch(/A2UI/i)
  })

  it("leaves it off when the mode does not ask", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      agentMode: a2uiMode(false),
    })
    expect(opts.appendSystemPrompt ?? "").not.toMatch(/A2UI/i)
  })

  it("yields to the session's own toggle, which is the closer scope", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", a2uiEnabled: false } as ChatSession & {
        a2uiEnabled?: boolean
      }),
      character: makeChar(),
      agentMode: a2uiMode(true),
    })
    expect(opts.appendSystemPrompt ?? "").not.toMatch(/A2UI/i)
  })

  it("outranks the character's standing default", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ a2uiEnabled: false }),
      agentMode: a2uiMode(true),
    })
    expect(opts.appendSystemPrompt ?? "").toMatch(/A2UI/i)
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

  it("includes the host built-in subagents so they are @-mentionable in direct chat", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.agents).toHaveProperty("workflow-designer")
    expect(opts.agents).toHaveProperty("workflow-doc-writer")
  })

  it("routes the turn to a @-mentioned subagent that is registered (opts.agent)", async () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "bo-route-1",
      name: "Route Helper",
      description: "helps",
      category: "general",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "You help." },
      isBuiltIn: false,
    })
    try {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1" }),
        targetAgentId: "template:route-helper",
      })
      expect(opts.agent).toBe("template:route-helper")
      // A built-in id resolves too (it is registered in direct chat now).
      const builtin = await resolveSendOptions({
        character: makeChar({ id: "c1" }),
        targetAgentId: "workflow-designer",
      })
      expect(builtin.agent).toBe("workflow-designer")
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("bo-route-1")
    }
  })

  it("drops an unknown / stale targetAgentId (leaves opts.agent unset)", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      targetAgentId: "template:does-not-exist",
    })
    expect(opts.agent).toBeUndefined()
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

  it("force-offers dispatch_agent in plan mode even when nesting is off", async () => {
    ;(buildPluginToolsManifest as jest.Mock).mockClear()
    await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { permissionMode: "plan" } as never,
    })
    const lastCall = (buildPluginToolsManifest as jest.Mock).mock.calls.at(-1)?.[0]
    // Plan mode dispatches read-only Explore/Plan subagents (Claude Code parity),
    // so the tool must be offered even without the nesting opt-in.
    expect(lastCall?.dispatchAgent).toMatchObject({ enabled: true, depth: 0 })
    expect(lastCall?.dispatchAgent.available.some((a: { id: string }) => a.id === "Explore")).toBe(
      true
    )
    expect(lastCall?.dispatchAgent.available.some((a: { id: string }) => a.id === "Plan")).toBe(
      true
    )
  })

  it("does not offer dispatch_agent in default mode without nesting", async () => {
    ;(buildPluginToolsManifest as jest.Mock).mockClear()
    await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    const lastCall = (buildPluginToolsManifest as jest.Mock).mock.calls.at(-1)?.[0]
    expect(lastCall?.dispatchAgent).toBeUndefined()
  })

  it("withholds dispatch_agent from a dispatched leaf child in plan mode (no re-nesting)", async () => {
    ;(buildPluginToolsManifest as jest.Mock).mockClear()
    // A dispatched Explore/Plan child (isDispatchedSubagent, no dispatchContext —
    // its def never set allowNesting) must NOT hit the plan-mode force-offer:
    // it is a leaf, not a top-level chat (CLI leaf parity).
    await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { permissionMode: "plan" } as never,
      isDispatchedSubagent: true,
    })
    const lastCall = (buildPluginToolsManifest as jest.Mock).mock.calls.at(-1)?.[0]
    expect(lastCall?.dispatchAgent).toBeUndefined()
  })

  it("withholds dispatch_agent from a dispatched leaf child even when nesting is enabled", async () => {
    ;(buildPluginToolsManifest as jest.Mock).mockClear()
    await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { subagentNesting: { enabled: true, maxDepth: 2 } } as never,
      isDispatchedSubagent: true,
    })
    const lastCall = (buildPluginToolsManifest as jest.Mock).mock.calls.at(-1)?.[0]
    expect(lastCall?.dispatchAgent).toBeUndefined()
  })

  it("still offers dispatch_agent to a dispatched child that carries a dispatchContext", async () => {
    ;(buildPluginToolsManifest as jest.Mock).mockClear()
    useSubagentRuntimeStore.getState().addTemplate({
      id: "bo-nest-3",
      name: "Nesting Child",
      description: "helps",
      category: "general",
      taskTemplate: "do {{x}}",
      config: { systemPrompt: "You help." },
      isBuiltIn: false,
    })
    try {
      // allowNesting defs DO get a dispatchContext — the flag must not demote them.
      await resolveSendOptions({
        character: makeChar({ id: "c1" }),
        dispatchContext: { depth: 1, maxDepth: 3, parentChain: [] },
        isDispatchedSubagent: true,
      })
      const lastCall = (buildPluginToolsManifest as jest.Mock).mock.calls.at(-1)?.[0]
      expect(lastCall?.dispatchAgent).toMatchObject({ enabled: true, depth: 1, maxDepth: 3 })
    } finally {
      useSubagentRuntimeStore.getState().deleteTemplate("bo-nest-3")
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

  it("resolves capabilities against the session's workspace, not the UI pointer", async () => {
    // A background turn in a conversation the user has navigated away from must
    // keep the skills of the repo it is working in. `activeProject` is what the
    // shell is showing; the session's own workspace outranks it.
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([])
    await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1", projectId: "owner-workspace" }),
      activeProject: { id: "on-screen-workspace" } as unknown as Parameters<
        typeof resolveSendOptions
      >[0]["activeProject"],
    })
    expect(mListSkills).toHaveBeenCalledWith(["sk1"], { projectId: "owner-workspace" })
  })

  it("falls back to the shown workspace only when the session names none", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([])
    await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1" }),
      activeProject: { id: "on-screen-workspace" } as unknown as Parameters<
        typeof resolveSendOptions
      >[0]["activeProject"],
    })
    expect(mListSkills).toHaveBeenCalledWith(["sk1"], { projectId: "on-screen-workspace" })
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
    expect(mListSkills).toHaveBeenCalledWith(["sk1"], { projectId: null })
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

  it("hybrid mode injects ephemeral skills fully and catalogs implicit character skills", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["implicit"] })
    mListSkills.mockResolvedValueOnce([
      {
        id: "implicit",
        slug: "implicit-skill",
        name: "Implicit",
        description: "Catalog only",
        content: "HIDDEN BODY",
        allowedTools: ["Read"],
      } as Skill,
      {
        id: "explicit",
        slug: "explicit-skill",
        name: "Explicit",
        description: "Attached",
        content: "FULL BODY",
        allowedTools: ["WebSearch"],
      } as Skill,
    ])
    mRenderCatalog.mockReturnValueOnce("CATALOG: implicit-skill")
    mListSkillResources.mockImplementation(async (id: string) =>
      id === "explicit"
        ? [
            {
              id: "r1",
              skillId: id,
              kind: "reference",
              name: "notes.md",
              path: "references/notes.md",
              content: "INLINE NOTES",
              encoding: "utf-8",
              inline: true,
              size: 12,
            },
          ]
        : []
    )

    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "session-hybrid" }),
      ephemeralSkillIds: ["explicit"],
      skillRenderMode: "hybrid",
    })

    expect(opts.systemPrompt).toContain("FULL BODY")
    expect(opts.systemPrompt).toContain("INLINE NOTES")
    expect(opts.systemPrompt).toContain("CATALOG: implicit-skill")
    expect(opts.systemPrompt).not.toContain("HIDDEN BODY")
    expect(toolNames(opts)).toEqual(expect.arrayContaining(["load_skill", "load_skill_resource"]))
    expect(mRecordUsage).toHaveBeenCalledWith(["explicit"])
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["Read", "WebSearch"]))
  })

  it("hybrid mode excludes explicit-only character skills from catalog and allowed tools", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["manual"] })
    mListSkills.mockResolvedValueOnce([
      {
        id: "manual",
        slug: "manual-only",
        name: "Manual",
        content: "manual body",
        invocationPolicy: "explicit",
        allowedTools: ["Bash"],
      } as Skill,
    ])

    const opts = await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "session-hybrid" }),
      skillRenderMode: "hybrid",
    })

    expect(mRenderCatalog).toHaveBeenCalledWith([], expect.objectContaining({ maxTokens: 4000 }))
    expect(opts.systemPrompt ?? "").not.toContain("manual body")
    expect(opts.allowedTools ?? []).not.toContain("Bash")
    expect(toolNames(opts)).not.toContain("load_skill")
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

  it("loads the recorder's trial skill by id, past the enabled-status filter", async () => {
    // ADR-0106: the recording is saved `disabled` on purpose — enabling it is
    // the user's separate act after the trial. Resolving it through the normal
    // path would honour that flag and inject nothing, leaving the trial unable
    // to verify the skill it exists to verify.
    mListSkillsByIds.mockResolvedValueOnce([
      { id: "rec-1", name: "Recorded", content: "body", allowedTools: ["X"] } as unknown as Skill,
    ])
    mRender.mockReturnValueOnce("## Recorded\n\nbody")

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", trialSkillId: "rec-1" }),
    })

    expect(mListSkillsByIds).toHaveBeenCalledWith(["rec-1"])
    expect(opts.systemPrompt).toContain("Recorded")
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["X"]))
  })

  it("makes the trial skill the whole set, so nothing else can explain the result", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "Other", content: "other body", allowedTools: [] } as unknown as Skill,
    ])
    mListSkillsByIds.mockResolvedValueOnce([
      { id: "rec-1", name: "Recorded", content: "body", allowedTools: [] } as unknown as Skill,
    ])

    await resolveSendOptions({
      character: ch,
      session: makeSession({ id: "s1", trialSkillId: "rec-1" }),
    })

    expect(mRender).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "rec-1" })]),
      expect.objectContaining({ maxTokens: 4000 })
    )
    expect(mRender).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "sk1" })]),
      expect.anything()
    )
  })

  it("injects nothing when the trial skill row has gone", async () => {
    mListSkillsByIds.mockResolvedValueOnce([])
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", trialSkillId: "rec-1" }),
    })
    expect(opts.systemPrompt).toBeUndefined()
  })

  it("leaves ordinary sessions on the enabled-status path", async () => {
    const ch = makeChar({ id: "c1", skillIds: ["sk1"] })
    mListSkills.mockResolvedValueOnce([
      { id: "sk1", name: "Skill 1", content: "body", allowedTools: [] } as unknown as Skill,
    ])
    await resolveSendOptions({ character: ch, session: makeSession({ id: "s1" }) })
    expect(mListSkillsByIds).toHaveBeenCalledWith(
      BUILT_IN_SKILL_CATALOG.map((entry) => builtinSkillId(entry))
    )
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
    expect(mListSkills).toHaveBeenCalledWith(["sk1", "sk2"], { projectId: null })
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
    expect(mListSkills).toHaveBeenCalledWith(["sk2"], { projectId: null })
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

  // ── W1 multi-bot — instance-level binding defaults ─────────────────────────

  it("bot defaultModel/defaultProvider apply when session/override/character are silent", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
      character: makeChar({ id: "c1" }),
      appSettings: { defaultModel: "app-default", defaultProvider: "openai" } as AppSettings,
      imOverrideRow: null,
      imAdapterRow: {
        id: "tg-1",
        defaultModel: "claude-fable-5",
        defaultProvider: "anthropic",
      } as AdapterInstanceRow,
    })
    expect(opts.model).toBe("claude-fable-5")
    expect(opts.provider).toBe("anthropic")
  })

  it("bot defaultModel BEATS character.model but loses to session.model and the IM override", async () => {
    const base = {
      character: makeChar({ id: "c1", model: "char-model", providerId: "anthropic" }),
      imOverrideRow: null,
      imAdapterRow: { id: "tg-1", defaultModel: "bot-model" } as AdapterInstanceRow,
    }
    // Beats the character's own model (D1 — operator pin wins).
    const optsChar = await resolveSendOptions({
      ...base,
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
    })
    expect(optsChar.model).toBe("bot-model")

    // Loses to an explicit per-session model.
    const optsSession = await resolveSendOptions({
      ...base,
      session: makeSession({
        id: "s1",
        model: "session-model",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
    })
    expect(optsSession.model).toBe("session-model")

    // Loses to the per-conversation `/model` override.
    const optsIm = await resolveSendOptions({
      ...base,
      imOverrideRow: { modelOverride: "im-model" } as ConversationOverrideRow,
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
    })
    expect(optsIm.model).toBe("im-model")
  })

  it("empty-string bot defaults are treated as unset (no shadowing)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
      character: makeChar({ id: "c1", model: "char-model", providerId: "openai" }),
      imOverrideRow: null,
      imAdapterRow: { id: "tg-1", defaultModel: "  ", defaultProvider: "" } as AdapterInstanceRow,
    })
    expect(opts.model).toBe("char-model")
    expect(opts.provider).toBe("openai")
  })

  it("bot defaultReasoning beats the app default but loses to session.effort", async () => {
    const base = {
      character: makeChar({ id: "c1", providerId: "anthropic" }),
      appSettings: { defaultEffort: "low" } as AppSettings,
      imOverrideRow: null,
      imAdapterRow: {
        id: "tg-1",
        defaultReasoning: "high",
      } as AdapterInstanceRow,
    }
    const opts = await resolveSendOptions({
      ...base,
      session: makeSession({
        id: "s1",
        model: "claude-opus-4-8",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
    })
    expect(opts.effort).toBe("high")

    const optsSession = await resolveSendOptions({
      ...base,
      session: makeSession({
        id: "s1",
        model: "claude-opus-4-8",
        effort: "medium",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
    })
    expect(optsSession.effort).toBe("medium")
  })

  it("falls back to a Dexie adapter-row read for platform-bound sessions when ctx.imAdapterRow is undefined", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const instances = require("@/lib/db/adapter-instances")
    const mGetAdapter = instances.getAdapterInstance as jest.Mock
    mGetAdapter.mockResolvedValueOnce({ id: "tg-1", defaultModel: "bot-model" })
    // `clearMocks` (jest.config) clears call history but NOT the queued
    // `mockResolvedValueOnce` implementations, so a member-override Once left
    // over by an earlier test would win over the bot default in the model
    // chain. Drain it so this test observes the Dexie fallback in isolation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ;(require("@/lib/db/conversation-overrides").readForResolution as jest.Mock).mockReset()
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
      character: makeChar({ id: "c1", providerId: "anthropic" }),
    })
    expect(mGetAdapter).toHaveBeenCalledWith("tg-1")
    expect(opts.model).toBe("bot-model")
  })

  it("ctx.imAdapterRow === null skips the Dexie adapter-row read entirely", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const instances = require("@/lib/db/adapter-instances")
    const mGetAdapter = instances.getAdapterInstance as jest.Mock
    mGetAdapter.mockClear()
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        model: "session-model",
        platformBinding: { adapterId: "tg-1", conversationKey: "telegram:tg-1:9" },
      } as ChatSession),
      character: makeChar({ id: "c1", providerId: "anthropic" }),
      imOverrideRow: null,
      imAdapterRow: null,
    })
    expect(mGetAdapter).not.toHaveBeenCalled()
    expect(opts.model).toBe("session-model")
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

  it("does NOT inject a branchSeed when the session was forked at the SDK level", async () => {
    // The seed and an SDK fork re-establish the SAME pre-branch context.
    // Applying both would send it twice — once as a system prompt, once as the
    // forked conversation — inflating every first turn.
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        forkedFromSdkSessionId: "sdk-parent",
        branchSeed: { kind: "transcript", content: "User: hi" },
      }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("User: hi")
  })

  it("warns when a session carries both a seed and a fork", async () => {
    // `buildChildRow` sets exactly one, so this is unreachable today — but the
    // two fields are written in one function and read in two places, which is
    // how the invariant gets lost.
    const warn = jest.spyOn(loggers.chat, "warn").mockImplementation(() => {})
    try {
      await resolveSendOptions({
        session: makeSession({
          id: "s1",
          forkedFromSdkSessionId: "sdk-parent",
          branchSeed: { kind: "summary", content: "We discussed X." },
        }),
      })
      expect(warn).toHaveBeenCalledWith(
        "branch-seed-and-fork-both-set",
        expect.objectContaining({ sessionId: "s1", branchKind: "summary" })
      )
    } finally {
      warn.mockRestore()
    }
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

  it("falls back to the session composition when ctx.agentMode is undefined", async () => {
    selectPreset("standard")
    await resolveSendOptions({})
    // Standard projects the `general` built-in → buildAgentModeSessionUpdate runs.
    expect(mBuildModeUpdate).toHaveBeenCalled()
  })

  // The defect this replaced: the send path read the app-wide `modeId`, so a
  // per-session selection changed the recorded composition and nothing else.
  it("looks up custom modes named by the session's composition", async () => {
    const custom: AgentModeConfig = {
      id: "custom-1",
      type: "custom",
      name: "Custom",
      description: "",
      icon: "Bot",
      tools: ["tool-x"],
    }
    selectPreset("custom-1")
    mCustomGet.mockReturnValue({ customModes: { "custom-1": custom } })
    mBuildModeUpdate.mockReturnValue({ agentModeId: "custom-1" })

    const opts = await resolveSendOptions({})
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["tool-x"]))
  })

  it("looks up plugin-contributed modes by namespaced id", async () => {
    const pluginMode: AgentModeConfig = {
      id: "cognia-work-mode:work",
      type: "plugin",
      name: "Work",
      description: "",
      icon: "BriefcaseBusiness",
      systemPrompt: "Use work_create_deliverable after researching with host tools.",
    }
    selectPreset(pluginMode.id)
    mPluginGet.mockReturnValue({ plugins: {}, getAllModes: () => [pluginMode] })
    mBuildModeUpdate.mockReturnValue({ agentModeId: pluginMode.id })

    const opts = await resolveSendOptions({})

    expect(mBuildModeUpdate).toHaveBeenCalledWith(pluginMode)
    expect(opts.allowedTools).toBeUndefined()
  })

  // A deleted custom mode leaves a dangling preset id behind. Falling back to
  // Standard is the same thing `resolveComposition` does for the picker, so the
  // turn and the UI agree about what happened.
  it("falls back to Standard when the composition names a preset that is gone", async () => {
    selectPreset("ghost")
    mCustomGet.mockReturnValue({ customModes: {} })
    mBuildModeUpdate.mockReturnValue({ agentModeId: "general" })

    const opts = await resolveSendOptions({})

    expect(mBuildModeUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "general" }))
    // Standard contributes no prompt delta and no tools.
    expect(opts.allowedTools).toBeUndefined()
  })

  // Minimal / Code / Creator have no `AgentModeConfig` at all. Reading the
  // prompt and tools off the mode record made them contribute nothing.
  it("applies a preset that has no legacy mode record behind it", async () => {
    selectPreset("minimal")

    const opts = await resolveSendOptions({})

    expect(mBuildModeUpdate).not.toHaveBeenCalled()
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]))
  })

  // `plan` and `build` stopped being mode records and became authority axis
  // values. Without carrying the axis through, choosing Plan would silently
  // stop being read-only.
  it("carries an explicit authority axis into the permission mode", async () => {
    selectPreset("standard", "plan")

    const opts = await resolveSendOptions({})

    expect(opts.permissionMode).toBe("plan")
  })

  // A preset's `recommends.authority` is a default, not an assertion. Letting
  // it through would shadow the character's permission for every session whose
  // user never touched a mode.
  it("does not let Standard's recommended authority shadow the character", async () => {
    selectPreset("standard")

    const opts = await resolveSendOptions({
      character: { id: "c1", name: "C", permissionMode: "acceptEdits" } as never,
    })

    expect(opts.permissionMode).toBe("acceptEdits")
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
  it("carries only the caller's explicit trusted-root proof", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: false,
      trustedWorkspaceRoots: ["/a", "/a"],
    })
    expect(opts.trustedWorkspaceRoots).toEqual(["/a"])

    const withoutProof = await resolveSendOptions({
      activeProject: makeProject([{ path: "/a", isPrimary: true }]),
      workspaceRestricted: false,
    })
    expect(withoutProof.trustedWorkspaceRoots).toBeUndefined()
  })

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
  // These cases are about how `agentPermissions` merge, so they switch the
  // artifact consent tier off. It is on by default (the artifact tools ship by
  // default and would otherwise prompt on every call) and has its own coverage
  // in "artifact authoring tools" below; leaving it on here would mean every
  // expectation restating eight rules that are not what is under test.
  const noArtifactTier = { artifacts: { agentAuthoring: false } }
  it("wraps legacy commandRules under Bash (unchanged behavior)", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        ...noArtifactTier,
        agentPermissions: { commandRules: { "git *": "allow" } },
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toEqual({ Bash: { "git *": "allow" } })
  })

  it("merges toolRules with commandRules; toolRules wins on conflicts", async () => {
    const opts = await resolveSendOptions({
      appSettings: {
        ...noArtifactTier,
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
        ...noArtifactTier,
        agentPermissions: { toolRules: { b: { z: "ask", a: "allow" }, a: "deny" } },
      } as unknown as AppSettings,
    })
    const b = await resolveSendOptions({
      appSettings: {
        ...noArtifactTier,
        agentPermissions: { toolRules: { a: "deny", b: { a: "allow", z: "ask" } } },
      } as unknown as AppSettings,
    })
    expect(JSON.stringify(a.permissionRuleset)).toBe(JSON.stringify(b.permissionRuleset))
  })

  it("projects a session refusal into the ruleset as an explicit deny", async () => {
    const { __resetSessionDenialsForTesting, rememberDenial } =
      await import("@/lib/claude/permissions/session-denials")
    __resetSessionDenialsForTesting()
    rememberDenial("sess-deny", "Bash", { command: "git push --force" })
    const opts = await resolveSendOptions({
      session: { id: "sess-deny" } as never,
      appSettings: {
        ...noArtifactTier,
        agentPermissions: { commandRules: { "git *": "allow" } },
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toEqual({
      Bash: { "git *": "allow", "git push --force": "deny" },
    })
    __resetSessionDenialsForTesting()
  })

  it("keeps a refusal ahead of a bare-name always-allow grant", async () => {
    const { __resetSessionDenialsForTesting, rememberDenial } =
      await import("@/lib/claude/permissions/session-denials")
    __resetSessionDenialsForTesting()
    rememberDenial("sess-deny-2", "Bash", { command: "rm -rf /tmp/x" })
    const opts = await resolveSendOptions({
      session: { id: "sess-deny-2" } as never,
      appSettings: { alwaysAllowTools: ["Bash"], ...noArtifactTier } as unknown as AppSettings,
    })
    // Both are sent; `canUseTool` returns on the deny before it reads the list.
    expect(opts.alwaysAllowTools).toEqual(["Bash"])
    expect(opts.permissionRuleset).toEqual({ Bash: { "rm -rf /tmp/x": "deny" } })
    __resetSessionDenialsForTesting()
  })

  it("leaves a session with no refusals exactly as before", async () => {
    const { __resetSessionDenialsForTesting } =
      await import("@/lib/claude/permissions/session-denials")
    __resetSessionDenialsForTesting()
    const opts = await resolveSendOptions({
      session: { id: "sess-clean" } as never,
      appSettings: {
        ...noArtifactTier,
        agentPermissions: { commandRules: { "git *": "allow" } },
        alwaysAllowTools: ["Read"],
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toEqual({ Bash: { "git *": "allow" } })
    expect(opts.alwaysAllowTools).toEqual(["Read"])
  })

  it("omits permissionRuleset entirely when no rules are configured", async () => {
    const opts = await resolveSendOptions({
      appSettings: { agentPermissions: {}, ...noArtifactTier } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toBeUndefined()
  })
})

describe("resolveSendOptions — Pro IDE editor write tools (ADR-0088 Phase 3)", () => {
  const onProIdeDesktop = () => mockLocalCapabilities.mockReturnValue(["pro-ide", "shell"])
  const withProject = { activeProject: { path: "/repo" } } as unknown as BuildOptionsContext

  afterEach(() => mockLocalCapabilities.mockReturnValue([]))

  it("surfaces the five write tools beside the read on a Pro-IDE-capable shell", async () => {
    onProIdeDesktop()
    const opts = await resolveSendOptions({ ...withProject })
    const names = (opts.pluginTools ?? []).map((t) => (t as { name: string }).name)
    expect(names).toContain("read_active_editor")
    expect(names).toEqual(
      expect.arrayContaining([
        "open_in_editor",
        "reveal_in_editor",
        "show_editor_diff",
        "apply_editor_edit",
        "save_editor_buffers",
      ])
    )
  })

  it("keeps the read but drops the writes where code-server cannot run", async () => {
    // Web and mobile: the read still answers through Monaco, so withholding it
    // too would be a regression. The writes have no Monaco equivalent.
    const opts = await resolveSendOptions({ ...withProject })
    const names = (opts.pluginTools ?? []).map((t) => (t as { name: string }).name)
    expect(names).toContain("read_active_editor")
    expect(names).not.toContain("open_in_editor")
    expect(names).not.toContain("save_editor_buffers")
  })

  it("ships the consent tier exactly when it ships the tools", async () => {
    onProIdeDesktop()
    const opts = await resolveSendOptions({
      ...withProject,
      appSettings: { agentPermissions: {} } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toMatchObject({
      save_editor_buffers: "ask",
      open_in_editor: "allow",
      show_editor_diff: "allow",
    })
  })

  it("still omits the EDITOR tier where the tools are not surfaced", async () => {
    // Rules for tools this turn never offers are inert payload, and emitting
    // them would break the byte-identical SendOptions the prompt cache needs.
    // The artifact tier is switched off here so the assertion is about the
    // editor tools and nothing else.
    const opts = await resolveSendOptions({
      ...withProject,
      appSettings: {
        agentPermissions: {},
        artifacts: { agentAuthoring: false },
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toBeUndefined()
  })

  it("lets an explicit user rule override the baked-in ask", async () => {
    onProIdeDesktop()
    const opts = await resolveSendOptions({
      ...withProject,
      appSettings: {
        agentPermissions: { toolRules: { save_editor_buffers: "allow" } },
      } as unknown as AppSettings,
    })
    expect(opts.permissionRuleset).toMatchObject({ save_editor_buffers: "allow" })
  })

  it("withholds both tools and tier when the session has no project", async () => {
    onProIdeDesktop()
    const opts = await resolveSendOptions({
      appSettings: {
        agentPermissions: {},
        artifacts: { agentAuthoring: false },
      } as unknown as AppSettings,
    })
    const names = (opts.pluginTools ?? []).map((t) => (t as { name: string }).name)
    expect(names).not.toContain("open_in_editor")
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

  it("does not let an activated surface skill grant tools", async () => {
    const opts = await resolveSendOptions({ session: imSession() })
    expect(opts.allowedTools ?? []).not.toContain("surface_tool_x")
  })

  it("does not let a surface skill reopen a tool excluded by the final user filter", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        ...imSession(),
        toolFilter: { mode: "allow", tools: ["Read"] },
      }),
    })
    expect(opts.allowedTools).not.toContain("surface_tool_x")
  })
})

describe("resolveSendOptions — unified built-in Skill delivery", () => {
  it("offers a contextual chart catalog only when a deliverable artifact route exists", async () => {
    const available = await resolveSendOptions({
      session: makeSession({ id: "chart-session" }),
      skillIntents: ["chart"],
    })
    expect(available.appendSystemPrompt).toContain("## Contextual skills")
    expect(available.appendSystemPrompt).toContain("Chart Design")

    const unavailable = await resolveSendOptions({
      session: makeSession({ id: "chart-disabled" }),
      skillIntents: ["chart"],
      appSettings: { artifacts: { agentAuthoring: false, autoCreate: false } } as AppSettings,
    })
    expect(unavailable.appendSystemPrompt ?? "").not.toContain("Chart Design")
  })

  it("withholds the contextual catalog when the loader does not survive the clamp", async () => {
    // A catalog is an instruction to call `load_skill`. The workflow copilot
    // allowlist permits only `load_skill_resource`, so the finalizer strips the
    // loader and the listed ids would name a route that is not there.
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "clamped-session",
        toolFilter: { mode: "allow", tools: ["mcp__cognia-plugin-tools__load_skill_resource"] },
      }),
      skillRenderMode: "hybrid",
      skillIntents: ["chart"],
    })
    // The manifest entry is still a candidate. The allowlist is the clamp that
    // decides what the model can actually see.
    expect(opts.allowedTools ?? []).not.toContain("load_skill")
    expect(opts.allowedTools ?? []).not.toContain("mcp__cognia-plugin-tools__load_skill")
    expect(opts.appendSystemPrompt ?? "").not.toContain("## Contextual skills")
  })

  it("keeps a persisted user-disabled built-in out of injection", async () => {
    mListSkillsByIds.mockResolvedValue([
      {
        id: "skill_builtin_im_auto_reply",
        canonicalId: "builtin:im-auto-reply",
        name: "IM auto-reply etiquette",
        content: "disabled body",
        status: "disabled",
      } as Skill,
    ])
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "disabled-im",
        platformBinding: {
          adapterId: "tg-1",
          platform: "telegram",
          conversationKey: "c1",
          conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: 1 },
        },
      }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("IM auto-reply etiquette")
  })

  it("treats an onboarding card as a disabled-skill exception for one attempt", async () => {
    mListSkillsByIds.mockResolvedValue([
      {
        id: "skill_builtin_cognia_onboarding",
        canonicalId: "builtin:cognia-onboarding",
        name: "First-run walkthrough",
        content: "stored body",
        status: "disabled",
      } as Skill,
    ])
    const opts = await resolveSendOptions({
      session: makeSession({ id: "onboarding-session" }),
      skillRenderMode: "hybrid",
      skillIntents: ["onboarding.summarize-web"],
      requestScopedSkillIds: ["builtin:cognia-onboarding"],
      turnId: "turn-1",
      executionIdentity: { attemptId: "a1" },
    })
    expect(opts.appendSystemPrompt).toContain("## First-run walkthrough")
    expect(toolNames(opts)).toContain("load_skill")

    const runtime = await import("@/lib/skills/runtime-loader")
    try {
      await expect(
        runtime.loadSkillForSession(
          { sessionId: "onboarding-session", turnId: "turn-1", attemptId: "a1" },
          "cognia-onboarding"
        )
      ).resolves.toMatchObject({ ok: true })
    } finally {
      runtime.releaseSkillLoadContext("onboarding-session")
    }
  })
})

describe("resolveSendOptions — MCP subset", () => {
  it("unions selected servers' namespaced deny rules into disallowedTools", async () => {
    mListMcp.mockResolvedValue([
      {
        id: "live",
        name: "playwright-existing-browser",
        disallowedTools: ["browser_run_code_unsafe"],
      },
    ])
    mBuildMap.mockReturnValueOnce({
      "playwright-existing-browser": { command: "npx" },
    })
    const opts = await resolveSendOptions({})
    expect(opts.disallowedTools).toContain(
      "mcp__playwright-existing-browser__browser_run_code_unsafe"
    )
  })

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
    expect(opts.appendSystemPrompt).toContain("Plan mode (READ-ONLY")
    expect(opts.appendSystemPrompt).toContain("ExitPlanMode")
    // Guides the Claude-Code-style research flow via read-only subagents.
    expect(opts.appendSystemPrompt).toContain("Explore")
  })

  it("omits the plan-mode reminder outside plan mode", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "acceptEdits" }),
    })
    expect(opts.appendSystemPrompt ?? "").not.toContain("Plan mode (READ-ONLY")
  })

  it("appends the structured-steps snippet only when enhanced plan mode is on", async () => {
    const on = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "plan" }),
      appSettings: {
        id: "singleton",
        planSettings: { interactiveHtmlView: true },
      } as AppSettings,
    })
    expect(on.appendSystemPrompt).toContain("Plan mode (READ-ONLY")
    expect(on.appendSystemPrompt).toContain("## Steps")

    const off = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "plan" }),
      appSettings: { id: "singleton" } as AppSettings,
    })
    expect(off.appendSystemPrompt).toContain("Plan mode (READ-ONLY")
    expect(off.appendSystemPrompt ?? "").not.toContain("## Steps")

    // Outside plan mode the snippet never appears, even with the setting on.
    const notPlan = await resolveSendOptions({
      session: makeSession({ id: "s1", permissionMode: "acceptEdits" }),
      appSettings: {
        id: "singleton",
        planSettings: { interactiveHtmlView: true },
      } as AppSettings,
    })
    expect(notPlan.appendSystemPrompt ?? "").not.toContain("## Steps")
  })

  // The sidecar registers create_plan / update_plan by default, so the send
  // spec only ever carries the user's opt-OUT. A stray `planTools: true` would
  // be harmless but noisy; a missing `false` would silently ignore the setting.
  it("carries the plan-authoring opt-out and nothing else", async () => {
    const off = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      appSettings: {
        id: "singleton",
        planSettings: { agentAuthoring: false },
      } as AppSettings,
    })
    expect(off.planTools).toBe(false)

    for (const planSettings of [undefined, { agentAuthoring: true }]) {
      const on = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        appSettings: { id: "singleton", ...(planSettings ? { planSettings } : {}) } as AppSettings,
      })
      expect(on.planTools).toBeUndefined()
    }
  })
})

describe("resolveSendOptions — artifact authoring tools", () => {
  const toolNames = (opts: { pluginTools?: { name: string }[] }) =>
    (opts.pluginTools ?? []).map((t) => t.name)

  it("gives the agent the artifact and canvas tools by default", async () => {
    // Before these existed the declared `artifact_create` had a consumer on the
    // message-conversion side and no producer anywhere, so an artifact could
    // only be born from the heuristic fence detector.
    const opts = await resolveSendOptions({ session: makeSession({ id: "s1" }) })
    const names = toolNames(opts)
    expect(names).toEqual(expect.arrayContaining(["artifact_create", "artifact_update"]))
    expect(names).toEqual(expect.arrayContaining(["canvas_create", "canvas_open"]))
  })

  it("withholds them when the user turns agent authoring off", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      appSettings: { id: "singleton", artifacts: { agentAuthoring: false } } as AppSettings,
    })
    expect(toolNames(opts)).not.toContain("artifact_create")
  })

  it("withholds them on an IM-bound session, which has no dock", async () => {
    // The routing prompt withholds the option for the same reason; the two must
    // agree, or the model is told to make a chart with a tool it does not have.
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "lark", conversationKey: "c1" },
      }),
    })
    expect(toolNames(opts)).not.toContain("artifact_create")
    expect(opts.appendSystemPrompt ?? "").not.toContain("artifact_create")
  })

  it("keeps the routing prompt and the tool manifest in agreement", async () => {
    const opts = await resolveSendOptions({ session: makeSession({ id: "s1" }) })
    const prompt = opts.appendSystemPrompt ?? ""
    for (const tool of ["artifact_create", "artifact_update", "canvas_create"]) {
      if (prompt.includes(tool)) expect(toolNames(opts)).toContain(tool)
    }
  })

  it("bakes in the consent tier, asking only before a delete", async () => {
    const opts = (await resolveSendOptions({ session: makeSession({ id: "s1" }) })) as {
      permissionRuleset?: Record<string, unknown>
    }
    expect(opts.permissionRuleset?.artifact_create).toBe("allow")
    expect(opts.permissionRuleset?.artifact_delete).toBe("ask")
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

  it("flags droppedCapabilityWarning when effort is dropped for an unsupported model", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", effort: "high", model: "claude-haiku-4-5" }),
      appSettings: { id: "singleton", defaultProvider: "anthropic" } as AppSettings,
    })
    expect(opts.droppedCapabilityWarning).toEqual({
      capability: "effort",
      model: "claude-haiku-4-5",
      provider: "anthropic",
    })
  })

  it("keeps effort when the resolved model supports it (Opus 4.6)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", effort: "high", model: "claude-opus-4-6" }),
      appSettings: { id: "singleton", defaultProvider: "anthropic" } as AppSettings,
    })
    expect(opts.effort).toBe("high")
    expect(opts.droppedCapabilityWarning).toBeUndefined()
  })

  it("does not flag a warning when no effort was requested", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", model: "claude-haiku-4-5" }),
      appSettings: { id: "singleton", defaultProvider: "anthropic" } as AppSettings,
    })
    expect(opts.droppedCapabilityWarning).toBeUndefined()
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

  // The first-class web tools (web_search / web_fetch) and the artifact /
  // canvas authoring tools are appended to every manifest by default and are
  // orthogonal to Computer Use gating, so these assertions exclude them to stay
  // focused. Both have their own coverage elsewhere in this file.
  const ALWAYS_ON = new Set([
    "web_search",
    "web_fetch",
    "artifact_create",
    "artifact_update",
    "artifact_read",
    "artifact_delete",
    "canvas_create",
    "canvas_update",
    "canvas_read",
    "canvas_open",
  ])
  const notWeb = (n: string) => !ALWAYS_ON.has(n)

  it("includes computer-use plugin tools when character.enableComputerUse=true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true }),
    })
    const names = (opts.pluginTools ?? [])
      .map((t) => t.name)
      .filter(notWeb)
      .sort()
    expect(names).toEqual(["bash", "computer_use", "github_pr", "text_editor", "working_set"])
  })

  it("drops computer-use plugin tools on mobile until the master switch is on", async () => {
    // `AppSettings.mobileComputerUseEnabled` (Settings → Computer Use on the
    // phone) documented itself as a hard veto over per-character
    // `enableComputerUse`, but nothing read it — the switch was inert.
    mockHostProfile.value = "mobile-companion"
    try {
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        character: makeChar({ enableComputerUse: true }),
        appSettings: { id: "singleton" } as AppSettings,
      })
      const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
      expect(names).not.toContain("computer_use")
      expect(names).toContain("github_pr")
    } finally {
      mockHostProfile.value = "desktop"
    }
  })

  it("keeps them on mobile once the master switch is on", async () => {
    mockHostProfile.value = "mobile-companion"
    try {
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1" }),
        character: makeChar({ enableComputerUse: true }),
        appSettings: { id: "singleton", mobileComputerUseEnabled: true } as AppSettings,
      })
      const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
      expect(names).toContain("computer_use")
    } finally {
      mockHostProfile.value = "desktop"
    }
  })

  it("does not apply the mobile switch on the desktop host", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true }),
      appSettings: { id: "singleton", mobileComputerUseEnabled: false } as AppSettings,
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toContain("computer_use")
  })

  it("filters computer-use plugin tools when character.enableComputerUse !== true", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: false }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toEqual(["github_pr", "working_set"])
    expect(names).not.toContain("computer_use")
  })

  it("filters when character has no Computer Use flag at all", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toEqual(["github_pr", "working_set"])
  })

  const browserTool = {
    name: "browser_snapshot",
    description: "snapshot the preview",
    jsonSchema: {},
    pluginId: "cognia-browser-tools",
  }

  it("includes browser tools when character.enableBrowserTools=true", async () => {
    mBuildManifest.mockReturnValueOnce([browserTool, otherTool])
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableBrowserTools: true }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).toContain("browser_snapshot")
    expect(names).toContain("github_pr")
  })

  it("filters browser tools when character.enableBrowserTools !== true", async () => {
    mBuildManifest.mockReturnValueOnce([browserTool, otherTool])
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableBrowserTools: false }),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name).filter(notWeb)
    expect(names).not.toContain("browser_snapshot")
    expect(names).toContain("github_pr")
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
    expect(names).toEqual(["github_pr", "working_set"])
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
    expect(names).toEqual(["bash", "computer_use", "github_pr", "text_editor", "working_set"])
  })

  it("adapter host ceiling can still deny an opted-in Computer Use session", async () => {
    mReadOverride.mockResolvedValueOnce({ allowComputerUse: true })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "telegram", conversationKey: "tg:123" },
      } as ChatSession),
      character: makeChar({ enableComputerUse: true }),
      imAdapterRow: { id: "telegram", hostCapabilityCeiling: [] } as unknown as AdapterInstanceRow,
    })
    const names = (opts.pluginTools ?? []).map((tool) => tool.name)
    expect(names).not.toContain("computer_use")
    expect(names).not.toContain("bash")
  })

  it("withholds scheduler agent tools from IM sessions by default", async () => {
    mReadOverride.mockResolvedValueOnce(undefined)
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "telegram", conversationKey: "tg:123" },
      } as ChatSession),
      character: makeChar(),
    })
    expect(opts.allowedTools ?? []).not.toContain("mcp__cognia__schedule_task")
  })

  it("offers scheduler agent tools only after the conversation opts in", async () => {
    mReadOverride.mockResolvedValueOnce({ allowScheduleTools: true })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "telegram", conversationKey: "tg:123" },
      } as ChatSession),
      character: makeChar(),
    })
    expect(opts.allowedTools).toEqual(
      expect.arrayContaining([
        "mcp__cognia__schedule_task",
        "mcp__cognia__list_scheduled_tasks",
        "mcp__cognia__cancel_scheduled_task",
      ])
    )
  })

  it("adapter host ceiling denies scheduler tools even after conversation opt-in", async () => {
    mReadOverride.mockResolvedValueOnce({ allowScheduleTools: true })
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "telegram", conversationKey: "tg:123" },
      } as ChatSession),
      character: makeChar(),
      imAdapterRow: { id: "telegram", hostCapabilityCeiling: [] } as unknown as AdapterInstanceRow,
    })
    expect(opts.allowedTools ?? []).not.toContain("mcp__cognia__schedule_task")
  })

  it("adapter host ceiling can deny the otherwise low-risk OCR default", async () => {
    mBuildManifest.mockReturnValueOnce([
      {
        name: "ocr_extract",
        description: "extract text",
        jsonSchema: {},
        pluginId: "cognia-ocr",
      },
      otherTool,
    ])
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        platformBinding: { adapterId: "telegram", conversationKey: "tg:123" },
      } as ChatSession),
      character: makeChar(),
      imAdapterRow: { id: "telegram", hostCapabilityCeiling: [] } as unknown as AdapterInstanceRow,
    })
    expect((opts.pluginTools ?? []).map((tool) => tool.name)).not.toContain("ocr_extract")
  })

  it("disablePluginTools wipes plugin tools but the first-class web tools survive", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar({ enableComputerUse: true, disablePluginTools: true }),
      appSettings: COGNIA_WEB_SETTINGS,
    })
    // web_search / web_fetch and the artifact / canvas authoring tools are
    // first-class built-ins, ungated by the plugin toggle — that toggle is
    // about third-party plugin tools, and artifact authoring has its own switch
    // (`artifacts.agentAuthoring`). Every actual plugin tool is gone.
    expect((opts.pluginTools ?? []).map((t) => t.name)).toEqual([
      "web_search",
      "web_fetch",
      "artifact_create",
      "artifact_update",
      "artifact_read",
      "artifact_delete",
      "canvas_create",
      "canvas_update",
      "canvas_read",
      "canvas_open",
      "working_set",
    ])
  })

  // The default Anthropic turn now takes the SDK's own WebSearch/WebFetch, so
  // the host-routed pair is what a turn WITHOUT a native gets — see the
  // "web access resolution" block below for the full contract.
  it("appends the first-class web tools when the turn routes through Cognia", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: COGNIA_WEB_SETTINGS,
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name)
    expect(names).toContain("web_search")
    expect(names).toContain("web_fetch")
  })
})

describe("resolveSendOptions — the ultracode thinking tier", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sidecarBridge = require("@/lib/plugin/bridge/sidecar-tools-bridge")
  const mBuildManifest = sidecarBridge.buildPluginToolsManifest as jest.Mock

  const wfTool = (name: string) => ({
    name,
    description: `workflow tool ${name}`,
    jsonSchema: {},
    pluginId: "cognia-workflow-ai",
  })
  const unrelatedTool = {
    name: "github_pr",
    description: "open a PR",
    jsonSchema: {},
    pluginId: "cognia-github-delivery",
  }

  /** Tier as the composer persists it: the tier name plus the effort it maps to. */
  const ultracodeSession = () =>
    makeSession({ id: "s1", thinkingLevel: "ultracode", effort: "xhigh" })

  beforeEach(() => {
    mBuildManifest.mockReset().mockReturnValue([wfTool("wf_read_graph"), unrelatedTool])
  })

  it("still forwards xhigh effort — the tier maps down, it is not a new effort value", async () => {
    const opts = await resolveSendOptions({
      session: ultracodeSession(),
      character: makeChar({ model: "claude-opus-4-8" }),
    })
    expect(opts.effort).toBe("xhigh")
  })

  it("exposes the workflow tool suite", async () => {
    const opts = await resolveSendOptions({
      session: ultracodeSession(),
      character: makeChar(),
    })
    const names = (opts.pluginTools ?? []).map((t) => t.name)
    expect(names).toContain("wf_read_graph")
    expect(names).toContain("wf_run_workflow_typed")
  })

  it("adds the shared runner even when the workflow plugin contributes nothing", async () => {
    // The plugin is disabled, so its own registration is absent; the tier's
    // guarantee still holds through the `plugin-tool-ipc.ts` fallback executor.
    mBuildManifest.mockReturnValue([unrelatedTool])
    const opts = await resolveSendOptions({
      session: ultracodeSession(),
      character: makeChar(),
    })
    expect((opts.pluginTools ?? []).map((t) => t.name)).toContain("wf_run_workflow_typed")
  })

  it("never duplicates a workflow tool the manifest already carries", async () => {
    mBuildManifest.mockReturnValue([wfTool("wf_run_workflow_typed"), wfTool("wf_read_graph")])
    const opts = await resolveSendOptions({
      session: ultracodeSession(),
      character: makeChar(),
    })
    const runners = (opts.pluginTools ?? []).filter((t) => t.name === "wf_run_workflow_typed")
    expect(runners).toHaveLength(1)
  })

  it("leaves the manifest alone on every other tier", async () => {
    // `xhigh` persists the SAME effort as ultracode — only the tier differs, so
    // this is the assertion that proves the coupling keys on the tier.
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", thinkingLevel: "xhigh", effort: "xhigh" }),
      character: makeChar(),
    })
    expect((opts.pluginTools ?? []).map((t) => t.name)).not.toContain("wf_run_workflow_typed")
  })

  it("does not infer the tier from a legacy row that only carries xhigh effort", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", effort: "xhigh" }),
      character: makeChar(),
    })
    expect((opts.pluginTools ?? []).map((t) => t.name)).not.toContain("wf_run_workflow_typed")
  })

  it("stays subject to the character's disablePluginTools opt-out", async () => {
    // Picking the tier opts INTO tools; it does not override a character that
    // has plugin tools switched off entirely.
    const opts = await resolveSendOptions({
      session: ultracodeSession(),
      character: makeChar({ disablePluginTools: true }),
    })
    expect((opts.pluginTools ?? []).map((t) => t.name)).not.toContain("wf_run_workflow_typed")
  })
})

describe("resolveSendOptions — first-class web tools supersede the plugin", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sidecarBridge = require("@/lib/plugin/bridge/sidecar-tools-bridge")
  const mBuildManifest = sidecarBridge.buildPluginToolsManifest as jest.Mock

  beforeEach(() => {
    // Include legacy duplicate registrations to verify the defensive filter.
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
      {
        name: "deep_research",
        description: "deep",
        jsonSchema: {},
        pluginId: "cognia-deep-research",
      },
    ])
  })

  afterAll(() => mBuildManifest.mockReset().mockReturnValue([]))

  it("drops the plugin's duplicate web_search/web_fetch and keeps exactly one of each", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      character: makeChar(),
      appSettings: COGNIA_WEB_SETTINGS,
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
    expect(names).toContain("deep_research")
  })

  it("drops plugin search/fetch when the master switch is off but keeps exclusive tools", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s-disabled" }),
      character: makeChar({ providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: { webTools: { enabled: false } } as AppSettings,
    })
    const names = (opts.pluginTools ?? []).map((tool) => tool.name)
    expect(names).not.toContain("web_search")
    expect(names).not.toContain("web_fetch")
    expect(names).toContain("web_download")
    expect(names).toContain("web_research")
    expect(names).not.toContain("deep_research")
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
        enableComputerUse: true,
        sandboxEnabled: true,
        sandboxPolicy: {
          writableRoots: ["/workspace"],
          readableRoots: ["/vendor/include"],
          network: "allowlist",
          networkAllowlist: ["api.github.com"],
        },
      })
    )

    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
    })

    expect(opts.sandboxRuntimeRef).toBeDefined()
    await expect(
      sandboxSessionRuntime.decorateComputerUseContext(opts.sandboxRuntimeRef!, {})
    ).resolves.toMatchObject({
      sandboxConfine: {
        writable: ["/workspace"],
        readable: ["/vendor/include"],
        network: "allowlist",
        networkHosts: ["api.github.com"],
      },
    })
  })

  it("binds confinement for a remote GUI even when sandboxed shell tools are disabled", async () => {
    const bindSpy = jest
      .spyOn(sandboxSessionRuntime, "bindSession")
      .mockResolvedValueOnce("sandbox-runtime:remote-only")
    mGetCharacter.mockResolvedValue(
      makeChar({
        id: "c1",
        enableComputerUse: true,
        sandboxEnabled: false,
        computerUseTarget: { connectionId: "connection-1" },
        sandboxPolicy: { writableRoots: ["/workspace"], network: "off" },
      })
    )

    try {
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1" }),
      })

      expect(opts.sandboxRuntimeRef).toBe("sandbox-runtime:remote-only")
      expect(bindSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxEnabled: false,
          computerUseEnabled: true,
          confine: expect.objectContaining({ writable: ["/workspace"], network: "off" }),
        })
      )
    } finally {
      bindSpy.mockRestore()
    }
  })

  describe("a binding that cannot be established", () => {
    afterEach(() => {
      __resetSandboxSessionRuntimeForTesting()
    })

    it("keeps the resolved ceiling instead of dropping to the unpoliced host", async () => {
      const bindSpy = jest
        .spyOn(sandboxSessionRuntime, "bindSession")
        .mockRejectedValueOnce(new Error("no live E2B workspace"))
      mGetCharacter.mockResolvedValue(
        makeChar({
          id: "c1",
          sandboxEnabled: true,
          sandboxTier: "microvm",
          sandboxPolicy: { writableRoots: ["/workspace"], network: "off" },
        })
      )

      try {
        const opts = await resolveSendOptions({
          session: makeSession({ id: "s1", characterId: "c1" }),
        })

        // The send survives — but it does NOT survive by handing the tools an
        // unpoliced host placement.
        expect(opts.sandboxRuntimeRef).toBeDefined()
        expect(opts.sandboxRuntimeRef).not.toBe(HOST_FALLBACK_RUNTIME_REF)
        expect(() =>
          sandboxSessionRuntime.assertWritablePath(opts.sandboxRuntimeRef!, "/etc/passwd")
        ).toThrow(/outside the configured writable roots/)
        // And the microVM tier the user chose refuses rather than running here.
        await expect(
          sandboxSessionRuntime.executeSandbox(opts.sandboxRuntimeRef!, {
            tool: "sandbox_bash",
            command: { argv: ["id"], cwd: "/workspace", env: {}, stdin: null, timeout: 5 },
            request: {
              writable: [],
              readable: [],
              targetFiles: [],
              maxCpuSeconds: 0,
              maxMemoryMb: 0,
              network: "off",
              networkHosts: [],
            },
          })
        ).rejects.toMatchObject({ code: "placement-unavailable" })
      } finally {
        bindSpy.mockRestore()
      }
    })

    it("refuses a bound GUI target rather than retargeting the local desktop", async () => {
      const bindSpy = jest
        .spyOn(sandboxSessionRuntime, "bindSession")
        .mockRejectedValueOnce(new Error("connection is stopped"))
      mGetCharacter.mockResolvedValue(
        makeChar({
          id: "c1",
          enableComputerUse: true,
          sandboxEnabled: false,
          computerUseTarget: { connectionId: "connection-1" },
        })
      )

      try {
        const opts = await resolveSendOptions({
          session: makeSession({ id: "s1", characterId: "c1" }),
        })

        expect(opts.sandboxRuntimeRef).toBeDefined()
        await expect(
          sandboxSessionRuntime.decorateComputerUseContext(opts.sandboxRuntimeRef!, {})
        ).rejects.toMatchObject({ code: "placement-unavailable" })
      } finally {
        bindSpy.mockRestore()
      }
    })

    it("does not fail the send when releasing a disabled session's runtime throws", async () => {
      const releaseSpy = jest
        .spyOn(sandboxSessionRuntime, "releaseSession")
        .mockRejectedValueOnce(new Error("E2B close timed out"))
      mGetCharacter.mockResolvedValue(makeChar({ id: "c1", sandboxEnabled: false }))

      try {
        const opts = await resolveSendOptions({
          session: makeSession({ id: "s1", characterId: "c1" }),
        })
        expect(opts.sandboxRuntimeRef).toBeUndefined()
        expect(releaseSpy).toHaveBeenCalledWith("s1")
      } finally {
        releaseSpy.mockRestore()
      }
    })
  })
})

describe("resolveSendOptions — ADR-0028 lite workspace confinement", () => {
  it("defaults ON: stamps confinement.roots from cwd + additionalDirectories", async () => {
    const opts = await resolveSendOptions({
      activeProject: makeProject([{ path: "/ws", isPrimary: true }, { path: "/ws/extra" }]),
    })
    expect(opts.confinement?.enabled).toBe(true)
    expect(opts.confinement?.roots?.sort()).toEqual(["/ws", "/ws/extra"].sort())
  })

  it("does NOT confine when the heavy OS sandbox is enabled (mutually exclusive)", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", sandboxEnabled: true }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
      activeProject: makeProject([{ path: "/ws", isPrimary: true }]),
    })
    expect(opts.confinement).toBeUndefined()
  })

  it("session.workspaceConfinementEnabled = false opts the session out", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", workspaceConfinementEnabled: false }),
      activeProject: makeProject([{ path: "/ws", isPrimary: true }]),
    })
    expect(opts.confinement).toBeUndefined()
  })

  it("character override beats the app default", async () => {
    mGetCharacter.mockResolvedValue(makeChar({ id: "c1", workspaceConfinementEnabled: false }))
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
      activeProject: makeProject([{ path: "/ws", isPrimary: true }]),
      appSettings: { id: "singleton", workspaceConfinementEnabled: true } as AppSettings,
    })
    expect(opts.confinement).toBeUndefined()
  })

  it("carries no policy for a rootless session (no active project)", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
    })
    expect(opts.confinement).toBeUndefined()
  })
})

describe("resolveSendOptions — alwaysAllowTools passthrough", () => {
  it("copies (sorted) appSettings.alwaysAllowTools onto SendOptions", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      appSettings: {
        id: "singleton",
        alwaysAllowTools: ["Write", "Bash", "Read"],
      } as AppSettings,
    })
    expect(opts.alwaysAllowTools).toEqual(["Bash", "Read", "Write"])
  })

  it("omits the field when the list is empty", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1" }),
      appSettings: { id: "singleton", alwaysAllowTools: [] as string[] } as AppSettings,
    })
    expect(opts.alwaysAllowTools).toBeUndefined()
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
    expect(new Set(opts.allowedTools)).toEqual(new Set(["a"]))
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
        expect(opts.appendSystemPrompt).toContain("PATCHED")
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

    it("a dontAsk parent ceiling clamps the child's mode (dontAsk is a valid SendOptions mode)", async () => {
      // Regression: the final clamp used to guard `!== "dontAsk"` out as
      // "type-unsafe", silently dropping a dontAsk parent's ceiling.
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1", permissionMode: "acceptEdits" }),
        permissionCeiling: { permissionMode: "dontAsk" },
      })
      expect(opts.permissionMode).toBe("dontAsk")
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

describe("web access resolution (lib/chat/web-access.ts)", () => {
  const webNames = (opts: Awaited<ReturnType<typeof resolveSendOptions>>): string[] =>
    (opts.pluginTools ?? []).map((t) => t.name)

  // Native-first. The SDK already exposes WebSearch/WebFetch on an unnarrowed
  // turn, so taking that path means appending NOTHING — not the host-routed
  // pair (which would shadow it) and not the two names into `allowedTools`
  // (which would convert "no filtering" into "these two only").
  it("takes the runtime's own web tools on a default Anthropic turn", async () => {
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(webNames(opts)).not.toContain("web_search")
    expect(webNames(opts)).not.toContain("web_fetch")
    expect(opts.allowedTools ?? []).not.toContain("WebSearch")
  })

  // The bug this replaced: a subscriber with no search key was handed a
  // `web_search` that could only throw "no providers enabled".
  it("withholds web_search — but not web_fetch — when nothing can serve a search", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
    })
    expect(webNames(opts)).not.toContain("web_search")
    expect(webNames(opts)).toContain("web_fetch")
  })

  it("routes a non-Anthropic turn through Cognia once a provider is configured", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: {
        searchProviders: {
          tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
        },
      } as unknown as AppSettings,
    })
    expect(webNames(opts)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
    expect(opts.allowedTools ?? []).not.toContain("WebSearch")
  })

  // A narrowed surface governs the natives but not the host-routed pair, so
  // reaching for the natives there would either widen the list behind the
  // user's back (escaping the tool filter applied further up) or leave the turn
  // with no web at all. Those turns take Cognia's route instead.
  it("keeps a narrowed turn on the host-routed tools instead of widening its allow-list", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", allowedTools: ["Read"] }),
      appSettings: {
        searchProviders: {
          tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
        },
      } as unknown as AppSettings,
    })
    expect(opts.allowedTools).toEqual(["Read"])
    expect(webNames(opts)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
  })

  it("prefers Cognia over a native when the user asked for it", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: COGNIA_WEB_SETTINGS,
    })
    expect(webNames(opts)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
  })

  it("surfaces no web tools at all when the capability is off", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "openai", model: "gpt-4o-mini" }),
      appSettings: { webTools: { enabled: false } } as AppSettings,
    })
    expect(webNames(opts)).not.toContain("web_search")
    expect(webNames(opts)).not.toContain("web_fetch")
  })

  it("denies ambient Anthropic native web tools when the capability is off", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", providerId: "anthropic" }),
      appSettings: { webTools: { enabled: false } } as AppSettings,
    })
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]))
    expect(webNames(opts)).not.toContain("web_search")
    expect(webNames(opts)).not.toContain("web_fetch")
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
      appSettings: {
        webTools: { enabled: true, nativeOnAnthropic: true },
        searchProviders: {
          tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
        },
      } as unknown as AppSettings,
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

  it("keeps the custom tools in standalone mode even on Anthropic", async () => {
    // `allowedTools` is forwarded to `query()` by the Agent SDK path only. A
    // standalone (BYOK) turn goes straight to the provider API through the AI
    // SDK, which reads no such field — so taking the native branch there does
    // not swap the web tools, it deletes them, and the phone loses the
    // search/fetch loop entirely.
    const standalone = standaloneMode.isStandaloneChatMode as jest.MockedFunction<
      typeof standaloneMode.isStandaloneChatMode
    >
    standalone.mockReturnValue(true)
    try {
      const opts = await resolveSendOptions({
        character: makeChar({ id: "c1" }),
        appSettings: {
          webTools: { enabled: true, nativeOnAnthropic: true },
          searchProviders: {
            tavily: { providerId: "tavily", enabled: true, apiKey: "tvly-0123456789abcdef" },
          },
        } as unknown as AppSettings,
      })
      expect(webNames(opts)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]))
      expect(opts.allowedTools ?? []).not.toContain("WebSearch")
    } finally {
      standalone.mockReturnValue(false)
    }
  })
})

describe("agent self-invocation tools (Skill / SlashCommand / spawn_task / session messaging)", () => {
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

  it("appends the template and squad tools only when selfInvokeTools.templates is on", async () => {
    const off = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { skill: true } } as AppSettings,
    })
    expect(toolNames(off)).not.toContain("template_list")
    expect(toolNames(off)).not.toContain("squad_apply_template")
    expect(off.permissionRuleset?.template_instantiate).toBeUndefined()

    const on = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { templates: true } } as AppSettings,
    })
    for (const name of [
      "template_list",
      "template_get",
      "template_instantiate",
      "chat_template_list",
      "chat_template_get",
      "squad_list",
      "squad_apply_template",
      "squad_save_as_template",
    ]) {
      expect(toolNames(on)).toContain(name)
      expect(on.permissionRuleset?.[name]).toBe("allow")
    }
  })

  it("withholds the template and squad tools from an IM-bound session", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({
        id: "s1",
        characterId: "c1",
        platformBinding: { adapterId: "telegram" } as never,
      }),
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { templates: true } } as AppSettings,
    })
    expect(toolNames(opts)).not.toContain("template_list")
    expect(opts.permissionRuleset?.template_list).toBeUndefined()
  })

  it("appends spawn_task only when opted in and not on native mobile", async () => {
    const opts = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { spawnTask: true } } as AppSettings,
    })
    expect(toolNames(opts)).toContain("spawn_task")

    // `mockReturnValueOnce` is wrong here now: more than one gate asks whether
    // this is native mobile in a single resolve, so the "once" is consumed by
    // whichever runs first and the rest see `false`.
    const mobile = isNativeMobile as jest.Mock
    mobile.mockReturnValue(true)
    try {
      const mobileOpts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1" }),
        character: makeChar({ id: "c1" }),
        appSettings: { selfInvokeTools: { spawnTask: true } } as AppSettings,
      })
      expect(toolNames(mobileOpts)).not.toContain("spawn_task")
      // Canvas has no editor guild on the mobile shell, so its tools are
      // withheld too — but the mobile shell DOES mount an artifact dock, so the
      // artifact tools stay.
      expect(toolNames(mobileOpts)).not.toContain("canvas_open")
      expect(toolNames(mobileOpts)).toContain("artifact_create")
    } finally {
      mobile.mockReturnValue(false)
    }
  })

  it("appends independent-session discovery and messaging only when opted in", async () => {
    const disabled = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
      character: makeChar({ id: "c1" }),
    })
    expect(toolNames(disabled)).not.toContain("list_sessions")
    expect(toolNames(disabled)).not.toContain("send_session_message")

    const enabled = await resolveSendOptions({
      session: makeSession({ id: "s1", characterId: "c1" }),
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { sessionMessaging: true } } as AppSettings,
    })
    expect(toolNames(enabled)).toEqual(
      expect.arrayContaining(["list_sessions", "send_session_message"])
    )
  })

  describe("project-scoped vector memory", () => {
    const VECTOR_TOOLS = ["vector_search", "vector_add_document", "vector_delete_document"]
    const isTauriMock = isTauri as jest.Mock

    afterEach(() => {
      isTauriMock.mockReturnValue(false)
    })

    it("does not surface the vector tools by default (opt-in)", async () => {
      isTauriMock.mockReturnValue(true)
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1", projectId: "p1" }),
        character: makeChar({ id: "c1" }),
      })
      for (const tool of VECTOR_TOOLS) expect(toolNames(opts)).not.toContain(tool)
    })

    it("appends all three tools on desktop with a linked project", async () => {
      isTauriMock.mockReturnValue(true)
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1", projectId: "p1" }),
        character: makeChar({ id: "c1" }),
        appSettings: { selfInvokeTools: { vector: true } } as AppSettings,
      })
      for (const tool of VECTOR_TOOLS) expect(toolNames(opts)).toContain(tool)
    })

    it("does NOT append them off the desktop shell — they cannot run there", async () => {
      isTauriMock.mockReturnValue(false)
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1", projectId: "p1" }),
        character: makeChar({ id: "c1" }),
        appSettings: { selfInvokeTools: { vector: true } } as AppSettings,
      })
      for (const tool of VECTOR_TOOLS) expect(toolNames(opts)).not.toContain(tool)
    })

    it("does NOT append them without a linked project — collections would be unscoped", async () => {
      isTauriMock.mockReturnValue(true)
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1" }),
        character: makeChar({ id: "c1" }),
        appSettings: { selfInvokeTools: { vector: true } } as AppSettings,
      })
      for (const tool of VECTOR_TOOLS) expect(toolNames(opts)).not.toContain(tool)
    })

    it("falls back to the active project when the session has none", async () => {
      isTauriMock.mockReturnValue(true)
      const opts = await resolveSendOptions({
        session: makeSession({ id: "s1", characterId: "c1" }),
        character: makeChar({ id: "c1" }),
        appSettings: { selfInvokeTools: { vector: true } } as AppSettings,
        activeProject: makeProject([{ path: "/tmp/p" }]),
      })
      for (const tool of VECTOR_TOOLS) expect(toolNames(opts)).toContain(tool)
    })
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

describe("plugin conversion skill tools", () => {
  beforeEach(() => {
    _resetImPromptMemosForTest()
  })

  it("surfaces inspect/apply when the prompt skill is active in a desktop workspace", async () => {
    mListSkills.mockResolvedValueOnce([
      {
        id: "skill_builtin_plugin_conversion",
        canonicalId: "builtin:plugin-conversion",
        name: "Plugin conversion",
        content: "Inspect before applying.",
      } as unknown as Skill,
    ])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", disablePluginTools: true }),
      activeProject: makeProject([{ path: "/work/project", isPrimary: true }]),
      ephemeralSkillIds: ["skill_builtin_plugin_conversion"],
    })

    expect(toolNames(opts)).toEqual(
      expect.arrayContaining(["inspect_plugin_conversion", "apply_plugin_conversion"])
    )
  })

  it("does not surface conversion tools when the skill is inactive", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      activeProject: makeProject([{ path: "/work/project", isPrimary: true }]),
    })

    expect(toolNames(opts)).not.toContain("inspect_plugin_conversion")
    expect(toolNames(opts)).not.toContain("apply_plugin_conversion")
  })

  it("preloads conversion tools when Skill self-invocation can load the prompt skill", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      activeProject: makeProject([{ path: "/work/project", isPrimary: true }]),
      appSettings: { selfInvokeTools: { skill: true } } as AppSettings,
    })

    expect(toolNames(opts)).toEqual(
      expect.arrayContaining(["Skill", "inspect_plugin_conversion", "apply_plugin_conversion"])
    )
  })

  it("never surfaces conversion tools in an IM-bound session", async () => {
    mListSkills.mockResolvedValueOnce([
      {
        id: "skill_builtin_plugin_conversion",
        canonicalId: "builtin:plugin-conversion",
        name: "Plugin conversion",
        content: "Inspect before applying.",
      } as unknown as Skill,
    ])
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      session: makeSession({
        id: "s1",
        platformBinding: {
          adapterId: "adapter-1",
          platform: "lark",
          conversationKey: "lark:adapter-1:chat-1",
          conversationRef: { platform: "lark", adapterId: "adapter-1", channelId: "chat-1" },
        },
      }),
      activeProject: makeProject([{ path: "/work/project", isPrimary: true }]),
      ephemeralSkillIds: ["skill_builtin_plugin_conversion"],
    })

    expect(toolNames(opts)).not.toContain("inspect_plugin_conversion")
    expect(toolNames(opts)).not.toContain("apply_plugin_conversion")
  })
})

describe("anthropic-managed (container) skills", () => {
  it("appends twin_knowledge_search when the dispatching teammate is twin-bound", async () => {
    // A twin-bound teammate is a sufficient signal — teamHasKnowledgeTwins
    // short-circuits on character.twinId without needing a dispatch context.
    const teamSession = makeSession({ id: "s1", characterId: "c1", kind: "team" })
    const opts = await resolveSendOptions({
      session: teamSession,
      character: makeChar({ id: "c1", twinId: "twX" }),
      appSettings: { selfInvokeTools: { teamCollaboration: true } } as AppSettings,
    })
    expect(toolNames(opts)).toContain("twin_knowledge_search")
  })

  it("omits twin_knowledge_search when the team exposes no knowledge twins", async () => {
    // No character twinId and no resolvable team dispatch context → false leg.
    const teamSession = makeSession({ id: "s1", characterId: "c1", kind: "team" })
    const opts = await resolveSendOptions({
      session: teamSession,
      character: makeChar({ id: "c1" }),
      appSettings: { selfInvokeTools: { teamCollaboration: true } } as AppSettings,
    })
    expect(toolNames(opts)).toContain("team_send_message")
    expect(toolNames(opts)).not.toContain("twin_knowledge_search")
  })
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

  it("enables on an interactive CLI send (interactive flag set despite preloadedEnv/Mcp)", async () => {
    // The CLI TUI injects preloadedEnv/preloadedMcpServers but IS a live turn —
    // it must get partials so the deltas keep feeding the idle watchdog through
    // a long single generation (large file write).
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      preloadedEnv: null,
      preloadedMcpServers: [],
      interactive: true,
    })
    expect(opts.includePartialMessages).toBe(true)
  })

  it("interactive flag still defers to streamPartialMessages = false", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      preloadedEnv: null,
      preloadedMcpServers: [],
      interactive: true,
      appSettings: { streamPartialMessages: false } as AppSettings,
    })
    expect(opts.includePartialMessages).toBeUndefined()
  })

  it("interactive flag does NOT override a connector send (conversationKey still wins)", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      conversationKey: "telegram:123",
      interactive: true,
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
    expect(opts.traceparent).toBe(`00-${opts.traceId}-${opts.spanId}-01`)
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
    expect(opts.traceparent).toBe(`00-${parentTrace.traceId}-${parentTrace.rootSpanId}-01`)
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

  it("enables forwardSubagentText for a direct chat session (gap8 — detailed-gated render)", async () => {
    const direct = await resolveSendOptions({
      session: makeSession({ id: "s-direct", kind: "direct" }),
      character: makeChar({ id: "c1" }),
    })
    expect(direct.forwardSubagentText).toBe(true)
  })
})

describe("resolveSendOptions — IM prompt-fragment memos", () => {
  const imAdapterRow = {
    id: "tg-cap",
    updatedAt: 999,
    lastKnownCapabilities: { button: "native" },
  } as unknown as AdapterInstanceRow

  const capSession = () =>
    makeSession({
      id: "s-cap",
      platformBinding: {
        adapterId: "tg-cap",
        platform: "telegram",
        conversationKey: "c-cap",
        conversationRef: { platform: "telegram", adapterId: "tg-cap", chatId: 7 },
      },
    })

  it("builds then reuses the capability prompt across turns (memo miss + hit)", async () => {
    _resetImPromptMemosForTest()
    // First turn → cache miss → builds the prompt from the threaded adapter row.
    const first = await resolveSendOptions({ session: capSession(), imAdapterRow })
    expect(first.appendSystemPrompt).toContain("delivered via telegram")
    // Second turn (same id+updatedAt+platform) → cache hit → identical prompt.
    const second = await resolveSendOptions({ session: capSession(), imAdapterRow })
    expect(second.appendSystemPrompt).toBe(first.appendSystemPrompt)
  })

  it("reuses the built-in skills manifest across turns for the same IM channel", async () => {
    _resetImPromptMemosForTest()
    const first = await resolveSendOptions({ session: capSession(), imAdapterRow })
    const second = await resolveSendOptions({ session: capSession(), imAdapterRow })
    // The lark.* tool allowlist is identical across turns (manifest memo hit).
    expect(second.allowedTools).toEqual(first.allowedTools)
  })
})

describe("resolveSendOptions — project knowledge base (project-scoped RAG)", () => {
  function projectWithKb(overrides: Partial<Project> = {}): Project {
    return {
      id: "ws1",
      name: "WS",
      roots: [],
      knowledgeBase: [
        {
          id: "f1",
          name: "guide.md",
          type: "text",
          content: "x",
          size: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
      ...overrides,
    } as Project
  }

  const deps = { store: {}, embedding: {} } as never

  it("appends a project-knowledge section after the base prompt (does not replace it)", async () => {
    mApplyProjectKnowledge.mockResolvedValue({
      systemPromptSection: "## Project knowledge base\nchunk text",
      retrievedChunks: [{ fileId: "f1", fileName: "guide.md", content: "chunk text", score: 0.9 }],
      degraded: false,
    })
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", systemPrompt: "base prompt" }),
      appSettings: { cacheOptimizationEnabled: false } as never,
      activeProject: projectWithKb(),
      projectKnowledgeDeps: deps,
      projectKnowledgeUserMessage: "hello",
    })
    expect(opts.systemPrompt).toContain("base prompt")
    expect(opts.systemPrompt).toContain("## Project knowledge base")
    expect(opts.systemPrompt!.indexOf("base prompt")).toBeLessThan(
      opts.systemPrompt!.indexOf("## Project knowledge base")
    )
    expect(opts.projectKnowledgeContext?.retrievedChunks).toHaveLength(1)
    expect(opts.projectKnowledgeContext?.degraded).toBe(false)
  })

  it("skips when the workspace has no knowledge files", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1", systemPrompt: "base prompt" }),
      appSettings: { cacheOptimizationEnabled: false } as never,
      activeProject: projectWithKb({ knowledgeBase: [] }),
      projectKnowledgeDeps: deps,
      projectKnowledgeUserMessage: "hello",
    })
    expect(mApplyProjectKnowledge).not.toHaveBeenCalled()
    expect(opts.systemPrompt).not.toContain("## Project knowledge base")
  })

  it("skips when project RAG is disabled for the workspace", async () => {
    await resolveSendOptions({
      character: makeChar({ id: "c1", systemPrompt: "base prompt" }),
      appSettings: { cacheOptimizationEnabled: false } as never,
      activeProject: projectWithKb({ knowledgeSettings: { enableProjectRag: false } }),
      projectKnowledgeDeps: deps,
      projectKnowledgeUserMessage: "hello",
    })
    expect(mApplyProjectKnowledge).not.toHaveBeenCalled()
  })

  it("skips when no project-knowledge deps are supplied", async () => {
    await resolveSendOptions({
      character: makeChar({ id: "c1", systemPrompt: "base prompt" }),
      appSettings: { cacheOptimizationEnabled: false } as never,
      activeProject: projectWithKb(),
      projectKnowledgeUserMessage: "hello",
    })
    expect(mApplyProjectKnowledge).not.toHaveBeenCalled()
  })
})

describe("resolveSendOptions — reusable Agent Knowledge Bases", () => {
  const deps = {
    store: {},
    embedding: {},
    vectorBackend: "native",
  } as never

  it("appends bound-library context and preserves citation metadata", async () => {
    mApplyAgentKnowledge.mockResolvedValue({
      systemPromptSection: "## Agent knowledge bases\nanswer context",
      retrievedChunks: [
        {
          chunk: {
            id: "chunk-1",
            knowledgeBaseId: "kb-1",
            sourceId: "source-1",
            content: "answer context",
            vectorDocId: "vector-1",
          },
          score: 0.9,
        },
      ],
      citations: [
        {
          scope: "agent-knowledge-base",
          knowledgeBaseId: "kb-1",
          knowledgeBaseName: "Product",
          sourceId: "source-1",
          sourceTitle: "Guide",
          chunkId: "chunk-1",
          charStart: 0,
          charEnd: 14,
          score: 0.9,
        },
      ],
      failures: [],
      degraded: false,
      budget: { limit: 2000, used: 4, truncated: false },
    })

    const opts = await resolveSendOptions({
      character: makeChar({
        id: "agent-1",
        systemPrompt: "base prompt",
        knowledgeBaseIds: ["kb-1", "kb-2"],
      }),
      appSettings: { cacheOptimizationEnabled: false } as never,
      projectKnowledgeDeps: deps,
      projectKnowledgeUserMessage: "question",
    })

    expect(opts.systemPrompt).toContain("base prompt")
    expect(opts.systemPrompt).toContain("## Agent knowledge bases")
    expect(mApplyAgentKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseIds: ["kb-1", "kb-2"], tokenBudget: 2000 })
    )
    expect(opts.agentKnowledgeContext?.citations[0]).toEqual(
      expect.objectContaining({ knowledgeBaseId: "kb-1", sourceId: "source-1" })
    )
  })

  it("skips unbound Agents", async () => {
    await resolveSendOptions({
      character: makeChar({ knowledgeBaseIds: [] }),
      projectKnowledgeDeps: deps,
      projectKnowledgeUserMessage: "question",
    })
    expect(mApplyAgentKnowledge).not.toHaveBeenCalled()
  })
})

describe("resolveSendOptions — ADR-0090 execution spec stamping", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS
    delete process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1
  })

  it("stamps the resolved execution spec with no flag set at all", async () => {
    // ADR-0090 retirement: stamping is unconditional. It used to require the
    // resolver flag, which meant a default install never carried an `execution`
    // spec and the sidecar always took the legacy provider branch.
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.execution).toBeTruthy()
  })

  it("still stamps when the route-tickets flag is on, so the switch issues tickets", async () => {
    // The Settings → Gateway → Route tickets switch writes only this flag, and
    // it is the only thing that makes a `gateway` route eligible at all.
    process.env.NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS = "1"
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    expect(opts.execution).toBeTruthy()
  })

  it("applies Claude SDK rollout options to a direct send without a gateway ticket", async () => {
    process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1 = "1"
    const opts = await resolveSendOptions({ character: makeChar({ id: "c1" }) })

    expect(opts.execution?.route.kind).toBe("direct")
    expect(opts.claudeAgentSdk).toEqual({ version: 1 })
  })

  it("stamps the frozen, secret-free execution spec when the flag is on (legacy fields intact)", async () => {
    const onResolvedExecutionSpec = jest.fn()
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      onResolvedExecutionSpec,
    })

    const execution = opts.execution as unknown as Record<string, unknown>
    expect(execution).toBeTruthy()
    // Tracked symbolically: the wire spec must advance with the contract, and
    // hardcoding a literal here is what let the two drift apart silently.
    expect(execution.specVersion).toBe(RESOLVED_SPEC_VERSION)
    expect(execution.executionKind).toBe("agent")
    expect(execution.runtimeAdapter).toBe("claude-agent-sdk")
    expect((execution.route as { kind: string }).kind).toBe("direct")
    expect(execution.executionFingerprint).toEqual(expect.any(String))
    expect(onResolvedExecutionSpec).toHaveBeenCalledTimes(1)
    expect(onResolvedExecutionSpec.mock.calls[0][0]).toMatchObject({
      executionFingerprint: execution.executionFingerprint,
      runtimeAdapter: execution.runtimeAdapter,
      capabilities: execution.capabilities,
    })

    // v2 carries per-capability verdicts across the wire so the sidecar can
    // fail closed on its own rather than trusting `effective` alone.
    const capabilities = execution.capabilities as {
      effective: string[]
      support?: Record<string, { support: string }>
    }
    expect(capabilities.support).toBeDefined()
    for (const id of capabilities.effective) {
      expect(capabilities.support?.[id]?.support).toBe("native")
    }

    // Legacy routing fields survive for rollback; no secret shapes in the spec.
    expect(opts.provider).toBeDefined()
    expect(JSON.stringify(execution)).not.toMatch(/sk-|api[_-]?key|bearer|token/i)
  })

  // A turn dispatched to Codex used to be described as a sidecar runtime,
  // because chat never told the resolver which lane it was on. The trace and
  // the fingerprint both named a runtime that was not running.
  it("names the external lane on the frozen spec when the turn runs on one", async () => {
    const onResolvedExecutionSpec = jest.fn()
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      externalRuntimeId: "codex-1",
      onResolvedExecutionSpec,
    })

    const execution = opts.execution as unknown as Record<string, unknown>
    expect(execution.runtimeAdapter).toBe("external")
    expect(onResolvedExecutionSpec.mock.calls[0][0].runtimeAdapter).toBe("external")
  })

  // The fingerprint is the turn's execution identity, so two turns that run on
  // different runtimes must not share one.
  it("gives an external turn a different execution fingerprint", async () => {
    const builtin = await resolveSendOptions({ character: makeChar({ id: "c1" }) })
    const external = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      externalRuntimeId: "codex-1",
    })
    const fingerprint = (o: typeof builtin) =>
      (o.execution as unknown as { executionFingerprint: string }).executionFingerprint
    expect(fingerprint(builtin)).not.toBe(fingerprint(external))
  })

  it("uses the durable caller's final run identity before fingerprinting", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      executionIdentity: { runId: "execution:agent:session:message", attemptId: "recovery-2" },
    })

    expect(opts.execution?.identity).toEqual({
      runId: "execution:agent:session:message",
      attemptId: "recovery-2",
    })
  })
})

describe("resolveSendOptions — Agent profile routing and execution policy", () => {
  it("uses execute by default and selects plan only when the caller requests it", async () => {
    const character = makeChar({
      model: "legacy-execute",
      modelRouting: {
        plan: "planner-alias",
        execute: "executor-alias",
        utility: "fast-alias",
      },
    })

    const execute = await resolveSendOptions({ character })
    const plan = await resolveSendOptions({ character, modelRole: "plan" })

    expect(execute.model).toBe("executor-alias")
    expect(plan.model).toBe("planner-alias")
  })

  it("keeps an explicit session model above the Agent semantic target", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ modelRouting: { execute: "agent-model" } }),
      session: makeSession({ model: "session-model" }),
    })

    expect(opts.model).toBe("session-model")
  })

  it("applies session execution overrides and materializes keyring secrets only into env", async () => {
    mockGetAgentEnvSecret.mockResolvedValue("secret-value")
    const opts = await resolveSendOptions({
      character: makeChar({
        executionPolicy: {
          effort: "medium",
          maxTurns: 20,
          envBindings: [
            { name: "SHARED", kind: "plain", value: "agent" },
            { name: "TOKEN", kind: "secret", secretRef: "agent-1:TOKEN" },
          ],
        },
      }),
      session: makeSession({
        executionPolicy: {
          effort: "high",
          maxTurns: 8,
          envBindings: [{ name: "SHARED", kind: "plain", value: "session" }],
        },
      }),
    })

    expect(opts).toEqual(
      expect.objectContaining({
        effort: "high",
        maxTurns: 8,
        env: { SHARED: "session", TOKEN: "secret-value" },
      })
    )
    expect(mockGetAgentEnvSecret).toHaveBeenCalledWith("agent-1:TOKEN")
  })

  it("fails before dispatch when a referenced secret is missing", async () => {
    mockGetAgentEnvSecret.mockResolvedValue(null)

    await expect(
      resolveSendOptions({
        character: makeChar({
          executionPolicy: {
            envBindings: [
              { name: "MISSING_TOKEN", kind: "secret", secretRef: "agent-1:MISSING_TOKEN" },
            ],
          },
        }),
      })
    ).rejects.toMatchObject({
      code: "secret_missing",
      variableName: "MISSING_TOKEN",
    })
  })
})

describe("resolveSendOptions — a model that belongs to an external agent", () => {
  const agentSession = () =>
    makeSession({
      id: "ses_ext",
      model: "openai/agent-gpt",
      providerOverride: externalAgentProviderId("pi-1"),
    })

  it("replays the agent's model on the lane that agent runs", async () => {
    // The row exists so `applyModelToSession` re-requests the choice on every
    // session the agent opens. On its own lane it is the answer.
    const opts = await resolveSendOptions({
      character: makeChar(),
      session: agentSession(),
      externalRuntimeId: "pi-1",
    })
    expect(opts.model).toBe("openai/agent-gpt")
  })

  it("keeps it off the built-in lane, which has no provider that offers it", async () => {
    // Switching the runtime chip back to Cognia Agent used to leave the
    // conversation pinned to the agent's id, and the turn dispatched at a
    // model no configured provider lists.
    const opts = await resolveSendOptions({
      character: makeChar({ model: "char-model", providerId: "anthropic" }),
      session: agentSession(),
    })
    expect(opts.model).not.toBe("openai/agent-gpt")
  })

  it("does not replay one external agent's model to another", async () => {
    const opts = await resolveSendOptions({
      character: makeChar({ model: "char-model", providerId: "anthropic" }),
      session: agentSession(),
      externalRuntimeId: "codex-1",
    })
    expect(opts.model).not.toBe("openai/agent-gpt")
  })

  it("never hands the reserved marker downstream as a provider", async () => {
    // It names a group in a picker, not a provider anything could route at.
    for (const externalRuntimeId of [undefined, "pi-1"]) {
      const opts = await resolveSendOptions({
        character: makeChar({ model: "char-model", providerId: "anthropic" }),
        session: agentSession(),
        externalRuntimeId,
      })
      expect(opts.provider).not.toBe(EXTERNAL_AGENT_PROVIDER_ID)
    }
  })

  it("leaves an ordinary session override exactly as it was", async () => {
    const opts = await resolveSendOptions({
      character: makeChar(),
      session: makeSession({ id: "s_plain", model: "gpt-4o-mini", providerOverride: "openai" }),
    })
    expect(opts.model).toBe("gpt-4o-mini")
  })
})
