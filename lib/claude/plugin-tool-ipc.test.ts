/**
 * Tests for plugin-tool-ipc.ts
 * Renderer-side IPC handler for `plugin_tool_exec` events from the sidecar.
 */

import {
  __setPluginToolResolverForTesting,
  __setWebToolDepsForTesting,
  handlePluginToolExec,
  type PluginToolExecRequest,
  type PluginToolResolver,
} from "./plugin-tool-ipc"

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
