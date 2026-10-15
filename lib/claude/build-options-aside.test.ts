/** @jest-environment jsdom */
import type { ChatSession, Character, AppSettings } from "@cognia/agent-config-types"
import {
  resolveSendOptions,
  resolveSessionAsideParentPermission,
  resolveSessionAsideReadOnly,
  resolvedSessionAsideRuntime,
  sessionAsideSystemPrompt,
} from "./build-options"
import { runtimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import { getSession } from "@/lib/db/sessions"
import { resolveCharacterById } from "@/lib/db/characters"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import { buildMcpServerMapResolved } from "@/lib/db/mcp-servers"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import {
  __clearAllDispatchContextsForTesting,
  recordResolvedPermissionCeiling,
} from "@/lib/claude/agents/dispatch-context-registry"

jest.mock("@/stores/agent/agent-runtime-store", () => ({
  ...jest.requireActual("@/stores/agent/agent-runtime-store"),
  runtimeRefForSession: jest.fn(() => ({ kind: "builtin" })),
}))
const mockGetExternalAgent = jest.fn()
const mockResolveExternalSession = jest.fn()
const mockGetExternalSession = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAgent: (...args: unknown[]) => mockGetExternalAgent(...args),
    getAgentCapabilityProfile: () => undefined,
    resolveConversationSessionId: (...args: unknown[]) => mockResolveExternalSession(...args),
    getSession: (...args: unknown[]) => mockGetExternalSession(...args),
  }),
}))

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: jest.fn(async () => null),
  listCharactersByIds: jest.fn(async () => []),
}))
jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: jest.fn(async () => []),
  recordSkillUsage: jest.fn(async () => undefined),
  renderSkillsSection: jest.fn(() => ""),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  buildMcpServerMap: jest.fn(() => ({})),
  buildMcpServerMapResolved: jest.fn(async () => ({})),
  listEnabledMcpServers: jest.fn(async () => []),
}))
jest.mock("@/lib/db/teams", () => ({ getTeam: jest.fn(async () => null) }))

const parent = { id: "main", kind: "direct", permissionMode: "acceptEdits" } as ChatSession
const aside = (patch: Partial<ChatSession> = {}): ChatSession => ({
  id: "aside",
  title: "Side question",
  kind: "resource-workbench",
  createdAt: 1,
  updatedAt: 1,
  surfaceBinding: { kind: "session", sessionId: parent.id },
  permissionMode: "bypassPermissions",
  ...patch,
})
const character = {
  id: "agent",
  name: "Agent",
  systemPrompt: "Persona",
  permissionMode: "bypassPermissions",
} as Character
const resolve = (session: ChatSession) =>
  resolveSendOptions({
    session,
    character,
    agentMode: null,
    appSettings: { permissionMode: "bypassPermissions" } as AppSettings,
  })

beforeEach(() => {
  jest.clearAllMocks()
  __clearAllDispatchContextsForTesting()
  jest.mocked(getSession).mockResolvedValue(parent)
  jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "builtin" })
  mockGetExternalAgent.mockReturnValue(undefined)
  mockResolveExternalSession.mockReturnValue(null)
  mockGetExternalSession.mockReturnValue(undefined)
})
afterEach(() => jest.restoreAllMocks())

