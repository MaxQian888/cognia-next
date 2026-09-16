// Router + Fusion at the send-option builder (ADR-0188 D36–D38): the off path
// is unchanged and loads nothing, the on path stamps a ledgered run, and an
// infrastructure fault falls back to the original path with a notice. The
// module mocks below are the same pure-function harness build-options.test.ts
// uses, so resolveSendOptions runs without Dexie, Zustand or Tauri.
// Mock every database / store / agent-mode dependency so build-options can be
// exercised as a pure function. We never want to touch Dexie or Zustand here.

// Paired by default — the standalone (BYOK) branch is opted into per-test.
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: jest.fn(() => false),
  getMobileRuntimeMode: jest.fn(() => undefined),
  setMobileRuntimeMode: jest.fn(),
}))

const mockPrepareSdkGatewayRoute = jest.fn()
jest.mock("@/lib/gateway/mint-session-ticket", () => ({
  mintSessionRouteTicket: jest.fn().mockResolvedValue(undefined),
  prepareExternalAgentGatewayRoute: (...args: unknown[]) => mockPrepareSdkGatewayRoute(...args),
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
      setProviderConfig: (...args: Parameters<typeof mockSetProviderConfig>) =>
        mockSetProviderConfig(...args),
      updateCustomProvider: (...args: Parameters<typeof mockUpdateCustomProvider>) =>
        mockUpdateCustomProvider(...args),
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
  // The external lane's best-effort wrapper. Delegates to the same mock so a
  // test that stubs `resolveAccountEnv` still describes both lanes, while an
  // account resolution that REJECTS resolves empty here — which is the whole
  // point of the wrapper and what the external-runtime cases below rely on.
  resolveAccountEnvForExternalRuntime: jest.fn(
    async (providerId: string, accountId: string | null) => {
      const { resolveAccountEnv } = jest.requireMock("@/lib/claude/env-resolver") as {
        resolveAccountEnv: jest.Mock
      }
      try {
        return (await resolveAccountEnv(providerId, accountId)) ?? {}
      } catch {
        return {}
      }
    }
  ),
}))

const mockGetAgentEnvSecret = jest.fn()
jest.mock("@/lib/agent/agent-env-keyring", () => ({
  loadAgentEnvSecret: (...args: Parameters<typeof mockGetAgentEnvSecret>) =>
    mockGetAgentEnvSecret(...args),
}))

// Twin runtime is dynamically imported by resolveSendOptions; the mock only
// kicks in when a test supplies twinId + twinDeps + twinUserMessage.
const mApplyTwinContext = jest.fn()
const mResolveOpencodeVaultCredential = jest.fn()
jest.mock("@/lib/subscription/opencode/chat-bridge", () => ({
  resolveOpencodeVaultCredential: (...a: Parameters<typeof mResolveOpencodeVaultCredential>) =>
    mResolveOpencodeVaultCredential(...a),
}))
const mResolveCodexVaultCredential = jest.fn()
const mResolveManagedSubscriptionCredential = jest.fn()
jest.mock("@/lib/subscription/core/managed-key-credential", () => ({
  resolveManagedSubscriptionCredential: (...args: unknown[]) =>
    mResolveManagedSubscriptionCredential(...args),
}))
const mResolveCommandcodeVaultCredential = jest.fn()
jest.mock("@/lib/subscription/commandcode/chat-bridge", () => ({
  resolveCommandcodeVaultCredential: (
    ...a: Parameters<typeof mResolveCommandcodeVaultCredential>
  ) => mResolveCommandcodeVaultCredential(...a),
}))
jest.mock("@/lib/subscription/codex/chat-bridge", () => ({
  resolveCodexVaultCredential: (...a: Parameters<typeof mResolveCodexVaultCredential>) =>
    mResolveCodexVaultCredential(...a),
}))

jest.mock("@/lib/twin/runtime", () => ({
  applyTwinContext: (...args: Parameters<typeof mApplyTwinContext>) => mApplyTwinContext(...args),
}))

