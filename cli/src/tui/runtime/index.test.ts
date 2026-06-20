/**
 * @jest-environment node
 */
import { runRuntimeRequest, type RuntimeImpl } from "./index"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { RuntimeRequest } from "../commands/types"
import type { TuiAction } from "../state/types"

function harness() {
  const calls: { name: string; arg?: string }[] = []
  const make =
    (name: string, hasArg: boolean) =>
    (...args: unknown[]) => {
      calls.push({ name, ...(hasArg ? { arg: args[0] as string } : {}) })
      return Promise.resolve()
    }
  const impl = {
    workflowList: make("workflowList", false),
    workflowRun: make("workflowRun", true),
    workflowInspect: make("workflowInspect", true),
    workflowRuns: make("workflowRuns", true),
    workflowReplay: make("workflowReplay", true),
    copilotCreate: make("copilotCreate", true),
    copilotEdit: make("copilotEdit", true),
    copilotApply: make("copilotApply", true),
    copilotDiscard: make("copilotDiscard", true),
    copilotSave: make("copilotSave", true),
    copilotExit: make("copilotExit", true),
    agentsList: make("agentsList", false),
    agentsDispatch: make("agentsDispatch", true),
    teamList: make("teamList", false),
    teamShow: make("teamShow", true),
    teamRunUnavailable: make("teamRunUnavailable", false),
    memoryList: make("memoryList", false),
    memoryShow: make("memoryShow", true),
    memoryAdd: make("memoryAdd", true),
    memoryDelete: make("memoryDelete", true),
    goalStart: make("goalStart", true),
    goalStatus: make("goalStatus", false),
    goalPause: make("goalPause", false),
    goalResume: make("goalResume", false),
    goalStop: make("goalStop", false),
    goalList: make("goalList", false),
    mcpList: make("mcpList", false),
    mcpToggle: make("mcpToggle", true),
    mcpSetEnabled: make("mcpSetEnabled", true),
    mcpAdd: make("mcpAdd", true),
    mcpShow: make("mcpShow", true),
    mcpTools: make("mcpTools", true),
    mcpResources: make("mcpResources", true),
    mcpPrompts: make("mcpPrompts", true),
    mcpAuth: make("mcpAuth", true),
    mcpLogout: make("mcpLogout", true),
    mcpPresets: make("mcpPresets", false),
    skillList: make("skillList", false),
    skillShow: make("skillShow", true),
    skillToggle: make("skillToggle", true),
    skillSetEnabled: make("skillSetEnabled", true),
    pluginList: make("pluginList", false),
    pluginShow: make("pluginShow", true),
    pluginTools: make("pluginTools", true),
    pluginSetEnabled: make("pluginSetEnabled", true),
    pluginReload: make("pluginReload", true),
    pluginInstall: make("pluginInstall", true),
    pluginPreview: make("pluginPreview", true),
    pluginUpdate: make("pluginUpdate", true),
    pluginUninstall: make("pluginUninstall", true),
    pluginMarketplace: make("pluginMarketplace", false),
    pluginSourcesList: make("pluginSourcesList", false),
    pluginSourcesAdd: make("pluginSourcesAdd", true),
    pluginSourcesRemove: make("pluginSourcesRemove", true),
    pluginTrustList: make("pluginTrustList", false),
    pluginTrustAdd: make("pluginTrustAdd", true),
    pluginTrustRemove: make("pluginTrustRemove", true),
    exportSession: make("exportSession", true),
    runDoctor: make("runDoctor", false),
    runInit: make("runInit", false),
    permissionsList: make("permissionsList", false),
    permissionsClear: make("permissionsClear", false),
    permissionsRemove: make("permissionsRemove", false),
    runStatus: make("runStatus", false),
    runLimits: make("runLimits", false),
    tasksList: make("tasksList", false),
    tasksShow: make("tasksShow", true),
    tasksPause: make("tasksPause", true),
    tasksResume: make("tasksResume", true),
    planList: make("planList", false),
    planShow: make("planShow", true),
    planDelete: make("planDelete", true),
    planDiff: make("planDiff", true),
  } as unknown as RuntimeImpl
  const actions: TuiAction[] = []
  const deps: import("./index").RuntimeDeps = {
    dispatch: (a: TuiAction) => actions.push(a),
    config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/w" },
    sessionId: "s1",
    signal: new AbortController().signal,
    home: "/home",
    osHome: "/os-home",
    roots: ["/w"],
    version: "0.0.0",
  }
  return { calls, impl, deps, actions }
}

