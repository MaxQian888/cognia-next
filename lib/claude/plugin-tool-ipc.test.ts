/**
 * Tests for plugin-tool-ipc.ts
 * Renderer-side IPC handler for `plugin_tool_exec` events from the sidecar.
 */

import {
  __setPluginToolResolverForTesting,
  __setWebToolDepsForTesting,
  __setSkillToolDepsForTesting,
  __setSlashToolDepsForTesting,
  __setVectorToolDepsForTesting,
  __setSpawnTaskToolDepsForTesting,
  __setSessionPeerToolDepsForTesting,
  handlePluginToolExec,
  type PluginToolExecRequest,
  type PluginToolResolver,
} from "./plugin-tool-ipc"
import type { VectorToolRunDeps } from "./vector-builtin-tools"
// Static imports so these share the SAME module instance the top-level
// `handlePluginToolExec` closes over (sibling describes call jest.resetModules,
// which would make a dynamic import resolve a different registry instance).
import {
  registerTeamDispatchContext,
  clearTeamDispatchContext,
} from "./agents/dispatch-context-registry"
import { TEAM_TOOL_NAMES } from "./team-builtin-tools"
import { createSkillLoadContext, releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import type { Skill } from "@cognia/agent-config-types"

// Default `resolveWebToolDeps` reads the settings store and lazily imports the
// utility-model client, the fetch-extractor and the search cache. Mock all four
// so the default-resolver path can be exercised deterministically; existing
// tests use `__setWebToolDepsForTesting` and bypass these.
let mockSettings: Record<string, unknown> = {}
let mockClient: unknown = { complete: jest.fn() }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings }) },
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => mockClient),
}))
jest.mock("@/lib/web/web-tools-core", () => ({
  webFetch: jest.fn(async () => ({ ok: true })),
  webSearch: jest.fn(async () => ({ ok: true })),
  buildFetchExtractor: jest.fn(() => async () => "extracted"),
}))
jest.mock("@cognia/web-search/search-cache", () => ({
  getSearchCache: jest.fn(() => ({
    setConfig: jest.fn(),
    get: jest.fn(() => null),
    set: jest.fn(),
  })),
}))
// Built-in-skill context hydration (W2) — overridable per test so the suite
// can pin that the HYDRATED context (imBinding + override row) reaches
// runBuiltInSkill, closing the old bare-{sessionId} gate bypass.
const mockResolveSkillContext = jest.fn(async (sessionId: string) => ({ sessionId }))
jest.mock("@/lib/skills/built-in/context", () => ({
  resolveBuiltInSkillContext: (sessionId: string) => mockResolveSkillContext(sessionId),
}))
// Typed workflow runner fallback — the real core drags the orchestrator +
// Dexie in; the IPC suite only pins the ROUTING (name → shared executor).
const mockExecuteRunWorkflowTyped = jest.fn()
jest.mock("@/lib/workflow/publish/run-workflow-typed-tool", () => ({
  executeRunWorkflowTyped: (args: Record<string, unknown>) => mockExecuteRunWorkflowTyped(args),
}))

import { webSearch, webFetch, buildFetchExtractor } from "@/lib/web/web-tools-core"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { getSearchCache } from "@cognia/web-search/search-cache"

const mockWebSearch = webSearch as jest.Mock
const mockWebFetch = webFetch as jest.Mock

function makeRequest(overrides?: Partial<PluginToolExecRequest>): PluginToolExecRequest {
  return {
    type: "plugin_tool_exec",
    sessionId: "session-1",
    toolUseId: "use-1",
    name: "demo_tool",
    args: { hello: "world" },
    ...overrides,
  }
}

