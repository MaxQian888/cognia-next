import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginContext, PluginHooksAll } from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import definition, {
  COMMAND_ID,
  DRIFT_HANDLER,
  GovernanceView,
  manifest,
  OPEN_COMMAND_ID,
  VIEW_CONTAINER_ID,
} from "./index"
import { GOVERNANCE_PROMPTS } from "./prompts"
import { getActiveRuntime } from "./runtime/active"
import { ADHERENCE_TOOL, GOVERNANCE_SKILL, REPORT_TOOL } from "./skill"

function context() {
  const disposers: Array<() => void | Promise<void>> = []
  const storage = new Map<string, unknown>()
  const handlers = new Map<string, () => Promise<unknown>>()
  const configListeners: Array<() => void> = []
  const ctx = {
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => disposers.push(dispose),
    },
    agentConfig: {
      listSurfaces: jest.fn(async () => ({ workspaceId: null, surfaces: [], failed: [] })),
      readFacts: jest.fn(),
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
    },
    ai: { chat: jest.fn(), getDefaultModel: () => "m" },
    session: {
      listSessions: jest.fn(async () => []),
      getMessages: jest.fn(async () => []),
      getSession: jest.fn(async () => ({ projectId: "w" })),
    },
    project: { listProjects: jest.fn(async () => []), getCurrentProjectId: () => null },
    prompts: {
      register: jest.fn(() => ({ promptIds: [], unregister: jest.fn() })),
      resolve: jest.fn(async (id: string) => ({ text: `text:${id}`, source: "default" })),
    },
    eval: { runDataset: jest.fn(), listDatasets: jest.fn(async () => []) },
    agent: { registerTool: jest.fn() },
    scheduler: {
      registerHandler: jest.fn((name: string, handler: () => Promise<unknown>) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      }),
    },
    configuration: {
      getOrDefault: (_key: string, fallback: unknown) => fallback,
      onChange: jest.fn((listener: () => void) => {
        configListeners.push(listener)
        return () => {}
      }),
    },
    ui: {
      openViewContainer: jest.fn(async () => {}),
      showNotification: jest.fn(),
      navigate: jest.fn(),
    },
    i18n: { t: (key: string) => key },
    logger: { warn: jest.fn() },
  }
  return { ctx, disposers, handlers, configListeners }
}

describe("config-governance plugin", () => {
  it("ships a valid manifest with its skill and every surface declared", () => {
    expect(validatePluginManifest(manifestJson).errors).toEqual([])
    expect(manifest.skills).toEqual([GOVERNANCE_SKILL])
    expect(definition.manifest).toBe(manifest)
    expect(manifestJson.tools.map((tool) => tool.name)).toEqual([REPORT_TOOL, ADHERENCE_TOOL])
    expect(manifestJson.viewsContainers[0]!.id).toBe(VIEW_CONTAINER_ID)
    expect(manifestJson.views[0]).toMatchObject({
      containerId: VIEW_CONTAINER_ID,
      entry: manifestJson.main,
      export: "GovernanceView",
    })
    expect(typeof GovernanceView).toBe("function")
    expect(manifestJson.scheduledTasks[0]).toMatchObject({
      handler: DRIFT_HANDLER,
      defaultEnabled: false,
    })
    expect(manifestJson.quickActions[0]!.command).toBe(`${manifestJson.id}.${OPEN_COMMAND_ID}`)
    expect(manifestJson.commands.map((command) => command.id)).toEqual([
      COMMAND_ID,
      OPEN_COMMAND_ID,
    ])
    expect(manifestJson.permissions).toContain("hooks:chat-intercept")
  })

  it("has the same keys in both locales", () => {
    const { en, "zh-CN": zh } = manifestJson.i18n.locales as Record<string, Record<string, string>>
    expect(Object.keys(zh!).sort()).toEqual(Object.keys(en!).sort())
  })

  it("activates: prompts, tools, drift handler, enforcement, and hooks; and cleans up on dispose", async () => {
    const { ctx, disposers, handlers, configListeners } = context()
    const hooks = (await definition.activate(ctx as unknown as PluginContext)) as PluginHooksAll
    expect(ctx.prompts.register).toHaveBeenCalledWith(GOVERNANCE_PROMPTS)
    expect(ctx.agent.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      REPORT_TOOL,
      ADHERENCE_TOOL,
    ])
    expect(getActiveRuntime()).not.toBeNull()

    await expect(handlers.get(DRIFT_HANDLER)!()).resolves.toEqual({
      success: true,
      output: { workspaces: 0, changed: 0, newHigh: 0 },
      metrics: { itemsProcessed: 0 },
    })
    configListeners[0]!()

    expect(await hooks.onCommand!(OPEN_COMMAND_ID, [], {})).toBe(true)
    expect(ctx.ui.openViewContainer).toHaveBeenCalledWith(VIEW_CONTAINER_ID)
    expect(await hooks.onCommand!("other", [], {})).toBe(false)
    expect(await hooks.onCommand!(COMMAND_ID, ["nope"], {})).toEqual({
      handled: true,
      message: "slash.usage",
    })

    expect(hooks.onUserPromptSubmit!("hi", "s", {} as never)).toEqual({ action: "proceed" })
    expect(await hooks.onPreToolUse!("bash", { command: "git push --force" }, "s")).toEqual({
      action: "allow",
    })
    expect(await hooks.onPostToolUse!("bash", { command: "ls" }, "out", "s")).toEqual({})

    for (const dispose of disposers.reverse()) await dispose()
    expect(getActiveRuntime()).toBeNull()
    expect(handlers.has(DRIFT_HANDLER)).toBe(false)
  })

  it("fails open when enforcement throws", async () => {
    const { ctx, disposers } = context()
    const hooks = (await definition.activate(ctx as unknown as PluginContext)) as PluginHooksAll
    const runtime = getActiveRuntime()!
    jest.spyOn(runtime, "preToolUse").mockRejectedValueOnce(new Error("x"))
    jest.spyOn(runtime, "postToolUse").mockRejectedValueOnce(new Error("x"))
    expect(await hooks.onPreToolUse!("bash", {}, "s")).toEqual({ action: "allow" })
    expect(await hooks.onPostToolUse!("bash", {}, "r", "s")).toEqual({})
    jest.spyOn(runtime, "preToolUse").mockResolvedValueOnce("blocked")
    expect(await hooks.onPreToolUse!("bash", {}, "s")).toEqual({
      action: "deny",
      denyReason: "blocked",
    })
    jest.spyOn(runtime, "postToolUse").mockResolvedValueOnce("with reminder")
    expect(await hooks.onPostToolUse!("bash", {}, "r", "s")).toEqual({
      modifiedResult: "with reminder",
    })
    for (const dispose of disposers.reverse()) await dispose()
  })
})
