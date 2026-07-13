/**
 * Tests for the unified plugin-tool invocation seam.
 *
 * Deps are injected via `__setInvokePluginToolDepsForTesting` so the suite
 * never touches the real manager/guard/broker singletons (which throw or
 * hit Dexie in jsdom).
 */

import type { PluginPermission, PluginResilienceConfig, PluginTool } from "@/types/plugin"

import { __resetRegistryForTesting } from "@/lib/plugin/resilience/breaker-registry"

import {
  __setInvokePluginToolDepsForTesting,
  invokePluginTool,
  PluginToolInvocationError,
  resolvePluginToolByName,
  type InvokePluginToolDeps,
} from "./invoke-plugin-tool"

type Tier = "silent" | "confirm" | "forbid"

interface FakePluginState {
  status: string
  config?: Record<string, unknown>
  permissions?: PluginPermission[]
  resilience?: PluginResilienceConfig
}

interface DepsConfig {
  plugins?: Record<string, FakePluginState>
  tools?: PluginTool[]
  tiers?: Partial<Record<PluginPermission, Tier>>
  /** Broker answer for confirm-tier prompts. Default true. */
  consentAnswer?: boolean
  /** Called on handleActivationEvent — lets a test flip a plugin's status. */
  onActivationEvent?: (event: string) => void
}

function makeTool(overrides?: Partial<PluginTool>): PluginTool {
  return {
    name: "demo_tool",
    pluginId: "plug-a",
    definition: {
      name: "demo_tool",
      description: "demo",
      parametersSchema: { type: "object" },
    },
    execute: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

function makeDeps(config: DepsConfig = {}): InvokePluginToolDeps & {
  activationEvents: string[]
  consentRequests: Array<{ pluginId: string; permission: PluginPermission; reason?: string }>
  toolUseRefreshes: string[]
} {
  const plugins: Record<string, FakePluginState> = config.plugins ?? {
    "plug-a": { status: "enabled", config: { apiKey: "secret" } },
  }
  const tools = config.tools ?? [makeTool()]
  const activationEvents: string[] = []
  const toolUseRefreshes: string[] = []
  const consentRequests: Array<{
    pluginId: string
    permission: PluginPermission
    reason?: string
  }> = []

  const broker = {
    request: async (req: { pluginId: string; permission: PluginPermission; reason?: string }) => {
      consentRequests.push(req)
      return config.consentAnswer ?? true
    },
  }

  return {
    activationEvents,
    consentRequests,
    toolUseRefreshes,
    getManager: () => ({
      getPlugin: (pluginId: string) => {
        const state = plugins[pluginId]
        if (!state) return undefined
        return {
          status: state.status,
          config: state.config,
          manifest: { permissions: state.permissions, resilience: state.resilience },
        }
      },
      getRegistry: () => ({
        getTool: (name: string) => tools.find((t) => t.name === name),
      }),
      handleActivationEvent: async (event: `onTool:${string}`) => {
        activationEvents.push(event)
        config.onActivationEvent?.(event)
      },
      recordPluginToolUse: (pluginId: string) => {
        toolUseRefreshes.push(pluginId)
      },
    }),
    getGuard: () => ({
      getTier: (_pluginId: string, permission: PluginPermission) =>
        config.tiers?.[permission] ?? "silent",
      checkWithConsent: async (
        pluginId: string,
        permission: PluginPermission,
        b: typeof broker,
        options?: { reason?: string; context?: string }
      ) => {
        const tier = config.tiers?.[permission] ?? "silent"
        if (tier === "forbid") return false
        if (tier === "silent") return true
        return b.request({ pluginId, permission, reason: options?.reason })
      },
    }),
    getBroker: () => broker,
  }
}

async function expectInvocationError(
  promise: Promise<unknown>,
  code: PluginToolInvocationError["code"]
): Promise<PluginToolInvocationError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(PluginToolInvocationError)
    const typed = err as PluginToolInvocationError
    expect(typed.code).toBe(code)
    return typed
  }
  throw new Error(`expected PluginToolInvocationError(${code}) but the promise resolved`)
}