describe("handlePluginToolExec", () => {
  afterEach(() => {
    __setPluginToolResolverForTesting(null)
    __setWebToolDepsForTesting(null)
    __setSpawnTaskToolDepsForTesting(null)
    __setSessionPeerToolDepsForTesting(null)
  })

  it("resolves web_search before the plugin registry (supersedes the plugin)", async () => {
    // A resolver that would handle web_search if reached — it must NOT be.
    const execute = jest.fn().mockResolvedValue({ from: "plugin" })
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "cognia-web-tools", execute }),
    })
    __setWebToolDepsForTesting(() => ({
      providerSettings: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } } as never,
    }))

    const response = await handlePluginToolExec(
      makeRequest({ name: "web_search", args: { query: "hi" } })
    )
    expect(execute).not.toHaveBeenCalled()
    // No provider call wired in the test deps' search path returns the core's
    // shape; we only assert it routed to the web handler (not the plugin).
    expect(response.type).toBe("plugin_tool_response")
    expect(response.error).toBeUndefined()
  })

  it("routes web_fetch to the web built-in handler", async () => {
    __setWebToolDepsForTesting(() => ({ userAgent: "UA" }))
    const response = await handlePluginToolExec(
      makeRequest({ name: "web_fetch", args: { url: "https://example.test" } })
    )
    expect(response.type).toBe("plugin_tool_response")
    // Real fetch may fail in jsdom; either a result or a structured error is
    // fine — the point is it did NOT fall through to "plugin tool not found".
    expect(response.error ?? "").not.toMatch(/not found/)
  })

  it("routes spawn_task before the plugin registry and preserves the calling session", async () => {
    const dispatch = jest.fn(async () => ({ ok: true, taskSessionId: "task-1" }))
    const execute = jest.fn()
    __setSpawnTaskToolDepsForTesting(() => ({ gate: () => true, dispatch }))
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "duplicate", execute }),
    })

    const response = await handlePluginToolExec(
      makeRequest({
        name: "spawn_task",
        sessionId: "parent-1",
        args: {
          title: "Fix cleanup",
          tldr: "Handle it separately.",
          situation: "Cleanup is missing.",
          code_locations: [],
          solution: "Add the cleanup.",
          caveats: [],
        },
      })
    )

    expect(response).toMatchObject({ result: { ok: true, taskSessionId: "task-1" } })
    expect(dispatch).toHaveBeenCalledWith("parent-1", expect.objectContaining({ mode: "aside" }))
    expect(execute).not.toHaveBeenCalled()
  })

  it("routes session messaging before the plugin registry with the calling session identity", async () => {
    const send = jest.fn(async () => ({ id: "peer-1", status: "delivered" as const }))
    const execute = jest.fn()
    __setSessionPeerToolDepsForTesting(() => ({
      gate: () => true,
      listReachable: async () => [],
      send,
    }))
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "duplicate", execute }),
    })

    const response = await handlePluginToolExec(
      makeRequest({
        name: "send_session_message",
        sessionId: "sender-1",
        args: { target_session_id: "receiver-1", message: "Review this" },
      })
    )

    expect(response).toMatchObject({ result: { ok: true, id: "peer-1", status: "delivered" } })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ senderSessionId: "sender-1" }))
    expect(execute).not.toHaveBeenCalled()
  })

  it("returns a successful response with the execute() result", async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true })
    const resolver: PluginToolResolver = {
      getTool: () => ({ pluginId: "plug-a", execute }),
      getPluginConfig: () => ({ apiKey: "secret" }),
    }
    __setPluginToolResolverForTesting(resolver)

    const response = await handlePluginToolExec(makeRequest())

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      result: { ok: true },
    })
    expect(execute).toHaveBeenCalledWith(
      { hello: "world" },
      expect.objectContaining({
        sessionId: "session-1",
        config: { apiKey: "secret" },
      })
    )
  })

  it("blocks plugin results that fail the PII gate before returning them to the sidecar", async () => {
    const execute = jest.fn().mockResolvedValue({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///repo/contacts.txt",
            text: "Contact alice@example.com",
          },
        },
      ],
    })
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "plug-a", execute }),
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response.result).toBeUndefined()
    expect(response.error).toMatch(/PII redaction gate/)
  })

  it("returns an error response when the tool is unknown", async () => {
    const resolver: PluginToolResolver = {
      getTool: () => undefined,
    }
    __setPluginToolResolverForTesting(resolver)

    const response = await handlePluginToolExec(makeRequest({ name: "missing" }))

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      error: "plugin tool not found: missing",
    })
  })

  it("captures Error instances thrown from execute() and surfaces .message", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("boom"))
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      error: "boom",
    })
  })

  it("coerces non-Error throws to a string for the error field", async () => {
    const execute = jest.fn().mockRejectedValue("plain string failure")
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response.error).toBe("plain string failure")
    expect(response.result).toBeUndefined()
  })

  it("defaults the plugin config to {} when the resolver omits getPluginConfig", async () => {
    const execute = jest.fn().mockResolvedValue("ok")
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
      // getPluginConfig intentionally omitted
    })

    await handlePluginToolExec(makeRequest())

    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ config: {} }))
  })

  it("never throws even when the resolver itself throws synchronously", async () => {
    __setPluginToolResolverForTesting({
      getTool: () => {
        throw new Error("resolver exploded")
      },
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response.error).toBe("resolver exploded")
    expect(response.result).toBeUndefined()
  })

  it("threads the sessionId into the execution context", async () => {
    const execute = jest.fn().mockResolvedValue("ok")
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
    })

    await handlePluginToolExec(makeRequest({ sessionId: "alt-session" }))

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "alt-session" })
    )
  })
})