// Project-scoped RAG (workspace knowledge base) — dynamically imported by
// resolveSendOptions. Mock so we can drive the injected section deterministically.
const mApplyProjectKnowledge = jest.fn()
jest.mock("@/lib/project-knowledge/runtime/apply-project-context", () => ({
  applyProjectKnowledgeContext: (...args: Parameters<typeof mApplyProjectKnowledge>) =>
    mApplyProjectKnowledge(...args),
}))

const mApplyAgentKnowledge = jest.fn()
jest.mock("@/lib/knowledge-base/runtime/apply-agent-knowledge-context", () => ({
  applyAgentKnowledgeContextFromDb: (...args: Parameters<typeof mApplyAgentKnowledge>) =>
    mApplyAgentKnowledge(...args),
}))

// skills-bridge is dynamically imported by resolveSendOptions when a character
// has pluginSkillIds. Mock it so we can drive the anthropic-managed (container)
// skill path deterministically.
const mResolveSkillsForCharacter = jest.fn()
const mExtractContainerSkillIds = jest.fn()
const mRenderResolvedSkillsSection = jest.fn()
jest.mock("@/lib/claude/skills-bridge", () => ({
  resolveSkillsForCharacter: (...a: Parameters<typeof mResolveSkillsForCharacter>) =>
    mResolveSkillsForCharacter(...a),
  extractContainerSkillIds: (...a: Parameters<typeof mExtractContainerSkillIds>) =>
    mExtractContainerSkillIds(...a),
  renderResolvedSkillsSection: (...a: Parameters<typeof mRenderResolvedSkillsSection>) =>
    mRenderResolvedSkillsSection(...a),
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
    buildSupportAgentContext: (...args: Parameters<typeof mockBuildSupportContext>) =>
      mockBuildSupportContext(...args),
    isSupportDiagnosticsEnabled: () => true,
  }
})

// Router + Fusion loader: real by default, a failing import on demand, and a
// counter proving the off path never reaches it.
const mockFusionLoader = { calls: 0, fail: null as Error | null }
jest.mock("@/lib/router-fusion/gate/load-engine", () => {
  const actual = jest.requireActual("@/lib/router-fusion/gate/load-engine")
  return {
    ...actual,
    loadRouterFusionHost: () => {
      mockFusionLoader.calls += 1
      if (mockFusionLoader.fail) {
        const { RouterFusionInfrastructureError } = jest.requireActual(
          "@/lib/router-fusion/gate/faults"
        )
        return Promise.reject(
          new RouterFusionInfrastructureError("import_failed", mockFusionLoader.fail.message)
        )
      }
      return actual.loadRouterFusionHost()
    },
  }
})
const mockHostModuleLoads = jest.fn()
jest.mock("@/lib/router-fusion/host", () => {
  mockHostModuleLoads()
  return jest.requireActual("@/lib/router-fusion/host")
})
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { routerFusion: { enabled: true, surfaces: { chat: true } } },
    }),
  },
}))

import { resolveAccountEnv, resolveAccountId, resolveProxyEnv } from "@/lib/claude/env-resolver"
import { listEnabledSkillsByIds, listSkillsByIds, recordSkillUsage } from "@/lib/db/skills"
import { buildMcpServerMapResolved, listEnabledMcpServers } from "@/lib/db/mcp-servers"
import { useAgentRuntimeStore } from "@/stores/agent"
import { compositionForSession } from "@/stores/agent/agent-runtime-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { __resetBreakerForTesting, getBreakerSnapshot } from "@/lib/router-fusion/gate/breaker"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import { __resetChatRunsForTesting, preparedChatRoute } from "@/lib/router-fusion/chat/chat-runs"
import { useChatFusionModeStore } from "@/stores/chat/fusion-mode-store"
import type { AppSettings, ChatSession, SendOptions } from "@cognia/agent-config-types"
import {
  resetProviderRoutingRuntimeAdaptersForTesting,
  setProviderRoutingRuntimeAdapters,
} from "@cognia/provider-routing/runtime-adapters"