describe("resolvePluginToolByName", () => {
  afterEach(() => {
    __setInvokePluginToolDepsForTesting(null)
  })

  it("resolves the owning plugin id for a registered bare name", async () => {
    __setInvokePluginToolDepsForTesting(makeDeps())

    await expect(resolvePluginToolByName("demo_tool")).resolves.toEqual({ pluginId: "plug-a" })
  })

  it("returns undefined for an unknown name", async () => {
    __setInvokePluginToolDepsForTesting(makeDeps())

    await expect(resolvePluginToolByName("nope")).resolves.toBeUndefined()
  })

  it("returns undefined when the manager is unavailable", async () => {
    __setInvokePluginToolDepsForTesting({
      ...makeDeps(),
      getManager: () => {
        throw new Error("not initialised")
      },
    })

    await expect(resolvePluginToolByName("demo_tool")).resolves.toBeUndefined()
  })
})

describe("invokePluginTool", () => {
  afterEach(() => {
    __setInvokePluginToolDepsForTesting(null)
    __resetRegistryForTesting()
  })

  it("executes the tool and returns the result with identity echo", async () => {
    const execute = jest.fn().mockResolvedValue({ answer: 42 })
    const deps = makeDeps({ tools: [makeTool({ execute })] })
    __setInvokePluginToolDepsForTesting(deps)

    const outcome = await invokePluginTool("plug-a", "demo_tool", { q: "x" })

    expect(outcome).toEqual({ result: { answer: 42 }, pluginId: "plug-a", toolName: "demo_tool" })
    expect(execute).toHaveBeenCalledWith(
      { q: "x" },
      expect.objectContaining({ config: { apiKey: "secret" } })
    )
    // Tool use refreshes the idle-suspend clock so the plugin isn't suspended mid-run.
    expect(deps.toolUseRefreshes).toEqual(["plug-a"])
  })

  it("does not refresh the idle clock when the plugin is disabled (throws before use)", async () => {
    const deps = makeDeps({ plugins: { "plug-a": { status: "disabled" } } })
    __setInvokePluginToolDepsForTesting(deps)
    await expectInvocationError(
      invokePluginTool("plug-a", "demo_tool", {}, { autoActivate: false }),
      "plugin-disabled"
    )
    expect(deps.toolUseRefreshes).toEqual([])
  })

  it("threads sessionId, messageId, and the AbortSignal into the tool context", async () => {
    const execute = jest.fn().mockResolvedValue("ok")
    __setInvokePluginToolDepsForTesting(makeDeps({ tools: [makeTool({ execute })] }))
    const controller = new AbortController()

    await invokePluginTool(
      "plug-a",
      "demo_tool",
      {},
      { signal: controller.signal, sessionId: "sess-1", messageId: "msg-1" }
    )

    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: "sess-1",
        messageId: "msg-1",
        signal: controller.signal,
      })
    )
  })

  it("defaults config to {} when the plugin has none", async () => {
    const execute = jest.fn().mockResolvedValue("ok")
    __setInvokePluginToolDepsForTesting(
      makeDeps({
        plugins: { "plug-a": { status: "enabled" } },
        tools: [makeTool({ execute })],
      })
    )

    await invokePluginTool("plug-a", "demo_tool", {})

    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ config: {} }))
  })

  it("throws aborted before resolving anything when the signal is already aborted", async () => {
    const deps = makeDeps()
    __setInvokePluginToolDepsForTesting(deps)
    const controller = new AbortController()
    controller.abort()

    await expectInvocationError(
      invokePluginTool("plug-a", "demo_tool", {}, { signal: controller.signal }),
      "aborted"
    )
    expect(deps.activationEvents).toEqual([])
  })

  it("throws plugin-not-found for an unknown plugin id", async () => {
    __setInvokePluginToolDepsForTesting(makeDeps())

    const err = await expectInvocationError(
      invokePluginTool("nope", "demo_tool", {}),
      "plugin-not-found"
    )
    expect(err.pluginId).toBe("nope")
  })

  it("throws plugin-not-found when the manager singleton is unavailable", async () => {
    const deps = makeDeps()
    __setInvokePluginToolDepsForTesting({
      ...deps,
      getManager: () => {
        throw new Error("Plugin manager not initialized")
      },
    })

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "plugin-not-found")
  })

  it("lazy-activates a disabled plugin via onTool:<name> and then executes", async () => {
    const execute = jest.fn().mockResolvedValue("late")
    const plugins: Record<string, FakePluginState> = {
      "plug-a": { status: "disabled" },
    }
    const deps = makeDeps({
      plugins,
      tools: [makeTool({ execute })],
      onActivationEvent: () => {
        plugins["plug-a"].status = "enabled"
      },
    })
    __setInvokePluginToolDepsForTesting(deps)

    const outcome = await invokePluginTool("plug-a", "demo_tool", {})

    expect(deps.activationEvents).toEqual(["onTool:demo_tool"])
    expect(outcome.result).toBe("late")
  })

  it("throws plugin-disabled when activation does not enable the plugin", async () => {
    const deps = makeDeps({ plugins: { "plug-a": { status: "disabled" } } })
    __setInvokePluginToolDepsForTesting(deps)

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "plugin-disabled")
    expect(deps.activationEvents).toEqual(["onTool:demo_tool"])
  })

  it("does not attempt activation when autoActivate is false", async () => {
    const deps = makeDeps({ plugins: { "plug-a": { status: "disabled" } } })
    __setInvokePluginToolDepsForTesting(deps)

    await expectInvocationError(
      invokePluginTool("plug-a", "demo_tool", {}, { autoActivate: false }),
      "plugin-disabled"
    )
    expect(deps.activationEvents).toEqual([])
  })

  it("skips activation entirely for an already-enabled plugin", async () => {
    const deps = makeDeps()
    __setInvokePluginToolDepsForTesting(deps)

    await invokePluginTool("plug-a", "demo_tool", {})

    expect(deps.activationEvents).toEqual([])
  })

  it("throws tool-not-found for a missing tool", async () => {
    __setInvokePluginToolDepsForTesting(makeDeps({ tools: [] }))

    await expectInvocationError(invokePluginTool("plug-a", "missing", {}), "tool-not-found")
  })

  it("throws tool-not-found when the registry entry belongs to a different plugin", async () => {
    __setInvokePluginToolDepsForTesting(
      makeDeps({
        plugins: {
          "plug-a": { status: "enabled" },
          "plug-b": { status: "enabled" },
        },
        tools: [makeTool({ pluginId: "plug-b" })],
      })
    )

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "tool-not-found")
  })

  it("executes without prompting when all declared permissions are silent tier", async () => {
    const deps = makeDeps({
      plugins: {
        "plug-a": {
          status: "enabled",
          permissions: ["network:fetch", "clipboard:read"],
        },
      },
    })
    __setInvokePluginToolDepsForTesting(deps)

    await invokePluginTool("plug-a", "demo_tool", {})

    expect(deps.consentRequests).toEqual([])
  })

  it("routes confirm-tier permissions through the broker and proceeds on grant", async () => {
    const deps = makeDeps({
      plugins: {
        "plug-a": { status: "enabled", permissions: ["shell:execute"] },
      },
      tiers: { "shell:execute": "confirm" },
      consentAnswer: true,
    })
    __setInvokePluginToolDepsForTesting(deps)

    const outcome = await invokePluginTool("plug-a", "demo_tool", {}, { reason: "workflow run" })

    expect(outcome.result).toEqual({ ok: true })
    expect(deps.consentRequests).toEqual([
      { pluginId: "plug-a", permission: "shell:execute", reason: "workflow run" },
    ])
  })

  it("throws permission-denied when the broker rejects a confirm-tier permission", async () => {
    const deps = makeDeps({
      plugins: {
        "plug-a": { status: "enabled", permissions: ["shell:execute"] },
      },
      tiers: { "shell:execute": "confirm" },
      consentAnswer: false,
    })
    __setInvokePluginToolDepsForTesting(deps)

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "permission-denied")
  })

  it("throws permission-denied for forbid-tier permissions without prompting", async () => {
    const deps = makeDeps({
      plugins: {
        "plug-a": { status: "enabled", permissions: ["automation:click"] },
      },
      tiers: { "automation:click": "forbid" },
    })
    __setInvokePluginToolDepsForTesting(deps)

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "permission-denied")
    expect(deps.consentRequests).toEqual([])
  })

  it("maps execute() rejections to execution-failed and preserves the cause", async () => {
    const boom = new Error("tool blew up")
    const execute = jest.fn().mockRejectedValue(boom)
    __setInvokePluginToolDepsForTesting(makeDeps({ tools: [makeTool({ execute })] }))

    const err = await expectInvocationError(
      invokePluginTool("plug-a", "demo_tool", {}),
      "execution-failed"
    )
    expect(err.message).toBe("tool blew up")
    expect(err.cause).toBe(boom)
  })

  it("maps an execute() rejection to aborted when the signal aborted mid-flight", async () => {
    const controller = new AbortController()
    const execute = jest.fn().mockImplementation(async (_args, context) => {
      controller.abort()
      const signal = (context as { signal?: AbortSignal }).signal
      throw signal?.reason ?? new Error("aborted mid-flight")
    })
    __setInvokePluginToolDepsForTesting(makeDeps({ tools: [makeTool({ execute })] }))

    await expectInvocationError(
      invokePluginTool("plug-a", "demo_tool", {}, { signal: controller.signal }),
      "aborted"
    )
  })

  it("falls back to the dynamic-import default deps when no override is set", async () => {
    // No override: the real manager singleton is uninitialised in jsdom,
    // which must surface as plugin-not-found (not an unhandled throw).
    __setInvokePluginToolDepsForTesting(null)

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "plugin-not-found")
  })

  it("coerces non-Error execute() rejections into the error message", async () => {
    const execute = jest.fn().mockRejectedValue("plain failure")
    __setInvokePluginToolDepsForTesting(makeDeps({ tools: [makeTool({ execute })] }))

    const err = await expectInvocationError(
      invokePluginTool("plug-a", "demo_tool", {}),
      "execution-failed"
    )
    expect(err.message).toBe("plain failure")
  })

  // ── Resilience integration ─────────────────────────────────────────────

  it("opens the circuit after repeated failures and then rejects with circuit-open", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("ECONNRESET"))
    __setInvokePluginToolDepsForTesting(
      makeDeps({
        plugins: {
          "plug-a": {
            status: "enabled",
            resilience: { breaker: { failureThreshold: 2 } },
          },
        },
        tools: [makeTool({ execute })],
      })
    )

    // Two failing attempts trip the breaker (failureThreshold: 2).
    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "execution-failed")
    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "execution-failed")
    // Third call is rejected by the open breaker without executing.
    expect(execute).toHaveBeenCalledTimes(2)
    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "circuit-open")
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("maps a per-attempt timeout to the timeout error code", async () => {
    // A tool that never settles; a tiny timeout forces withTimeout to fire.
    const execute = jest.fn().mockImplementation(() => new Promise(() => {}))
    __setInvokePluginToolDepsForTesting(
      makeDeps({
        plugins: { "plug-a": { status: "enabled", resilience: { timeoutMs: 10 } } },
        tools: [makeTool({ execute })],
      })
    )

    await expectInvocationError(invokePluginTool("plug-a", "demo_tool", {}), "timeout")
  })

  it("retries a transient failure then succeeds when the tool opts into retry", async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true })
    __setInvokePluginToolDepsForTesting(
      makeDeps({
        plugins: {
          "plug-a": { status: "enabled", resilience: { retryable: true, maxRetries: 1 } },
        },
        tools: [makeTool({ execute })],
      })
    )

    const outcome = await invokePluginTool("plug-a", "demo_tool", {})
    expect(outcome.result).toEqual({ ok: true })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("does not re-run the permission consent gate on a retry", async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("done")
    const deps = makeDeps({
      plugins: {
        "plug-a": {
          status: "enabled",
          permissions: ["shell:execute"],
          resilience: { retryable: true, maxRetries: 1 },
        },
      },
      tiers: { "shell:execute": "confirm" },
      consentAnswer: true,
      tools: [makeTool({ execute })],
    })
    __setInvokePluginToolDepsForTesting(deps)

    await invokePluginTool("plug-a", "demo_tool", {}, { reason: "run" })

    expect(execute).toHaveBeenCalledTimes(2)
    // Consent prompted exactly once despite the retry.
    expect(deps.consentRequests).toHaveLength(1)
  })

  it("threads a per-attempt signal (not the raw caller signal) into the tool", async () => {
    let receivedSignal: AbortSignal | undefined
    const execute = jest.fn().mockImplementation(async (_args, context) => {
      receivedSignal = (context as { signal?: AbortSignal }).signal
      return "ok"
    })
    __setInvokePluginToolDepsForTesting(makeDeps({ tools: [makeTool({ execute })] }))

    await invokePluginTool("plug-a", "demo_tool", {})
    // A signal is always provided to the tool, even with no caller signal.
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })
})