// ── Unified seam — production path (no resolver override) ────────────
describe("handlePluginToolExec — unified invokePluginTool path", () => {
  afterEach(async () => {
    const { __setInvokePluginToolDepsForTesting } =
      await import("@/lib/plugin/core/invoke-plugin-tool")
    __setInvokePluginToolDepsForTesting(null)
  })

  function makeSeamDeps(overrides?: {
    status?: string
    executeImpl?: jest.Mock
    consentAnswer?: boolean
    permissions?: string[]
    tier?: "silent" | "confirm" | "forbid"
  }) {
    const execute = overrides?.executeImpl ?? jest.fn().mockResolvedValue({ ok: true })
    const plugin = {
      status: overrides?.status ?? "enabled",
      config: { token: "t" },
      manifest: { permissions: overrides?.permissions ?? [] },
    }
    return {
      execute,
      deps: {
        getManager: () => ({
          getPlugin: () => plugin,
          getRegistry: () => ({
            getTool: (name: string) =>
              name === "demo_tool"
                ? {
                    name: "demo_tool",
                    pluginId: "plug-a",
                    definition: { name: "demo_tool", description: "d", parametersSchema: {} },
                    execute,
                  }
                : undefined,
          }),
          handleActivationEvent: async () => {},
        }),
        getGuard: () => ({
          getTier: () => overrides?.tier ?? "silent",
          checkWithConsent: async () => overrides?.consentAnswer ?? true,
        }),
        getBroker: () => ({ request: async () => overrides?.consentAnswer ?? true }),
      },
    }
  }

  it("routes through invokePluginTool with sessionId + plugin config", async () => {
    const { __setInvokePluginToolDepsForTesting } =
      await import("@/lib/plugin/core/invoke-plugin-tool")
    const { execute, deps } = makeSeamDeps()
    __setInvokePluginToolDepsForTesting(deps as never)

    const response = await handlePluginToolExec(makeRequest())

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      result: { ok: true },
    })
    expect(execute).toHaveBeenCalledWith(
      { hello: "world" },
      expect.objectContaining({ sessionId: "session-1", config: { token: "t" } })
    )
  })

  it("collapses a plugin-disabled seam error onto the error field", async () => {
    const { __setInvokePluginToolDepsForTesting } =
      await import("@/lib/plugin/core/invoke-plugin-tool")
    const { deps } = makeSeamDeps({ status: "disabled" })
    __setInvokePluginToolDepsForTesting(deps as never)

    const response = await handlePluginToolExec(makeRequest())

    expect(response.result).toBeUndefined()
    expect(response.error).toContain("not enabled")
  })

  it("collapses a permission denial onto the error field", async () => {
    const { __setInvokePluginToolDepsForTesting } =
      await import("@/lib/plugin/core/invoke-plugin-tool")
    const { deps } = makeSeamDeps({
      permissions: ["shell:execute"],
      tier: "confirm",
      consentAnswer: false,
    })
    __setInvokePluginToolDepsForTesting(deps as never)

    const response = await handlePluginToolExec(makeRequest())

    expect(response.error).toContain("denied")
  })

  it("falls through to the not-found error when no plugin registered the name", async () => {
    const { __setInvokePluginToolDepsForTesting } =
      await import("@/lib/plugin/core/invoke-plugin-tool")
    const { deps } = makeSeamDeps()
    __setInvokePluginToolDepsForTesting(deps as never)

    const response = await handlePluginToolExec(makeRequest({ name: "unknown_tool" }))

    expect(response.error).toBe("plugin tool not found: unknown_tool")
  })
})