import { resolveSendOptions, type BuildOptionsContext } from "./build-options"

function makeSession(p: Partial<ChatSession> = {}): ChatSession {
  return { id: "s1", title: "t", kind: "direct", createdAt: 0, updatedAt: 0, ...p } as ChatSession
}

const routingConfig = {
  strategy: "quality",
  allowPerRequestOverride: true,
  providerConstraints: [],
  requestTimeoutMs: 30000,
  maxFallbackAttempts: 3,
}

function appSettings(routerFusion?: unknown, extra: Record<string, unknown> = {}): AppSettings {
  return {
    defaultProvider: "anthropic",
    defaultModel: "powerful",
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
    ...(routerFusion !== undefined ? { routerFusion } : {}),
    ...extra,
  } as unknown as AppSettings
}

const ON = { enabled: true, surfaces: { chat: true } }

/** The send options without per-call identities (trace ids are random per build). */
function comparable(opts: SendOptions): Record<string, unknown> {
  const {
    traceId: _t,
    spanId: _s,
    traceparent: _p,
    routingPlan,
    ...rest
  } = opts as SendOptions & {
    traceId?: string
    spanId?: string
    traceparent?: string
  }
  const plan = routingPlan as { decisionId?: string; createdAt?: number } | undefined
  return {
    ...rest,
    ...(plan ? { routingPlan: { ...plan, decisionId: "x", createdAt: 0 } } : {}),
  }
}

function send(ctx: Partial<BuildOptionsContext>): Promise<SendOptions> {
  return resolveSendOptions({
    session: makeSession(),
    routingContextHint: { promptText: "What is the capital of France?" },
    ...ctx,
  } as BuildOptionsContext)
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(listEnabledSkillsByIds as jest.Mock).mockResolvedValue([])
  ;(listSkillsByIds as jest.Mock).mockResolvedValue([])
  ;(recordSkillUsage as jest.Mock).mockResolvedValue(undefined)
  ;(listEnabledMcpServers as jest.Mock).mockResolvedValue([])
  ;(buildMcpServerMapResolved as jest.Mock).mockReturnValue({})
  ;(useAgentRuntimeStore as unknown as { getState: jest.Mock }).getState.mockReturnValue({
    modeId: undefined,
  })
  ;(compositionForSession as jest.Mock).mockReturnValue({ presetId: "standard" })
  ;(useCustomModeStore as unknown as { getState: jest.Mock }).getState.mockReturnValue({
    customModes: {},
  })
  ;(usePluginStore as unknown as { getState: jest.Mock }).getState.mockReturnValue({
    plugins: {},
    getAllModes: () => [],
  })
  ;(resolveAccountId as jest.Mock).mockReturnValue(null)
  ;(resolveAccountEnv as jest.Mock).mockResolvedValue({})
  ;(resolveProxyEnv as jest.Mock).mockResolvedValue({})
  mockFusionLoader.calls = 0
  mockFusionLoader.fail = null
  __resetBreakerForTesting()
  __resetChatRunsForTesting()
  useChatFusionModeStore.setState({ modes: {} })
})

describe("resolveSendOptions — Router + Fusion off", () => {
  it("[ACC:OFF-02] resolves a chat turn exactly as before when the switch is off", async () => {
    const baseline = await send({ appSettings: appSettings() })
    for (const routerFusion of [
      { enabled: false, surfaces: { chat: true } },
      { enabled: true, surfaces: { chat: false } },
      { enabled: "true", surfaces: { chat: true } },
    ]) {
      const off = await send({
        appSettings: appSettings(routerFusion),
        routerFusionSurface: "chat",
      })
      expect(comparable(off)).toEqual(comparable(baseline))
    }
    // The legacy in-turn fallback is still there: nothing was replaced.
    expect(baseline.fallbackModel).toBe("claude-opus-4-7")
    expect(baseline.ledger).toBeUndefined()
  })

  it("[ACC:OFF-03] loads no Router + Fusion code while off (the fusion database is only reachable through it)", async () => {
    await send({ appSettings: appSettings({ enabled: false }), routerFusionSurface: "chat" })
    await send({ appSettings: appSettings(ON) })
    expect(mockFusionLoader.calls).toBe(0)
    expect(mockHostModuleLoads).not.toHaveBeenCalled()
  })

  it("never routes a caller that is not the chat composer, whatever the switches say", async () => {
    const opts = await send({ appSettings: appSettings(ON) })
    expect(opts.ledger).toBeUndefined()
    expect(opts.fallbackModel).toBe("claude-opus-4-7")
    expect(mockFusionLoader.calls).toBe(0)
  })
})

