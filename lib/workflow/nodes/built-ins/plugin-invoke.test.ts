/**
 * @jest-environment jsdom
 *
 * Tests for the `action.plugin.invoke` executor — both dispatch modes:
 *  - "tool": plugin agent tools via the unified `invokePluginTool` seam
 *  - "task": legacy `workflow.task` extension path (ADR-0017)
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(async (pluginId: string) =>
    pluginId === "plug-a"
      ? {
          id: "plug-a",
          name: "Plugin A",
          version: "1.0.0",
          status: "enabled",
          source: "builtin",
          type: "frontend",
          enabled: true,
          capabilities: ["tools"],
          path: "builtin://plug-a",
          manifest: { id: "plug-a", version: "1.0.0", permissions: [] },
          createdAt: 1,
          updatedAt: 1,
        }
      : undefined
  ),
}))

// Importing built-ins triggers their side-effecting registrations.
import "."
import { getExecutor } from "../registry"
import {
  __setInvokePluginToolDepsForTesting,
  type InvokePluginToolDeps,
} from "@/lib/plugin/core/invoke-plugin-tool"
import type {
  StepExecutionContext,
  StepExecutionResult,
  TriggerEvent,
} from "@/types/workflow/visual"
import { workflowVersionDigest } from "@/lib/workflow/versioning/version-snapshot"

const trigger: TriggerEvent = {
  workflowId: "wf",
  kind: "trigger.manual",
  payload: {},
  originAt: 1_700_000_000,
}

function makeCtx(
  params: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal
): StepExecutionContext<Record<string, unknown>> {
  return {
    runId: "run_test",
    workflowId: "wf",
    stepId: "n_plugin",
    params,
    upstream: {},
    trigger,
    signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext<Record<string, unknown>>
}

async function exec(params: Record<string, unknown>, signal?: AbortSignal) {
  const reg = getExecutor("action.plugin.invoke", 1)
  if (!reg) throw new Error("action.plugin.invoke not registered")
  return reg.execute(makeCtx(params, signal))
}

function makeSeamDeps(overrides?: {
  status?: string
  execute?: jest.Mock
  toolName?: string
}): InvokePluginToolDeps & { execute: jest.Mock } {
  const execute = overrides?.execute ?? jest.fn().mockResolvedValue({ rows: 3 })
  const toolName = overrides?.toolName ?? "demo_tool"
  return {
    execute,
    getManager: () => ({
      getPlugin: (pluginId: string) =>
        pluginId === "plug-a"
          ? {
              status: overrides?.status ?? "enabled",
              config: {},
              manifest: { permissions: [] },
            }
          : undefined,
      getRegistry: () => ({
        getTool: (name: string) =>
          name === toolName
            ? {
                name: toolName,
                pluginId: "plug-a",
                definition: { name: toolName, description: "d", parametersSchema: {} },
                execute,
              }
            : undefined,
      }),
      handleActivationEvent: async () => {},
    }),
    getGuard: () => ({
      getTier: () => "silent" as const,
      checkWithConsent: async () => true,
    }),
    getBroker: () => ({ request: async () => true }),
    resolveSandboxRuntimeRef: () => undefined,
  }
}

describe("action.plugin.invoke — tool mode", () => {
  afterEach(() => {
    __setInvokePluginToolDepsForTesting(null)
  })

  it("rejects plugin drift from an immutable release lock", async () => {
    const reg = getExecutor("action.plugin.invoke", 1)
    if (!reg) throw new Error("action.plugin.invoke not registered")
    const manifest = { id: "plug-a", version: "1.0.0", permissions: [] }
    const ctx = makeCtx({ pluginId: "plug-a", mode: "tool", toolName: "demo_tool" })
    ctx.executionBinding = {
      versionId: "version-1",
      deploymentId: "deployment-1",
      deploymentRevision: 1,
      entrypoint: "portal",
      caller: "portal",
      dependencyLock: {
        workflows: {},
        indexes: {},
        plugins: {
          "plug-a": {
            pluginId: "plug-a",
            version: "2.0.0",
            manifestDigest: workflowVersionDigest(manifest),
            capabilities: ["tools"],
            runtimeProfile: "headless",
          },
        },
      },
    }

    await expect(reg.execute(ctx)).rejects.toMatchObject({
      code: "plugin-version-drift",
      retryable: false,
    })
  })

  it("invokes a plugin tool through the seam and wraps the result", async () => {
    const deps = makeSeamDeps()
    __setInvokePluginToolDepsForTesting(deps)

    const r: StepExecutionResult = await exec({
      pluginId: "plug-a",
      mode: "tool",
      toolName: "demo_tool",
      args: { q: "x" },
    })

    expect(r.output).toEqual({
      pluginId: "plug-a",
      toolName: "demo_tool",
      ok: true,
      data: { rows: 3 },
    })
    expect(deps.execute).toHaveBeenCalledWith({ q: "x" }, expect.anything())
  })

  it("infers tool mode from a bare toolName (no mode discriminator)", async () => {
    const deps = makeSeamDeps()
    __setInvokePluginToolDepsForTesting(deps)

    const r = await exec({ pluginId: "plug-a", toolName: "demo_tool" })

    expect((r.output as { toolName: string }).toolName).toBe("demo_tool")
    expect(deps.execute).toHaveBeenCalled()
  })

  it("threads the step's AbortSignal into the tool context", async () => {
    const deps = makeSeamDeps()
    __setInvokePluginToolDepsForTesting(deps)
    const controller = new AbortController()

    await exec({ pluginId: "plug-a", mode: "tool", toolName: "demo_tool" }, controller.signal)

    expect(deps.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal })
    )
  })

  it("fails non-retryably when toolName is missing in tool mode", async () => {
    await expect(exec({ pluginId: "plug-a", mode: "tool" })).rejects.toMatchObject({
      message: expect.stringContaining("requires 'toolName'"),
      retryable: false,
    })
  })

  it("maps tool-not-found seam errors to a non-retryable failure", async () => {
    __setInvokePluginToolDepsForTesting(makeSeamDeps())

    await expect(
      exec({ pluginId: "plug-a", mode: "tool", toolName: "missing_tool" })
    ).rejects.toMatchObject({
      message: expect.stringContaining("no registered tool"),
      retryable: false,
    })
  })

  it("maps plugin-disabled seam errors to a non-retryable failure", async () => {
    __setInvokePluginToolDepsForTesting(makeSeamDeps({ status: "disabled" }))

    await expect(
      exec({ pluginId: "plug-a", mode: "tool", toolName: "demo_tool" })
    ).rejects.toMatchObject({
      message: expect.stringContaining("not enabled"),
      retryable: false,
    })
  })

  it("leaves execution failures retryable", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("transient upstream"))
    __setInvokePluginToolDepsForTesting(makeSeamDeps({ execute }))

    await expect(
      exec({ pluginId: "plug-a", mode: "tool", toolName: "demo_tool" })
    ).rejects.toMatchObject({
      message: "transient upstream",
    })
    // The nonRetryable flag must NOT be set on runtime failures.
    const rejection = await exec({
      pluginId: "plug-a",
      mode: "tool",
      toolName: "demo_tool",
    }).catch((err: Error & { retryable?: boolean }) => err)
    expect((rejection as { retryable?: boolean }).retryable).toBeUndefined()
  })

  it("fails non-retryably when pluginId is missing", async () => {
    await expect(exec({ mode: "tool", toolName: "demo_tool" })).rejects.toMatchObject({
      message: expect.stringContaining("requires 'pluginId'"),
      retryable: false,
    })
  })
})

describe("action.plugin.invoke — legacy task mode", () => {
  it("keeps requiring taskId when no toolName is present", async () => {
    await expect(exec({ pluginId: "plug-a" })).rejects.toMatchObject({
      message: expect.stringContaining("requires 'taskId'"),
      retryable: false,
    })
  })

  it("fails non-retryably when the plugin is unknown in the db", async () => {
    // No plugin rows seeded in fake-indexeddb → getPlugin resolves undefined.
    await expect(exec({ pluginId: "ghost", taskId: "t1" })).rejects.toMatchObject({
      message: expect.stringContaining("plugin ghost not found"),
      retryable: false,
    })
  })
})