// ── Typed workflow runner fallback ─────────────────────────────────────
describe("handlePluginToolExec — workflow runner fallback", () => {
  afterEach(() => {
    __setPluginToolResolverForTesting(null)
    mockExecuteRunWorkflowTyped.mockReset()
  })

  it("routes wf_run_workflow_typed to the shared lib core when the plugin registry misses", async () => {
    __setPluginToolResolverForTesting({ getTool: () => undefined })
    const ok = { ok: true, workflowId: "wf1", workflowName: "X", runId: "r1", output: 42 }
    mockExecuteRunWorkflowTyped.mockResolvedValue(ok)

    const response = await handlePluginToolExec(
      makeRequest({ name: "wf_run_workflow_typed", args: { name: "X", input: { a: 1 } } })
    )

    expect(mockExecuteRunWorkflowTyped).toHaveBeenCalledWith({ name: "X", input: { a: 1 } })
    expect(response.result).toEqual(ok)
    expect(response.error).toBeUndefined()
  })

  it("prefers the plugin registration when the plugin is enabled", async () => {
    const pluginExecute = jest.fn().mockResolvedValue({ ok: true, via: "plugin" })
    __setPluginToolResolverForTesting({
      getTool: (name) =>
        name === "wf_run_workflow_typed"
          ? { pluginId: "cognia-workflow-ai", execute: pluginExecute }
          : undefined,
    })

    const response = await handlePluginToolExec(makeRequest({ name: "wf_run_workflow_typed" }))

    expect(pluginExecute).toHaveBeenCalled()
    expect(mockExecuteRunWorkflowTyped).not.toHaveBeenCalled()
    expect(response.result).toEqual({ ok: true, via: "plugin" })
  })
})