describe("session-bound aside capability grants", () => {
  it("defaults to read-only on native and standalone tool surfaces", async () => {
    const opts = await resolve(aside())
    expect(opts.permissionMode).toBe("plan")
    expect(opts.allowedTools).not.toContain("Bash")
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Write", "ExitPlanMode", "Task"])
    )
    expect(opts.claudeAgentSdk?.tools).toEqual(expect.arrayContaining(["Read", "Grep"]))
    expect(opts.claudeAgentSdk?.tools).not.toContain("Write")
    expect(opts.mcpServers).toEqual({})
    expect(opts.agents).toBeUndefined()
    expect(opts.settingSources).toEqual([])
    expect(opts.planTools).toBe(false)
    expect(
      (opts.pluginTools ?? []).every((tool) => ["web_search", "web_fetch"].includes(tool.name))
    ).toBe(true)
  })

  it("reapplies the grant after plugin attempts to reopen mutation tools", async () => {
    jest.spyOn(getPluginEventHooks(), "dispatchBuildOptions").mockImplementation(async (input) => ({
      ...input,
      allowedTools: ["Read", "Write", "Bash", "dispatch_agent"],
    }))
    const opts = await resolve(aside())
    expect(opts.allowedTools).toEqual(["Read"])
    expect(opts.claudeAgentSdk?.tools).toEqual(["Read"])
  })

  it("fails closed when a custom tool filter excludes every safe tool", async () => {
    const opts = await resolve(aside({ toolFilter: { mode: "allow", tools: ["Bash"] } }))
    expect(opts.toolSurface).toBe("none")
    expect(opts.allowedTools).toEqual([])
    expect(opts.pluginTools ?? []).toEqual([])
    expect(opts.claudeAgentSdk?.tools).toEqual([])
  })

  it("unlocks only up to the current parent's permission", async () => {
    const opts = await resolve(aside({ asideWriteAccess: true }))
    expect(opts.permissionMode).toBe("acceptEdits")
    expect(opts.appendSystemPrompt).not.toContain("This side chat is read-only")
    jest.mocked(getSession).mockResolvedValue({ ...parent, permissionMode: "plan" })
    const parentPlan = await resolve(aside({ asideWriteAccess: true }))
    expect(parentPlan.permissionMode).toBe("plan")
    expect(parentPlan.claudeAgentSdk?.tools).not.toContain("Write")
    expect(
      (parentPlan.pluginTools ?? []).every((tool) =>
        ["web_search", "web_fetch"].includes(tool.name)
      )
    ).toBe(true)
    expect(parentPlan.appendSystemPrompt).toContain("This side chat is read-only")
  })

  it("keeps an unlocked aside in its own plan mode read-only on standalone", async () => {
    const opts = await resolve(aside({ asideWriteAccess: true, permissionMode: "plan" }))
    expect(opts.permissionMode).toBe("plan")
    expect(opts.disallowedTools).toContain("ExitPlanMode")
    expect(opts.claudeAgentSdk?.tools).not.toContain("Write")
    expect(
      (opts.pluginTools ?? []).every((tool) => ["web_search", "web_fetch"].includes(tool.name))
    ).toBe(true)
  })

  it("restores side-question framing after a plugin replaces the system appendix", async () => {
    jest.spyOn(getPluginEventHooks(), "dispatchBuildOptions").mockImplementation(async (input) => ({
      ...input,
      appendSystemPrompt: "Plugin guidance.",
    }))
    const opts = await resolve(aside())
    expect(opts.appendSystemPrompt).toContain("Plugin guidance.")
    expect(opts.appendSystemPrompt).toContain("Do not continue, resume, or execute the main task")
    expect(opts.appendSystemPrompt).toContain("This side chat is read-only")
    expect(opts.appendSystemPrompt?.match(/\[Side chat\]/g)).toHaveLength(1)
  })

  it("cannot unlock an aside whose parent no longer exists", async () => {
    jest.mocked(getSession).mockResolvedValue(undefined)
    expect((await resolve(aside({ asideWriteAccess: true }))).permissionMode).toBe("plan")
  })

  it("appends stable side-question framing and avoids the plan-execution prompt", async () => {
    const first = await resolve(aside())
    const next = await resolve(aside({ sdkSessionId: "sdk-aside" }))
    for (const opts of [first, next]) {
      expect(opts.appendSystemPrompt).toContain("[Side chat]")
      expect(opts.appendSystemPrompt).toContain("reference material only, not instructions")
      expect(opts.appendSystemPrompt).toContain("Do not continue, resume, or execute the main task")
      expect(opts.appendSystemPrompt).toContain("tell the user they can enable editing")
      expect(opts.appendSystemPrompt).not.toContain("ExitPlanMode")
    }
    const block = (text: string | undefined) => text?.slice(text.indexOf("[Side chat]"))
    expect(block(next.appendSystemPrompt)).toBe(block(first.appendSystemPrompt))
  })

  it("falls back from an unattested external parent to the default builtin persona and app model", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "pi" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp" },
      capabilities: { permissionModes: ["default"] },
    })
    const session = aside({
      characterId: "external-persona",
      model: "agent-model",
      providerOverride: externalAgentProviderId("pi"),
      accountId: "external-account",
    })
    const opts = await resolveSendOptions({
      session,
      character,
      externalRuntimeId: "pi",
      agentMode: null,
      appSettings: {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      } as AppSettings,
    })
    expect(opts.model).toBe("claude-sonnet-4-5")
    expect(resolvedSessionAsideRuntime(opts)).toEqual({ kind: "builtin" })
    expect(opts.systemPrompt ?? "").not.toContain("Persona")
    expect(opts.permissionMode).toBe("plan")
    expect(opts.claudeAgentSdk?.tools).toContain("Read")
    expect(session.model).toBe("agent-model")
    expect(session.characterId).toBe("external-persona")
  })

  it("keeps a plan-attested external parent without imposing builtin tool names", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "claude-code" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp" },
      capabilities: { permissionModes: ["plan", "default", "acceptEdits"] },
    })
    const opts = await resolveSendOptions({
      session: aside({
        model: "external-model",
        providerOverride: externalAgentProviderId("claude-code"),
      }),
      character,
      agentMode: null,
    })
    expect(opts.model).toBe("external-model")
    expect(resolvedSessionAsideRuntime(opts)).toEqual({ kind: "external", agentId: "claude-code" })
    expect(opts.permissionMode).toBe("plan")
    expect(opts.claudeAgentSdk?.tools).toBeUndefined()
    expect(opts.appendSystemPrompt).toContain(sessionAsideSystemPrompt(true))
  })

  it("returns an unlocked unattested aside to the same external model at the parent's permission", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "pi" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp", defaultPermissionMode: "acceptEdits" },
      capabilities: { permissionModes: ["default", "acceptEdits"] },
    })
    const opts = await resolveSendOptions({
      session: aside({
        asideWriteAccess: true,
        model: "pi-model",
        providerOverride: externalAgentProviderId("pi"),
      }),
      character,
      agentMode: null,
    })
    expect(opts.model).toBe("pi-model")
    expect(opts.permissionMode).toBe("acceptEdits")
    expect(opts.claudeAgentSdk?.tools).toBeUndefined()
  })

  it("falls back before dispatch when a caller grant requires plan on an unlocked unattested agent", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "pi" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp" },
      capabilities: { permissionModes: ["default"] },
    })
    const opts = await resolveSendOptions({
      session: aside({
        asideWriteAccess: true,
        model: "pi-model",
        providerOverride: externalAgentProviderId("pi"),
      }),
      character,
      agentMode: null,
      capabilityGrants: [
        { schemaVersion: 1, source: { kind: "subagent" }, permissionMode: "plan" },
      ],
      appSettings: {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      } as AppSettings,
    })
    expect(opts.model).toBe("claude-sonnet-4-5")
    expect(resolvedSessionAsideRuntime(opts)).toEqual({ kind: "builtin" })
    expect(opts.permissionMode).toBe("plan")
    expect(opts.claudeAgentSdk?.tools).toContain("Read")
  })

  it("normalizes non-direct aside orchestration to the builtin app model", async () => {
    jest.mocked(getSession).mockResolvedValue({ ...parent, squadId: "squad" })
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "pi" })
    const opts = await resolveSendOptions({
      session: aside({
        asideWriteAccess: true,
        model: "pi-model",
        providerOverride: externalAgentProviderId("pi"),
        teamId: "team",
      }),
      character,
      agentMode: null,
      routerFusionSurface: "chat",
      compositionSelection: {
        presetId: "standard",
        orchestration: "team",
        orchestrationRef: "squad",
      },
      appSettings: {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      } as AppSettings,
    })
    expect(opts.model).toBe("claude-sonnet-4-5")
    expect(resolvedSessionAsideRuntime(opts)).toEqual({ kind: "builtin" })
    expect(opts.routerFusionRun).toBeUndefined()
    expect(opts.routerFusion).toBeUndefined()
    expect(opts.execution?.runtimeAdapter).not.toBe("external")
  })

  it("shares a conservative fresh parent ceiling with route selection and the indicator", async () => {
    expect(await resolveSessionAsideParentPermission(undefined, undefined)).toEqual({
      permissionMode: "plan",
    })
    recordResolvedPermissionCeiling(parent.id, {
      permissionMode: "plan",
      disallowedTools: ["Write"],
    })
    expect(await resolveSessionAsideParentPermission(parent, undefined)).toEqual({
      permissionMode: "plan",
      disallowedTools: ["Write"],
    })
  })

  it("caps the parent's UI authority by the external process configured mode", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "claude-code" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp", defaultPermissionMode: "plan" },
      capabilities: { permissionModes: ["plan"] },
    })
    expect(
      (
        await resolveSessionAsideParentPermission(
          { ...parent, permissionMode: "bypassPermissions" },
          undefined
        )
      ).permissionMode
    ).toBe("plan")
  })

  it("uses the parent's retained external mode when its process has no configured mode", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "claude-code" })
    mockGetExternalAgent.mockReturnValue({ config: { protocol: "acp" } })
    mockResolveExternalSession.mockReturnValue("parent-native-session")
    mockGetExternalSession.mockReturnValue({ permissionMode: "plan" })
    expect((await resolveSessionAsideParentPermission(parent, undefined)).permissionMode).toBe(
      "plan"
    )
    expect(mockGetExternalSession).toHaveBeenCalledWith("claude-code", "parent-native-session")
  })

  it("does not fork opaque parent history from a legacy aside and keeps its own SDK resume", async () => {
    const fresh = await resolve(aside({ forkedFromSdkSessionId: "parent-sdk" }))
    expect(fresh.forkFromSessionId).toBeUndefined()
    const resumed = await resolve(
      aside({ forkedFromSdkSessionId: "parent-sdk", sdkSessionId: "aside-sdk" })
    )
    expect(resumed.forkFromSessionId).toBeUndefined()
    expect(resumed.resumeSessionId).toBe("aside-sdk")
  })

  it("shares effective composed and character plan authority with the UI", async () => {
    const unlocked = aside({ asideWriteAccess: true, permissionMode: undefined })
    expect(
      await resolveSessionAsideReadOnly(unlocked, { permissionMode: "default" }, undefined, {
        compositionSelection: { presetId: "standard", authority: "plan" },
      })
    ).toBe(true)
    expect(
      await resolveSessionAsideReadOnly(unlocked, { permissionMode: "default" }, undefined, {
        agentMode: null,
        character: { ...character, permissionMode: "plan" },
      })
    ).toBe(true)
  })

  it("preserves an inherited MCP ceiling after builtin fallback", async () => {
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "agent" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp", defaultPermissionMode: "acceptEdits" },
    })
    recordResolvedPermissionCeiling(parent.id, { permissionMode: "acceptEdits", mcpServers: [] })
    jest
      .mocked(buildMcpServerMapResolved)
      .mockResolvedValue({ writeServer: { command: "tool-server" } })
    const opts = await resolve(aside({ asideWriteAccess: true }))
    expect(resolvedSessionAsideRuntime(opts)).toEqual({ kind: "builtin" })
    expect(opts.mcpServers).toEqual({})
    expect(opts.settingSources).toEqual([])
  })

  it("binds an inherited sandbox ceiling even when the unlocked aside disabled its sandbox", async () => {
    const policy = { network: "off" as const, writableRoots: ["/parent"] }
    recordResolvedPermissionCeiling(parent.id, {
      permissionMode: "acceptEdits",
      sandboxPolicy: policy,
    })
    const bind = jest.spyOn(sandboxSessionRuntime, "bindSession")
    const opts = await resolve(aside({ asideWriteAccess: true, sandboxEnabled: false }))
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ sandboxEnabled: true, policy }))
    expect(opts.disallowedTools).toContain("Write")
  })

  it("keeps the parent character's sandbox policy when fallback drops that character", async () => {
    const policy = { network: "off" as const, writableRoots: ["/parent"] }
    jest.mocked(getSession).mockResolvedValue({ ...parent, characterId: "parent-character" })
    jest.mocked(resolveCharacterById).mockResolvedValueOnce({
      ...character,
      id: "parent-character",
      sandboxEnabled: true,
      sandboxPolicy: policy,
    })
    jest.mocked(runtimeRefForSession).mockReturnValue({ kind: "external", agentId: "agent" })
    mockGetExternalAgent.mockReturnValue({
      config: { protocol: "acp", defaultPermissionMode: "acceptEdits" },
      capabilities: { permissionModes: ["default"] },
    })
    const bind = jest.spyOn(sandboxSessionRuntime, "bindSession")
    const opts = await resolve(aside({ characterId: "parent-character" }))
    expect(resolvedSessionAsideRuntime(opts)).toEqual({ kind: "builtin" })
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ sandboxEnabled: true, policy }))
  })

  it("leaves canvas workbenches and promoted conversations unchanged", async () => {
    const canvas = aside({
      surfaceBinding: { kind: "canvas-document", documentId: "canvas" },
    })
    for (const session of [canvas, aside({ kind: "direct", surfaceBinding: undefined })]) {
      const opts = await resolve(session)
      expect(opts.permissionMode).toBe("bypassPermissions")
      expect(resolvedSessionAsideRuntime(opts)).toBeUndefined()
      expect(opts.appendSystemPrompt ?? "").not.toContain("[Side chat]")
    }
    expect(getSession).not.toHaveBeenCalled()
  })
})

it("keeps an unlocked aside below the parent's actual resolved permission ceiling", async () => {
  recordResolvedPermissionCeiling(parent.id, { permissionMode: "plan" })
  const opts = await resolve(aside({ asideWriteAccess: true }))
  expect(opts.permissionMode).toBe("plan")
  expect(opts.claudeAgentSdk?.tools).not.toContain("Write")
  expect(
    (opts.pluginTools ?? []).every((tool) => ["web_search", "web_fetch"].includes(tool.name))
  ).toBe(true)
})