const run = (req: RuntimeRequest, h: ReturnType<typeof harness>) =>
  runRuntimeRequest(req, h.deps, h.impl)

describe("runRuntimeRequest", () => {
  it.each([
    [{ feature: "workflow", action: "list" }, "workflowList"],
    [{ feature: "workflow", action: "run", arg: "w1" }, "workflowRun"],
    [{ feature: "workflow", action: "inspect", arg: "w1" }, "workflowInspect"],
    [{ feature: "workflow", action: "runs", arg: "w1" }, "workflowRuns"],
    [{ feature: "workflow", action: "replay", arg: "r1" }, "workflowReplay"],
    [{ feature: "workflow", action: "create", arg: "demo" }, "copilotCreate"],
    [{ feature: "workflow", action: "edit", arg: "w1" }, "copilotEdit"],
    [{ feature: "workflow", action: "apply", arg: "w1" }, "copilotApply"],
    [{ feature: "workflow", action: "discard", arg: "w1" }, "copilotDiscard"],
    [{ feature: "workflow", action: "save", arg: "w1" }, "copilotSave"],
    [{ feature: "workflow", action: "exit", arg: "w1" }, "copilotExit"],
    [{ feature: "agents", action: "list" }, "agentsList"],
    [{ feature: "agents", action: "run", arg: "rev go" }, "agentsDispatch"],
    [{ feature: "team", action: "list" }, "teamList"],
    [{ feature: "team", action: "show", arg: "t1" }, "teamShow"],
    [{ feature: "team", action: "run" }, "teamRunUnavailable"],
    [{ feature: "memory", action: "list" }, "memoryList"],
    [{ feature: "memory", action: "show", arg: "m1" }, "memoryShow"],
    [{ feature: "memory", action: "add", arg: "a fact" }, "memoryAdd"],
    [{ feature: "memory", action: "delete", arg: "m1" }, "memoryDelete"],
    [{ feature: "goal", action: "start", arg: "ship" }, "goalStart"],
    [{ feature: "goal", action: "status" }, "goalStatus"],
    [{ feature: "goal", action: "pause" }, "goalPause"],
    [{ feature: "goal", action: "resume" }, "goalResume"],
    [{ feature: "goal", action: "stop" }, "goalStop"],
    [{ feature: "goal", action: "list" }, "goalList"],
    [{ feature: "mcp", action: "list" }, "mcpList"],
    [{ feature: "mcp", action: "toggle", arg: "fs" }, "mcpToggle"],
    [{ feature: "mcp", action: "enable", arg: "fs" }, "mcpSetEnabled"],
    [{ feature: "mcp", action: "disable", arg: "fs" }, "mcpSetEnabled"],
    [{ feature: "mcp", action: "add", arg: "--name x" }, "mcpAdd"],
    [{ feature: "mcp", action: "show", arg: "fs" }, "mcpShow"],
    [{ feature: "mcp", action: "tools", arg: "fs" }, "mcpTools"],
    [{ feature: "mcp", action: "resources", arg: "fs" }, "mcpResources"],
    [{ feature: "mcp", action: "prompts", arg: "fs" }, "mcpPrompts"],
    [{ feature: "mcp", action: "auth", arg: "fs" }, "mcpAuth"],
    [{ feature: "mcp", action: "logout", arg: "fs" }, "mcpLogout"],
    [{ feature: "mcp", action: "presets" }, "mcpPresets"],
    [{ feature: "skill", action: "list" }, "skillList"],
    [{ feature: "skill", action: "show", arg: "s1" }, "skillShow"],
    [{ feature: "skill", action: "toggle", arg: "s1" }, "skillToggle"],
    [{ feature: "skill", action: "enable", arg: "s1" }, "skillSetEnabled"],
    [{ feature: "skill", action: "disable", arg: "s1" }, "skillSetEnabled"],
    [{ feature: "plugin", action: "list" }, "pluginList"],
    [{ feature: "plugin", action: "show", arg: "p1" }, "pluginShow"],
    [{ feature: "plugin", action: "tools", arg: "p1" }, "pluginTools"],
    [{ feature: "plugin", action: "enable", arg: "p1" }, "pluginSetEnabled"],
    [{ feature: "plugin", action: "disable", arg: "p1" }, "pluginSetEnabled"],
    [{ feature: "plugin", action: "reload", arg: "p1" }, "pluginReload"],
    [{ feature: "plugin", action: "install", arg: "o/r" }, "pluginInstall"],
    [{ feature: "plugin", action: "preview", arg: "o/r" }, "pluginPreview"],
    [{ feature: "plugin", action: "update", arg: "p1" }, "pluginUpdate"],
    [{ feature: "plugin", action: "update" }, "pluginUpdate"],
    [{ feature: "plugin", action: "uninstall", arg: "p1" }, "pluginUninstall"],
    [{ feature: "plugin", action: "marketplace" }, "pluginMarketplace"],
    [{ feature: "plugin", action: "marketplace", arg: "browse" }, "pluginMarketplace"],
    [{ feature: "plugin", action: "marketplace", arg: "add o/r" }, "pluginSourcesAdd"],
    [{ feature: "plugin", action: "marketplace", arg: "list" }, "pluginSourcesList"],
    [{ feature: "plugin", action: "marketplace", arg: "remove o/r" }, "pluginSourcesRemove"],
    [{ feature: "plugin", action: "sources", arg: "list" }, "pluginSourcesList"],
    [{ feature: "plugin", action: "sources", arg: "add o/r" }, "pluginSourcesAdd"],
    [{ feature: "plugin", action: "sources", arg: "remove o/r" }, "pluginSourcesRemove"],
    [{ feature: "plugin", action: "trust", arg: "list" }, "pluginTrustList"],
    [{ feature: "plugin", action: "trust", arg: "add acme" }, "pluginTrustAdd"],
    [{ feature: "plugin", action: "trust", arg: "remove acme" }, "pluginTrustRemove"],
    [{ feature: "plugin", action: "trust" }, "pluginTrustList"],
    [{ feature: "export", action: "run", arg: "json" }, "exportSession"],
    [{ feature: "doctor", action: "run" }, "runDoctor"],
    [{ feature: "init", action: "run" }, "runInit"],
    [{ feature: "permissions", action: "list" }, "permissionsList"],
    [{ feature: "permissions", action: "clear" }, "permissionsClear"],
    [{ feature: "permissions", action: "remove", arg: "Bash" }, "permissionsRemove"],
    [{ feature: "status", action: "show" }, "runStatus"],
    [{ feature: "limits", action: "show" }, "runLimits"],
    [{ feature: "tasks", action: "list" }, "tasksList"],
    [{ feature: "tasks", action: "show", arg: "t1" }, "tasksShow"],
    [{ feature: "tasks", action: "pause", arg: "t1" }, "tasksPause"],
    [{ feature: "tasks", action: "resume", arg: "t1" }, "tasksResume"],
    [{ feature: "plan", action: "list" }, "planList"],
    [{ feature: "plan", action: "show", arg: "s-plan-1" }, "planShow"],
    [{ feature: "plan", action: "delete", arg: "s-plan-1" }, "planDelete"],
    [{ feature: "plan", action: "diff" }, "planDiff"],
  ] as [RuntimeRequest, string][])("routes %o to %s", async (req, expected) => {
    const h = harness()
    await run(req, h)
    expect(h.calls[0].name).toBe(expected)
  })

  it("passes the arg through to id-taking controllers", async () => {
    const h = harness()
    await run({ feature: "workflow", action: "run", arg: "w42" }, h)
    expect(h.calls[0]).toEqual({ name: "workflowRun", arg: "w42" })
  })

  it("passes osHome, externalSkills and skillDirs into the skill controller", async () => {
    const h = harness()
    let captured: unknown = null
    h.impl.skillList = async (deps: unknown) => {
      captured = deps
      return Promise.resolve()
    }
    h.deps.osHome = "/os-home"
    h.deps.config.externalSkills = true
    h.deps.config.skillDirs = ["/extra/skills"]
    await run({ feature: "skill", action: "list" }, h)
    expect(captured).toMatchObject({
      home: "/home",
      cwd: "/w",
      osHome: "/os-home",
      externalSkills: true,
      skillDirs: ["/extra/skills"],
    })
  })

  it("passes the init action, config and staged draft into runInit", async () => {
    const h = harness()
    let captured: unknown = null
    h.impl.runInit = async (deps: unknown) => {
      captured = deps
      return Promise.resolve()
    }
    h.deps.initDraft = { target: "/w/AGENTS.md", content: "# draft" }
    await run({ feature: "init", action: "apply" }, h)
    expect(captured).toMatchObject({
      cwd: "/w",
      action: "apply",
      home: "/home",
      initDraft: { target: "/w/AGENTS.md", content: "# draft" },
    })
  })

  it("notices an unknown feature", async () => {
    const h = harness()
    await run({ feature: "bogus" as never, action: "x" }, h)
    expect((h.actions[0] as { message: string }).message).toContain("Unknown runtime feature")
  })
})