// ── ADR-0026 — built-in skill fallback ────────────────────────────────
describe("handlePluginToolExec — built-in skill fallback", () => {
  afterEach(async () => {
    __setPluginToolResolverForTesting(null)
    const { __resetSharedBuiltInSkillRegistry } = await import("@/lib/skills/built-in/registry")
    __resetSharedBuiltInSkillRegistry()
  })

  it("routes an mcpToolName to the built-in skill dispatcher when plugin registry has no match", async () => {
    // Plugin resolver always misses — so the fallback path must fire.
    __setPluginToolResolverForTesting({ getTool: () => undefined })

    const { registerBuiltInSkill } = await import("@/lib/skills/built-in/registry")
    const { z } = await import("zod")
    const execute = jest.fn().mockResolvedValue({ events: [] })
    registerBuiltInSkill({
      id: "fallback.test",
      family: "fallback",
      label: { en: "x", "zh-CN": "x" },
      description: { en: "x", "zh-CN": "x" },
      platforms: "any",
      mutation: "read",
      imAccess: "always",
      mcpToolName: "fallback_test",
      inputSchema: z.object({ x: z.string() }),
      execute,
    })

    const response = await handlePluginToolExec(
      makeRequest({ name: "fallback_test", args: { x: "y" } })
    )

    expect(execute).toHaveBeenCalledWith({ x: "y" }, expect.anything())
    expect(response).toEqual(
      expect.objectContaining({
        type: "plugin_tool_response",
        sessionId: "session-1",
        toolUseId: "use-1",
        result: { status: "ok", data: { events: [] } },
      })
    )
  })

  it("passes the HYDRATED session context (imBinding + override) to the dispatcher (W2)", async () => {
    __setPluginToolResolverForTesting({ getTool: () => undefined })
    const imBinding = {
      adapterId: "lark-1",
      platform: "lark" as const,
      conversationKey: "lark:lark-1:oc_1",
    }
    mockResolveSkillContext.mockResolvedValueOnce({
      sessionId: "session-1",
      imBinding,
      imOverrideRow: { requireHitlForWrites: true },
    } as never)

    const { registerBuiltInSkill } = await import("@/lib/skills/built-in/registry")
    const { z } = await import("zod")
    const execute = jest.fn().mockResolvedValue({ ok: true })
    registerBuiltInSkill({
      id: "fallback.hydrated",
      family: "fallback",
      label: { en: "x", "zh-CN": "x" },
      description: { en: "x", "zh-CN": "x" },
      platforms: "any",
      mutation: "read",
      imAccess: "always",
      mcpToolName: "fallback_hydrated",
      inputSchema: z.object({}),
      execute,
    })

    await handlePluginToolExec(makeRequest({ name: "fallback_hydrated", args: {} }))

    expect(mockResolveSkillContext).toHaveBeenCalledWith("session-1")
    // The dispatcher receives the IM binding — the gates (imAccess /
    // allowlist / HITL) can no longer be bypassed by the tool-call path.
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sessionId: "session-1", imBinding })
    )
  })

  it("returns plugin tool not found when neither registry matches", async () => {
    __setPluginToolResolverForTesting({ getTool: () => undefined })

    const response = await handlePluginToolExec(makeRequest({ name: "no_such_tool" }))
    expect(response.error).toBe("plugin tool not found: no_such_tool")
  })
})

// ── Wave 1 — Terminal dock fallback ──────────────────────────────────
describe("handlePluginToolExec — terminal-dock fallback", () => {
  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    __setPluginToolResolverForTesting(null)
  })

  it("routes terminal_dock_* names to the dock-tool-handler", async () => {
    // Plugin resolver misses + built-in skill registry empty → terminal-dock path.
    __setPluginToolResolverForTesting({ getTool: () => undefined })
    const runTerminalDockAction = jest.fn().mockResolvedValue({
      ok: true,
      sessionId: "tab-1",
      exitCode: 0,
      output: "ls",
    })
    jest.doMock("@/lib/terminal/dock-tool-handler", () => ({ runTerminalDockAction }))

    const { handlePluginToolExec: freshHandle, __setPluginToolResolverForTesting: freshSet } =
      await import("./plugin-tool-ipc")
    freshSet({ getTool: () => undefined })

    const response = await freshHandle({
      type: "plugin_tool_exec",
      sessionId: "sess-X",
      toolUseId: "use-X",
      name: "terminal_dock_write",
      args: { tabId: "tab-1", command: "ls" },
    })

    expect(runTerminalDockAction).toHaveBeenCalledWith({
      action: "write",
      args: { tabId: "tab-1", command: "ls" },
      chatSessionId: "sess-X",
    })
    expect(response.result).toEqual({
      ok: true,
      sessionId: "tab-1",
      exitCode: 0,
      output: "ls",
    })
  })
})

describe("handlePluginToolExec — ask_user elicitation", () => {
  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    __setPluginToolResolverForTesting(null)
  })

  it("routes ask_user to the ask-user dialog controller", async () => {
    const runAskUser = jest.fn().mockResolvedValue("Selected: Apple")
    jest.doMock("@/stores/agent/ask-user-store", () => ({ runAskUser }))

    const { handlePluginToolExec: freshHandle, __setPluginToolResolverForTesting: freshSet } =
      await import("./plugin-tool-ipc")
    freshSet({ getTool: () => undefined })

    const response = await freshHandle({
      type: "plugin_tool_exec",
      sessionId: "sess-A",
      toolUseId: "use-A",
      name: "ask_user",
      args: { question: "Pick", options: [{ value: "a", label: "Apple" }] },
    })

    expect(runAskUser).toHaveBeenCalledWith(
      { question: "Pick", options: [{ value: "a", label: "Apple" }] },
      { sessionId: "sess-A" }
    )
    expect(response.result).toBe("Selected: Apple")
    expect(response.error).toBeUndefined()
  })
})