describe("resolveSendOptions — Router + Fusion on", () => {
  it("routes the chat turn as a ledgered direct run with no silent fallback", async () => {
    const opts = await send({ appSettings: appSettings(ON), routerFusionSurface: "chat" })
    expect(opts.provider).toBe("anthropic")
    expect(opts.model).toBe("claude-opus-4-8")
    expect(opts.fallbackModel).toBeUndefined()
    expect(opts.routerFusionBypass).toBeUndefined()
    expect(opts.routerFusion).toMatchObject({
      actionId: "direct_baseline",
      mode: "direct",
      deploymentId: "anthropic::claude-opus-4-8",
      lane: "claude-agent-sdk",
    })
    expect(opts.ledger).toMatchObject({
      runId: opts.routerFusion?.runId,
      mode: "envelope",
      deploymentId: "anthropic::claude-opus-4-8",
      envelopeMaxBudgetUsd: 0.5,
    })
    expect(opts.aliasResolution?.fallbackEntries).toEqual([
      { providerId: "anthropic", modelId: "claude-opus-4-7" },
    ])
    // The route waits in memory for the run to be created at dispatch.
    expect(preparedChatRoute(opts.routerFusion!.runId)?.sessionId).toBe("s1")
  })

  it("[ACC:CACHE-03] keeps the model-facing prompt byte-stable across consecutive routed turns", async () => {
    const settings = appSettings(ON)
    const first = await send({ appSettings: settings, routerFusionSurface: "chat" })
    const second = await send({ appSettings: settings, routerFusionSurface: "chat" })
    // Each turn is its own run…
    expect(first.routerFusion?.runId).toBeDefined()
    expect(second.routerFusion?.runId).not.toBe(first.routerFusion?.runId)
    // …but routing adds nothing per-turn to what the model reads, so the cached
    // prefix of the second turn is the first turn's.
    const promptOf = (opts: SendOptions) => {
      const o = opts as SendOptions & { dynamicSystemPrompt?: unknown }
      return {
        systemPrompt: o.systemPrompt,
        appendSystemPrompt: o.appendSystemPrompt,
        dynamic: o.dynamicSystemPrompt,
      }
    }
    expect(promptOf(second)).toEqual(promptOf(first))
    const text = JSON.stringify(promptOf(second))
    // Not vacuous: the turn does carry a system prompt.
    expect(text.length).toBeGreaterThan(100)
    for (const id of [second.routerFusion!.runId, second.routerFusion!.decisionId]) {
      expect(text).not.toContain(id)
    }
  })

  it("[ACC:ISO-01] falls back to the original path with a notice when Router + Fusion fails to load", async () => {
    mockFusionLoader.fail = new Error("chunk failed")
    const opts = await send({ appSettings: appSettings(ON), routerFusionSurface: "chat" })
    expect(opts.routerFusionBypass).toEqual({ code: "import_failed", justTripped: false })
    expect(opts.ledger).toBeUndefined()
    expect(opts.routerFusion).toBeUndefined()
    // The original path ran: its in-turn fallback is back.
    expect(opts.model).toBe("claude-opus-4-8")
    expect(opts.fallbackModel).toBe("claude-opus-4-7")
  })

  it("[ACC:ISO-02] trips the chat breaker after consecutive faults and keeps the original path", async () => {
    mockFusionLoader.fail = new Error("chunk failed")
    const settings = appSettings({ ...ON, breakerThreshold: 2 })
    await send({ appSettings: settings, routerFusionSurface: "chat" })
    const second = await send({ appSettings: settings, routerFusionSurface: "chat" })
    expect(second.routerFusionBypass).toEqual({ code: "import_failed", justTripped: true })
    expect(getBreakerSnapshot("chat").trip).toMatchObject({ reason: "import_failed" })
    mockFusionLoader.fail = null
    const tripped = await send({ appSettings: settings, routerFusionSurface: "chat" })
    expect(tripped.routerFusionBypass).toEqual({ code: "breaker_tripped", justTripped: false })
    expect(tripped.fallbackModel).toBe("claude-opus-4-7")
    expect(mockFusionLoader.calls).toBe(2)
  })

  it("[ACC:ISO-04] refuses a turn with no route instead of bypassing it", async () => {
    const settings = appSettings(ON, {
      modelMappings: [
        {
          id: "m-powerful",
          alias: "powerful",
          providers: [{ providerId: "anthropic", modelId: "claude-opus-4-8" }],
          distribution: "priority",
          enabled: true,
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      routerFusion: { ...ON, runCapUsdByMode: { direct: "0.000001" } },
    })
    await expect(
      send({ appSettings: settings, routerFusionSurface: "chat" })
    ).rejects.toBeInstanceOf(RouterFusionRefusalError)
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
  })

  it("[ACC:ISO-04] refuses at selection when the alias has no candidate left, and never plans the legacy route", async () => {
    const settings = appSettings(ON, { providerSettings: { anthropic: { enabled: false } } })
    const refusal = await send({ appSettings: settings, routerFusionSurface: "chat" }).catch(
      (error) => error
    )
    expect(refusal).toBeInstanceOf(RouterFusionRefusalError)
    expect(refusal).toMatchObject({
      code: "ROUTE_NO_SOLUTION",
      details: { reasons: ["NO_CANDIDATES:alias:powerful"] },
    })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(0)
  })

  it("routes a turn whose model came from the provider default, with no alias or manual pick", async () => {
    const settings = appSettings(ON, {
      defaultModel: undefined,
      providerSettings: {
        anthropic: { enabled: true, apiKey: "sk-ant-test", defaultModel: "claude-opus-4-8" },
      },
    })
    const opts = await send({ appSettings: settings, routerFusionSurface: "chat" })
    expect(opts.model).toBe("claude-opus-4-8")
    expect(opts.routerFusion).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      ruleId: "R1_explicit_action",
    })
    expect(opts.ledger?.runId).toBe(opts.routerFusion?.runId)
    expect(opts.fallbackModel).toBeUndefined()
  })

  it("[ACC:ISO-04] refuses a provider-default model the router cannot place", async () => {
    const settings = appSettings(ON, {
      defaultModel: undefined,
      providerSettings: {
        anthropic: { enabled: true, apiKey: "sk-ant-test", defaultModel: "claude-opus-4-8" },
      },
    })
    // The provider's circuit is open: its default model resolves, but routing
    // has no deployment for it, and the turn must not go out anyway.
    setProviderRoutingRuntimeAdapters({ isCircuitBreakerAvailable: (id) => id !== "anthropic" })
    try {
      const refusal = await send({ appSettings: settings, routerFusionSurface: "chat" }).catch(
        (error) => error
      )
      expect(refusal).toBeInstanceOf(RouterFusionRefusalError)
      expect(refusal).toMatchObject({
        code: "ROUTE_NO_SOLUTION",
        details: { reasons: ["NO_CANDIDATES:anthropic::claude-opus-4-8"] },
      })
    } finally {
      resetProviderRoutingRuntimeAdaptersForTesting()
    }
  })

  it("caps an AI SDK turn's output at what each call reserves", async () => {
    const settings = appSettings(ON, {
      defaultProvider: "openai",
      defaultModel: "gpt-5",
      providerSettings: { openai: { enabled: true, apiKey: "sk-test" } },
    })
    const opts = await send({ appSettings: settings, routerFusionSurface: "chat" })
    expect(opts.routerFusion?.lane).toBe("ai-sdk")
    expect(opts.ledger?.mode).toBe("per_call")
    expect(opts.modelParams?.maxOutputTokens).toBeGreaterThan(0)
  })
})