describe("handlePluginToolExec — Skill / SlashCommand built-ins", () => {
  afterEach(() => {
    __setSkillToolDepsForTesting(null)
    __setSlashToolDepsForTesting(null)
  })

  it("routes the Skill tool to the skill resolver, before the plugin registry", async () => {
    const execute = jest.fn()
    __setPluginToolResolverForTesting({ getTool: () => ({ pluginId: "x", execute }) })
    __setSkillToolDepsForTesting(() => ({
      getCatalogSkill: (id) =>
        id === "web-research" ? { id, name: "Web research", content: "Body." } : undefined,
    }))
    const response = await handlePluginToolExec(
      makeRequest({ name: "Skill", args: { name: "web-research" } })
    )
    expect(execute).not.toHaveBeenCalled()
    expect(response.error).toBeUndefined()
    expect(String(response.result)).toContain("Web research")
    __setPluginToolResolverForTesting(null)
  })

  it("threads sessionId into progressive skill loading scope", async () => {
    const scopedSkill: Skill = {
      id: "scoped-skill",
      name: "Scoped",
      slug: "scoped",
      description: "Scoped skill",
      content: "Only this session may load me.",
      createdAt: 0,
      updatedAt: 0,
      source: "custom",
    }
    createSkillLoadContext({
      sessionId: "scope-A",
      allowedSkillIds: [scopedSkill.id],
      getSkill: async (id) => (id === scopedSkill.id ? scopedSkill : undefined),
      listResources: async () => [],
      recordUsage: async () => undefined,
    })
    __setSkillToolDepsForTesting(() => ({
      listSkillResources: async () => [],
      recordSkillUsage: async () => undefined,
    }))

    try {
      const allowed = await handlePluginToolExec(
        makeRequest({
          name: "load_skill",
          args: { skill_id: scopedSkill.id },
          sessionId: "scope-A",
        })
      )
      expect(allowed.result).toMatchObject({ ok: true, skill: { id: scopedSkill.id } })

      const denied = await handlePluginToolExec(
        makeRequest({
          name: "load_skill",
          args: { skill_id: scopedSkill.id },
          sessionId: "scope-B",
        })
      )
      expect(denied.result).toMatchObject({ ok: false, code: "missing_context" })
    } finally {
      releaseSkillLoadContext("scope-A")
    }
  })

  it("routes the SlashCommand tool to the slash dispatcher with the session id", async () => {
    const dispatch = jest.fn().mockResolvedValue({ message: "ran" })
    __setSlashToolDepsForTesting(() => ({ dispatch }))
    const response = await handlePluginToolExec(
      makeRequest({ name: "SlashCommand", args: { command: "/status" }, sessionId: "sess-Z" })
    )
    expect(dispatch).toHaveBeenCalledWith("/status", { sessionId: "sess-Z" })
    expect(response.result).toBe("ran")
    expect(response.error).toBeUndefined()
  })
})

describe("handlePluginToolExec — vector built-ins", () => {
  afterEach(() => {
    __setVectorToolDepsForTesting(null)
    __setPluginToolResolverForTesting(null)
  })

  function makeVectorDeps(overrides: Partial<VectorToolRunDeps> = {}): VectorToolRunDeps {
    return {
      service: {
        search: jest.fn(async () => [{ id: "d1", content: "hit", score: 0.8 }]),
        addDocument: jest.fn(async (_c, input) => ({ id: input.id, createdCollection: true })),
        deleteDocument: jest.fn(async () => ({ deleted: true })),
      },
      resolveProjectId: () => "proj-1",
      hasPermission: () => true,
      newDocumentId: () => "gen-1",
      ...overrides,
    }
  }

  it.each(["vector_search", "vector_add_document", "vector_delete_document"])(
    "routes %s ahead of the plugin registry",
    async (name) => {
      const execute = jest.fn()
      __setPluginToolResolverForTesting({ getTool: () => ({ pluginId: "x", execute }) })
      __setVectorToolDepsForTesting(makeVectorDeps)
      const args =
        name === "vector_search"
          ? { query: "hi" }
          : name === "vector_add_document"
            ? { content: "hi" }
            : { id: "d1" }
      const response = await handlePluginToolExec(makeRequest({ name, args }))
      expect(execute).not.toHaveBeenCalled()
      expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({ ok: true })
    }
  )

  it("passes the session id through so the project is resolved from context", async () => {
    const resolveProjectId = jest.fn(() => "proj-1")
    __setVectorToolDepsForTesting(() => makeVectorDeps({ resolveProjectId }))
    await handlePluginToolExec(
      makeRequest({ name: "vector_search", args: { query: "hi" }, sessionId: "sess-V" })
    )
    expect(resolveProjectId).toHaveBeenCalledWith("sess-V")
  })

  it("scopes the store call to the resolved project's namespace", async () => {
    const deps = makeVectorDeps()
    __setVectorToolDepsForTesting(() => deps)
    await handlePluginToolExec(makeRequest({ name: "vector_search", args: { query: "hi" } }))
    expect(deps.service.search).toHaveBeenCalledWith(
      "project_proj-1__documents",
      "hi",
      expect.anything()
    )
  })

  it("returns a structured refusal (not an error) when a permission is missing", async () => {
    __setVectorToolDepsForTesting(() => makeVectorDeps({ hasPermission: () => false }))
    const response = await handlePluginToolExec(
      makeRequest({ name: "vector_search", args: { query: "hi" } })
    )
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({ ok: false, code: "permission" })
  })

  it("does not claim tool names that merely start with vector_", async () => {
    const execute = jest.fn().mockResolvedValue("from plugin")
    __setPluginToolResolverForTesting({ getTool: () => ({ pluginId: "x", execute }) })
    const response = await handlePluginToolExec(makeRequest({ name: "vector_reindex", args: {} }))
    expect(execute).toHaveBeenCalled()
    expect(response.result).toBe("from plugin")
  })
})

describe("handlePluginToolExec — team-collaboration built-ins", () => {
  it("routes a team tool to the team router when a team-dispatch identity is registered", async () => {
    registerTeamDispatchContext("team-sess", {
      teamId: "team-1",
      teammateId: "tm-a",
      teammateName: "Ada",
    })
    try {
      const response = await handlePluginToolExec(
        makeRequest({ name: TEAM_TOOL_NAMES.listMembers, args: {}, sessionId: "team-sess" })
      )
      expect(response.error).toBeUndefined()
      expect(Array.isArray(response.result)).toBe(true)
    } finally {
      clearTeamDispatchContext("team-sess")
    }
  })

  it("rejects a team tool from a non-team session (no identity)", async () => {
    const response = await handlePluginToolExec(
      makeRequest({
        name: TEAM_TOOL_NAMES.sendMessage,
        args: { content: "hi" },
        sessionId: "plain",
      })
    )
    expect(String(response.result)).toMatch(/only available to a teammate/)
  })
})

describe("handlePluginToolExec — Task alias for dispatch_agent", () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it("routes the Claude Code `Task` name to the dispatch-agent handler", async () => {
    const runDispatchAgentTool = jest.fn().mockResolvedValue("subagent result")
    jest.doMock("@/lib/claude/agents/dispatch-agent-handler", () => ({ runDispatchAgentTool }))

    const { handlePluginToolExec: freshHandle } = await import("./plugin-tool-ipc")
    const response = await freshHandle({
      type: "plugin_tool_exec",
      sessionId: "sess-T",
      toolUseId: "use-T",
      name: "Task",
      args: { subagent_type: "researcher", prompt: "go" },
    })

    expect(runDispatchAgentTool).toHaveBeenCalledWith({
      sessionId: "sess-T",
      args: { subagent_type: "researcher", prompt: "go" },
    })
    expect(response.result).toBe("subagent result")
    expect(response.error).toBeUndefined()
  })
})