function capable(id: string) {
  return {
    id,
    name: id,
    contextLength: 200_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
  }
}

/** Three tiers on three different models, so a panel can seat independent members. */
function tieredSettings(routerFusion: Record<string, unknown>): AppSettings {
  const mapping = (alias: string, providerId: string, modelId: string) => ({
    id: `m-${alias}`,
    alias,
    providers: [{ providerId, modelId }],
    distribution: "priority",
    enabled: true,
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  })
  return appSettings(routerFusion, {
    defaultProvider: "openai",
    defaultModel: "auto",
    // What discovery reported for each model: a panel's roles need tools and
    // structured output, and unknown capabilities count as unsupported.
    providerSettings: {
      openai: {
        enabled: true,
        apiKey: "sk-test",
        discoveredModels: [capable("gpt-5-mini"), capable("gpt-5")],
      },
      anthropic: {
        enabled: true,
        apiKey: "sk-ant-test",
        discoveredModels: [capable("claude-sonnet-5")],
      },
    },
    modelMappings: [
      mapping("fast", "openai", "gpt-5-mini"),
      mapping("powerful", "openai", "gpt-5"),
      mapping("balanced", "anthropic", "claude-sonnet-5"),
    ],
  })
}

describe("resolveSendOptions — Router + Fusion runs (B3)", () => {
  const research = { promptText: "Compare the 2024 and 2025 steel tariffs and cite sources." }

  it("stamps an explicit panel as a fusion run and routes no direct turn for it", async () => {
    useChatFusionModeStore.getState().setMode("s1", "panel")
    const opts = await send({
      appSettings: tieredSettings(ON),
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(opts.routerFusionRun).toMatchObject({
      mode: "panel",
      actionId: "panel_review",
      requested: "panel",
      roles: { panel_a: "openai::gpt-5-mini", panel_b: "anthropic::claude-sonnet-5" },
    })
    // Not a sidecar turn: no ledger stamp, no direct route waiting for it.
    expect(opts.ledger).toBeUndefined()
    expect(opts.routerFusion).toBeUndefined()
    expect(preparedChatRoute(opts.routerFusionRun!.runId)).toBeUndefined()
    // The pipeline names the deployment that writes the answer, not "auto".
    expect(opts.model).toBe("gpt-5")
  })

  it("keeps an ordinary direct turn for Auto until a fusion rule row is approved", async () => {
    const plain = await send({
      appSettings: tieredSettings(ON),
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(plain.routerFusionRun).toBeUndefined()
    expect(plain.routerFusion?.mode).toBe("direct")

    const approved = await send({
      appSettings: tieredSettings({ ...ON, approvedRuleRows: ["panel_research"] }),
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(approved.routerFusionRun).toMatchObject({
      mode: "panel",
      requested: "auto",
      ruleId: "R4_panel_research",
    })

    // A pinned direct turn never becomes a panel, whatever the rule rows say.
    useChatFusionModeStore.getState().setMode("s1", "direct")
    const pinned = await send({
      appSettings: tieredSettings({ ...ON, approvedRuleRows: ["panel_research"] }),
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(pinned.routerFusionRun).toBeUndefined()
    expect(pinned.routerFusion?.mode).toBe("direct")
  })

  it("names the strong deployment for a cascade, which writes a failed draft's answer", async () => {
    useChatFusionModeStore.getState().setMode("s1", "cascade")
    const opts = await send({
      appSettings: tieredSettings(ON),
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(opts.routerFusionRun).toMatchObject({
      mode: "cascade",
      // No schema to check a chat turn against: a reviewer model checks the draft.
      actionId: "cascade_review",
      acceptanceProfile: "text_review",
      roles: { cheap: "openai::gpt-5-mini", strong: "openai::gpt-5" },
    })
    expect(opts.routerFusionRun?.roles.synthesizer).toBeUndefined()
    expect(opts.provider).toBe("openai")
    expect(opts.model).toBe("gpt-5")
  })

  it("routes an explicit panel even when the conversation names no model at all", async () => {
    useChatFusionModeStore.getState().setMode("s1", "panel")
    const noModel = {
      ...tieredSettings(ON),
      defaultModel: undefined,
      defaultProvider: undefined,
    } as AppSettings
    const opts = await send({
      appSettings: noModel,
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(opts.routerFusionRun).toMatchObject({ mode: "panel", actionId: "panel_review" })
    expect(opts.routerFusion).toBeUndefined()
    expect(opts.model).toBe("gpt-5")
  })

  it("routes a fusion turn under its project's data class", async () => {
    useChatFusionModeStore.getState().setMode("s1", "panel")
    const restricted = tieredSettings({
      ...ON,
      dataClassByWorkspaceId: { "project-1": "restricted" },
    })
    const refusal = await send({
      appSettings: restricted,
      session: { ...makeSession(), projectId: "project-1" },
      routerFusionSurface: "chat",
      routingContextHint: research,
    }).catch((error) => error)
    expect(refusal).toBeInstanceOf(RouterFusionRefusalError)
    expect(refusal).toMatchObject({ code: "ROUTE_NO_SOLUTION" })
    // Another project keeps the default class and gets its panel.
    const other = await send({
      appSettings: restricted,
      session: { ...makeSession(), projectId: "project-2" },
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(other.routerFusionRun?.mode).toBe("panel")
  })

  it("refuses an explicit mode it cannot run instead of answering with a direct turn", async () => {
    useChatFusionModeStore.getState().setMode("s1", "panel")
    const refusal = await send({
      appSettings: tieredSettings(ON),
      routerFusionSurface: "chat",
      routingContextHint: { ...research, attachmentKinds: ["image"] },
    }).catch((error) => error)
    expect(refusal).toBeInstanceOf(RouterFusionRefusalError)
    expect(refusal).toMatchObject({ code: "FUSION_TEXT_ONLY" })
  })

  it("[ACC:ISO-03] fails an explicit mode on a fault or a paused surface, never falling back", async () => {
    useChatFusionModeStore.getState().setMode("s1", "cascade")
    mockFusionLoader.fail = new Error("chunk failed")
    const settings = tieredSettings({ ...ON, breakerThreshold: 1 })
    const fault = await send({
      appSettings: settings,
      routerFusionSurface: "chat",
      routingContextHint: research,
    }).catch((error) => error)
    expect(fault).toMatchObject({ code: "ROUTER_FUSION_UNAVAILABLE" })
    expect(getBreakerSnapshot("chat").trip).toMatchObject({ reason: "import_failed" })
    mockFusionLoader.fail = null
    const paused = await send({
      appSettings: settings,
      routerFusionSurface: "chat",
      routingContextHint: research,
    }).catch((error) => error)
    expect(paused).toMatchObject({ code: "ROUTER_FUSION_UNAVAILABLE" })
    // The same session back on Auto is ordinary traffic again: original path with a notice.
    useChatFusionModeStore.getState().setMode("s1", "auto")
    const ordinary = await send({
      appSettings: settings,
      routerFusionSurface: "chat",
      routingContextHint: research,
    })
    expect(ordinary.routerFusionBypass).toEqual({ code: "breaker_tripped", justTripped: false })
  })

  it("[ACC:OFF-02] ignores a stored composer mode while chat is off", async () => {
    useChatFusionModeStore.getState().setMode("s1", "panel")
    const baseline = await send({ appSettings: appSettings() })
    const off = await send({
      appSettings: appSettings({ enabled: false }),
      routerFusionSurface: "chat",
    })
    expect(comparable(off)).toEqual(comparable(baseline))
    expect(off.routerFusionRun).toBeUndefined()
    expect(mockFusionLoader.calls).toBe(0)
  })
})