// ── resolveWebToolDeps — default (settings-store) resolver ────────────────
describe("resolveWebToolDeps (default resolver)", () => {
  beforeEach(() => {
    __setWebToolDepsForTesting(null) // exercise the real settings-store resolver
    mockClient = { complete: jest.fn() }
    // `clearMocks: true` wipes call history each test; re-assert implementations
    // (and guard against any earlier suite that reset them).
    ;(buildUtilityLlmClient as jest.Mock).mockImplementation(() => mockClient)
    ;(buildFetchExtractor as jest.Mock).mockImplementation(() => async () => "extracted")
    ;(getSearchCache as jest.Mock).mockImplementation(() => ({
      setConfig: jest.fn(),
      get: jest.fn(() => null),
      set: jest.fn(),
    }))
    mockSettings = {
      searchProviders: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } },
      searchMaxResults: 5,
      searchFallbackEnabled: true,
      defaultSearchType: "news",
      defaultSearchDepth: "advanced",
      defaultSearchRecency: "week",
      defaultSearchCountry: "us",
      defaultSearchLanguage: "en",
      defaultIncludeDomains: ["good.test"],
      defaultExcludeDomains: ["bad.test"],
      defaultIncludeAnswer: true,
      defaultIncludeRawContent: true,
      searchCacheEnabled: true,
      searchCacheTTL: 60_000,
      searchCacheMaxEntries: 200,
      sourceVerificationSettings: { enabled: true },
    }
    mockWebSearch.mockClear()
    mockWebFetch.mockClear()
  })
  afterEach(() => __setWebToolDepsForTesting(null))

  // web_search forwards the search deps; web_fetch forwards summarize + cache.
  async function searchDeps(): Promise<Record<string, unknown>> {
    await handlePluginToolExec({
      type: "plugin_tool_exec",
      sessionId: "s",
      toolUseId: "u",
      name: "web_search",
      args: { query: "hi" },
    })
    return mockWebSearch.mock.calls[0][1] as Record<string, unknown>
  }
  async function fetchDeps(): Promise<Record<string, unknown>> {
    await handlePluginToolExec({
      type: "plugin_tool_exec",
      sessionId: "s",
      toolUseId: "u",
      name: "web_fetch",
      args: { url: "https://x.test" },
    })
    return mockWebFetch.mock.calls[0][1] as Record<string, unknown>
  }

  it("forwards the user's search defaults + source verification to web_search", async () => {
    const deps = await searchDeps()
    expect(deps.searchOptions).toMatchObject({
      searchType: "news",
      searchDepth: "advanced",
      recency: "week",
      country: "us",
      language: "en",
      includeDomains: ["good.test"],
      excludeDomains: ["bad.test"],
      includeAnswer: true,
      includeRawContent: true,
    })
    expect(deps.searchCache).toBeDefined()
    expect(deps.sourceVerification).toEqual({ enabled: true })
  })

  it("builds a summarizer + cache for web_fetch from settings", async () => {
    const deps = await fetchDeps()
    expect(typeof deps.summarize).toBe("function")
    expect(deps.cache).toBeDefined()
  })

  it("omits the search cache when the user disabled it", async () => {
    mockSettings.searchCacheEnabled = false
    const deps = await searchDeps()
    expect(deps.searchCache).toBeUndefined()
  })

  it("omits summarize when no utility model resolves", async () => {
    mockClient = null
    const deps = await fetchDeps()
    expect(deps.summarize).toBeUndefined()
  })

  it("yields empty search options when no defaults are configured", async () => {
    // Minimal settings — exercises the absent-field branches of every default.
    mockSettings = {
      searchProviders: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } },
    }
    const deps = await searchDeps()
    expect(deps.searchOptions).toEqual({})
    expect(deps.sourceVerification).toBeUndefined()
    // Cache is on by default (searchCacheEnabled undefined ≠ false).
    expect(deps.searchCache).toBeDefined()
  })
})
