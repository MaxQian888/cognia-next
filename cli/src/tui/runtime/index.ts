/**
 * Runtime request router — maps a {@link RuntimeRequest} (produced by a pure
 * command handler) to the matching Cognia-runtime controller. The App's
 * `runtime` effect calls this; it owns the async work + dispatches cells. The
 * controller map is injectable so the routing is unit-tested without a db.
 */
import type { RuntimeRequest } from "../commands/types"
import type { ResolvedConfig } from "../../config/schema"
import type { ToolCell, TuiAction, UsageInfo } from "../state/types"
import os from "node:os"
import { agentsDispatch, agentsList, agentsModelsPanel, agentsPanel } from "./agents-controller"
import { inflightSubagentRows } from "../format/subagent"
import { agentModeList } from "./agent-mode-controller"
import { buildAgentsRunDispatch } from "../../agent/agents-run-dispatch"
import { goalList, goalPause, goalResume, goalStart, goalStatus, goalStop } from "./goal-controller"
import { logsPanel } from "./log-controller"
import {
  mcpAdd,
  mcpAuth,
  mcpList,
  mcpLogout,
  mcpLogsPanel,
  mcpPanel,
  mcpPresets,
  mcpPrompts,
  mcpReconnect,
  mcpRemove,
  mcpResources,
  mcpSetEnabled,
  mcpShow,
  mcpTools,
  mcpToggle,
} from "./mcp-controller"
import { memoryAdd, memoryDelete, memoryList, memoryShow } from "./memory-controller"
import {
  pluginList,
  pluginSetEnabled,
  pluginShow,
  pluginTools,
  pluginReload,
  pluginInstall,
  pluginPreview,
  pluginUpdate,
  pluginUninstall,
  pluginMarketplace,
  pluginSourcesList,
  pluginSourcesAdd,
  pluginSourcesRemove,
  pluginTrustList,
  pluginTrustAdd,
  pluginTrustRemove,
} from "./plugin-controller"
import {
  skillCreate,
  skillDelete,
  skillDisableAll,
  skillEnableAll,
  skillFiles,
  skillList,
  skillPanel,
  skillSetEnabled,
  skillShow,
  skillToggle,
} from "./skill-controller"
import { teamAuto, teamList, teamRun, teamShow } from "./team-controller"
import {
  workflowInspect,
  workflowList,
  workflowReplay,
  workflowRun,
  workflowRuns,
} from "./workflow-controller"
import {
  copilotApply,
  copilotCreate,
  copilotDiscard,
  copilotEdit,
  copilotExit,
  copilotSave,
} from "./workflow-copilot-controller"
import { exportSession } from "./export-controller"
import { runDoctor } from "./doctor-controller"
import { runInit } from "./init-controller"
import { permissionsClear, permissionsList, permissionsRemove } from "./permissions-controller"
import { runStatus } from "./status-controller"
import { runLimits } from "./limits-controller"
import { runAgentStats } from "./agent-stats-controller"
import { runContextReport } from "./context-controller"
import { tasksList, tasksPause, tasksResume, tasksShow } from "./tasks-controller"
import { viewFile } from "./view-controller"
import { planList, planShow, planDelete, planDiff, planExplore } from "./plan-controller"
import { hooksList } from "./hooks-controller"
import { councilRun } from "./council-controller"
import { orchestrateRun } from "./orchestrate-controller"
import { runCommit } from "./commit-controller"
import { runPr } from "./pr-controller"
import { runStack } from "./stack-controller"

export interface RuntimeDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  sessionId: string
  signal: AbortSignal
  /** Config home (`~/.cognia`) for file-based feature state. */
  home: string
  /** OS home (`~`) — Claude Code / Codex skill dirs hang off this. Optional;
   * the skill controller falls back to `os.homedir()` when absent. */
  osHome?: string
  /** Discovery roots for file-based features (project + home). */
  roots: string[]
  /** CLI version string (for `/doctor`). */
  version: string
  /** Latest-turn usage (for the `/status` context gauge). */
  usage?: UsageInfo
  /** Per-model context window (from the catalog) for the `/status` context gauge. */
  contextWindow?: number
  /** What the active agent backend supports, for `/status`'s blocked-feature list. */
  capabilities?: import("./backend-capabilities").BackendCapabilities
  /** Per-turn token history (for the `/limits` session analysis). */
  usageHistory?: number[]
  /** Per-tool call/error tallies (for the `/limits` session analysis). */
  toolStats?: Record<string, import("../state/types").ToolStat>
  /** Live API rate-limit reading (for the `/limits` live block). */
  rateLimits?: import("../format/rate-limits").RateLimitSnapshot
  /** Pending `/init` staged draft (read by `/init apply`). */
  initDraft?: { target: string; content: string }
  /** Pending `/commit` staged message (read by `/commit apply`). */
  commitDraft?: { message: string }
  /** Pending `/pr` staged draft (read by `/pr apply`). */
  prDraft?: { title: string; body: string; base: string }
  /** Live in-flight tool cells — feeds the `/agents` panel's in-turn rows. */
  inflightTools?: ToolCell[]
  /** Shared MCP probe cache (App-owned) so command-path `/mcp` mutators keep it
   * coherent with the panel — clearing a toggled/removed server's stale entry. */
  mcpProbeCache?: import("./mcp-cache").McpProbeCache
}

/** The controller surface the router calls — swappable in tests. */
export interface RuntimeImpl {
  workflowList: typeof workflowList
  workflowRun: typeof workflowRun
  workflowInspect: typeof workflowInspect
  workflowRuns: typeof workflowRuns
  workflowReplay: typeof workflowReplay
  copilotCreate: typeof copilotCreate
  copilotEdit: typeof copilotEdit
  copilotApply: typeof copilotApply
  copilotDiscard: typeof copilotDiscard
  copilotSave: typeof copilotSave
  copilotExit: typeof copilotExit
  agentsList: typeof agentsList
  agentsDispatch: typeof agentsDispatch
  agentsPanel: typeof agentsPanel
  agentsModelsPanel: typeof agentsModelsPanel
  agentModeList: typeof agentModeList
  teamList: typeof teamList
  teamShow: typeof teamShow
  teamRun: typeof teamRun
  teamAuto: typeof teamAuto
  memoryList: typeof memoryList
  memoryShow: typeof memoryShow
  memoryAdd: typeof memoryAdd
  memoryDelete: typeof memoryDelete
  goalStart: typeof goalStart
  goalStatus: typeof goalStatus
  goalPause: typeof goalPause
  goalResume: typeof goalResume
  goalStop: typeof goalStop
  goalList: typeof goalList
  mcpList: typeof mcpList
  mcpToggle: typeof mcpToggle
  mcpSetEnabled: typeof mcpSetEnabled
  mcpAdd: typeof mcpAdd
  mcpShow: typeof mcpShow
  mcpTools: typeof mcpTools
  mcpResources: typeof mcpResources
  mcpPrompts: typeof mcpPrompts
  mcpAuth: typeof mcpAuth
  mcpLogout: typeof mcpLogout
  mcpPresets: typeof mcpPresets
  mcpPanel: typeof mcpPanel
  mcpLogsPanel: typeof mcpLogsPanel
  logsPanel: typeof logsPanel
  mcpReconnect: typeof mcpReconnect
  mcpRemove: typeof mcpRemove
  skillList: typeof skillList
  skillShow: typeof skillShow
  skillFiles: typeof skillFiles
  skillToggle: typeof skillToggle
  skillSetEnabled: typeof skillSetEnabled
  skillEnableAll: typeof skillEnableAll
  skillDisableAll: typeof skillDisableAll
  skillPanel: typeof skillPanel
  skillCreate: typeof skillCreate
  skillDelete: typeof skillDelete
  pluginList: typeof pluginList
  pluginShow: typeof pluginShow
  pluginTools: typeof pluginTools
  pluginSetEnabled: typeof pluginSetEnabled
  pluginReload: typeof pluginReload
  pluginInstall: typeof pluginInstall
  pluginPreview: typeof pluginPreview
  pluginUpdate: typeof pluginUpdate
  pluginUninstall: typeof pluginUninstall
  pluginMarketplace: typeof pluginMarketplace
  pluginSourcesList: typeof pluginSourcesList
  pluginSourcesAdd: typeof pluginSourcesAdd
  pluginSourcesRemove: typeof pluginSourcesRemove
  pluginTrustList: typeof pluginTrustList
  pluginTrustAdd: typeof pluginTrustAdd
  pluginTrustRemove: typeof pluginTrustRemove
  exportSession: typeof exportSession
  runDoctor: typeof runDoctor
  runInit: typeof runInit
  permissionsList: typeof permissionsList
  permissionsClear: typeof permissionsClear
  permissionsRemove: typeof permissionsRemove
  runStatus: typeof runStatus
  runLimits: typeof runLimits
  runAgentStats: typeof runAgentStats
  runContextReport: typeof runContextReport
  tasksList: typeof tasksList
  tasksShow: typeof tasksShow
  tasksPause: typeof tasksPause
  tasksResume: typeof tasksResume
  viewFile: typeof viewFile
  planList: typeof planList
  planShow: typeof planShow
  planDelete: typeof planDelete
  planDiff: typeof planDiff
  planExplore: typeof planExplore
  hooksList: typeof hooksList
  councilRun: typeof councilRun
  orchestrateRun: typeof orchestrateRun
  runCommit: typeof runCommit
  runPr: typeof runPr
}

const REAL: RuntimeImpl = {
  workflowList,
  workflowRun,
  workflowInspect,
  workflowRuns,
  workflowReplay,
  copilotCreate,
  copilotEdit,
  copilotApply,
  copilotDiscard,
  copilotSave,
  copilotExit,
  agentsList,
  agentsDispatch,
  agentsPanel,
  agentsModelsPanel,
  agentModeList,
  teamList,
  teamShow,
  teamRun,
  teamAuto,
  memoryList,
  memoryShow,
  memoryAdd,
  memoryDelete,
  goalStart,
  goalStatus,
  goalPause,
  goalResume,
  goalStop,
  goalList,
  mcpList,
  mcpToggle,
  mcpSetEnabled,
  mcpAdd,
  mcpShow,
  mcpTools,
  mcpResources,
  mcpPrompts,
  mcpAuth,
  mcpLogout,
  mcpPresets,
  mcpPanel,
  mcpLogsPanel,
  logsPanel,
  mcpReconnect,
  mcpRemove,
  skillList,
  skillShow,
  skillFiles,
  skillToggle,
  skillSetEnabled,
  skillEnableAll,
  skillDisableAll,
  skillPanel,
  skillCreate,
  skillDelete,
  pluginList,
  pluginShow,
  pluginTools,
  pluginSetEnabled,
  pluginReload,
  pluginInstall,
  pluginPreview,
  pluginUpdate,
  pluginUninstall,
  pluginMarketplace,
  pluginSourcesList,
  pluginSourcesAdd,
  pluginSourcesRemove,
  pluginTrustList,
  pluginTrustAdd,
  pluginTrustRemove,
  exportSession,
  runDoctor,
  runInit,
  permissionsList,
  permissionsClear,
  permissionsRemove,
  runStatus,
  runLimits,
  runAgentStats,
  runContextReport,
  tasksList,
  tasksShow,
  tasksPause,
  tasksResume,
  viewFile,
  planList,
  planShow,
  planDelete,
  planDiff,
  planExplore,
  hooksList,
  councilRun,
  orchestrateRun,
  runCommit,
  runPr,
  runStack,
}

export async function runRuntimeRequest(
  req: RuntimeRequest,
  deps: RuntimeDeps,
  impl: RuntimeImpl = REAL
): Promise<void> {
  const { dispatch, config, sessionId, signal } = deps
  const arg = req.arg ?? ""
  const cwd = config.cwd

  switch (req.feature) {
    case "workflow": {
      const wd = { dispatch, signal }
      if (req.action === "run") return impl.workflowRun(arg, wd)
      if (req.action === "inspect") return impl.workflowInspect(arg, wd)
      if (req.action === "runs") return impl.workflowRuns(arg, wd)
      if (req.action === "replay") return impl.workflowReplay(arg, wd)
      // Workflow Copilot mode (create/edit enter the mode; apply/discard/save/exit
      // act on the open draft — App bridges the COPILOT_* actions to the session).
      if (req.action === "create") return impl.copilotCreate(arg, { dispatch })
      if (req.action === "edit") return impl.copilotEdit(arg, { dispatch })
      if (req.action === "apply") return impl.copilotApply(arg, { dispatch })
      if (req.action === "discard") return impl.copilotDiscard(arg, { dispatch })
      if (req.action === "save") return impl.copilotSave(arg, { dispatch })
      if (req.action === "exit") return impl.copilotExit(arg, { dispatch })
      return impl.workflowList(wd)
    }
    case "agents": {
      if (req.action === "panel")
        return impl.agentsPanel({
          dispatch,
          sessionId,
          inflight: inflightSubagentRows(deps.inflightTools ?? []),
        })
      if (req.action === "models")
        return impl.agentsModelsPanel({ dispatch, cwd, roots: deps.roots, config })
      const ad = {
        dispatch,
        cwd,
        roots: deps.roots,
        signal,
        // The override map is read by the row builder for the panel, but the
        // list/run paths overlay it so `/agents run` honours a saved choice.
        ...(config.subagentModels ? { subagentModels: config.subagentModels } : {}),
        // `/agents run` executes a subagent over the live sidecar with the CLI's
        // own config/provider (the desktop `dispatchSubagent` default is gated on
        // `isTauri()` and reads provider from Dexie — neither holds in the CLI).
        ...(req.action === "run"
          ? {
              dispatchAgent: buildAgentsRunDispatch({
                config,
                home: deps.home,
                sessionId,
                signal,
              }),
            }
          : {}),
      }
      if (req.action === "run") return impl.agentsDispatch(arg, ad)
      return impl.agentsList(ad)
    }
    case "agentMode":
      return impl.agentModeList({
        dispatch,
        cwd,
        roots: deps.roots,
        ...(config.agentMode ? { activeModeId: config.agentMode } : {}),
      })
    case "team": {
      const td = { dispatch }
      if (req.action === "show") return impl.teamShow(arg, td)
      if (req.action === "run") return impl.teamRun(arg, { dispatch, signal })
      if (req.action === "auto") {
        return impl.teamAuto(arg, {
          dispatch,
          config: deps.config,
          sessionId: deps.sessionId,
          signal,
        })
      }
      return impl.teamList(td)
    }
    case "memory": {
      const md = { dispatch }
      if (req.action === "show") return impl.memoryShow(arg, md)
      if (req.action === "add") return impl.memoryAdd(arg, md)
      if (req.action === "delete") return impl.memoryDelete(arg, md)
      return impl.memoryList(md)
    }
    case "mcp": {
      const mc = {
        dispatch,
        roots: deps.roots,
        home: deps.home,
        ...(deps.mcpProbeCache ? { probeCache: deps.mcpProbeCache } : {}),
      }
      if (req.action === "add") return impl.mcpAdd(arg, mc)
      if (req.action === "enable") return impl.mcpSetEnabled(arg, true, mc)
      if (req.action === "disable") return impl.mcpSetEnabled(arg, false, mc)
      if (req.action === "toggle") return impl.mcpToggle(arg, mc)
      if (req.action === "show") return impl.mcpShow(arg, mc)
      if (req.action === "tools") return impl.mcpTools(arg, mc)
      if (req.action === "resources") return impl.mcpResources(arg, mc)
      if (req.action === "prompts") return impl.mcpPrompts(arg, mc)
      if (req.action === "auth") return impl.mcpAuth(arg, mc)
      if (req.action === "logout") return impl.mcpLogout(arg, mc)
      if (req.action === "presets") return impl.mcpPresets(mc)
      if (req.action === "reconnect") return impl.mcpReconnect(arg, mc)
      if (req.action === "remove") return impl.mcpRemove(arg, mc)
      if (req.action === "panel") return impl.mcpPanel(mc)
      if (req.action === "list") return impl.mcpList(mc)
      if (req.action === "logs") return impl.mcpLogsPanel(mc)
      return impl.mcpPanel(mc)
    }
    case "logs":
      // The unified panel renders straight off the live buffers and derives its
      // own header summary, so opening it needs no resolution step.
      return impl.logsPanel({ dispatch })
    case "skill": {
      const sk = {
        dispatch,
        home: deps.home,
        cwd,
        osHome: deps.osHome,
        externalSkills: config.externalSkills,
        skillDirs: config.skillDirs,
      }
      if (req.action === "show") return impl.skillShow(arg, sk)
      if (req.action === "files") return impl.skillFiles(arg, sk)
      if (req.action === "enable") return impl.skillSetEnabled(arg, true, sk)
      if (req.action === "disable") return impl.skillSetEnabled(arg, false, sk)
      if (req.action === "enable-all") return impl.skillEnableAll(sk)
      if (req.action === "disable-all") return impl.skillDisableAll(sk)
      if (req.action === "toggle") return impl.skillToggle(arg, sk)
      if (req.action === "create") return impl.skillCreate(arg, sk)
      if (req.action === "delete") return impl.skillDelete(arg, sk)
      if (req.action === "list") return impl.skillList(sk)
      if (req.action === "panel") return impl.skillPanel(sk)
      return impl.skillPanel(sk)
    }
    case "plugin": {
      const pl = { dispatch, roots: deps.roots, home: deps.home }
      if (req.action === "show") return impl.pluginShow(arg, pl)
      if (req.action === "tools") return impl.pluginTools(arg, pl)
      if (req.action === "enable") return impl.pluginSetEnabled(arg, true, pl)
      if (req.action === "disable") return impl.pluginSetEnabled(arg, false, pl)
      if (req.action === "reload") return impl.pluginReload(arg, pl)
      if (req.action === "install") return impl.pluginInstall(arg, pl)
      if (req.action === "preview") return impl.pluginPreview(arg, pl)
      if (req.action === "update") return impl.pluginUpdate(arg, pl)
      if (req.action === "uninstall") return impl.pluginUninstall(arg, pl)
      if (req.action === "marketplace") {
        // Claude-Code-style: `marketplace add|list|remove` manages sources;
        // bare `marketplace` (or `marketplace browse`) browses the catalog.
        const [sub, ...rest] = arg.split(/\s+/)
        const ref = rest.join(" ").trim()
        if (sub === "add") return impl.pluginSourcesAdd(ref, pl)
        if (sub === "remove") return impl.pluginSourcesRemove(ref, pl)
        if (sub === "list") return impl.pluginSourcesList(pl)
        return impl.pluginMarketplace(pl)
      }
      if (req.action === "sources") {
        const [sub, ...rest] = arg.split(/\s+/)
        const ref = rest.join(" ").trim()
        if (sub === "add") return impl.pluginSourcesAdd(ref, pl)
        if (sub === "remove") return impl.pluginSourcesRemove(ref, pl)
        return impl.pluginSourcesList(pl)
      }
      if (req.action === "trust") {
        const [sub, ...rest] = arg.split(/\s+/)
        const owner = rest.join(" ").trim()
        if (sub === "add") return impl.pluginTrustAdd(owner, pl)
        if (sub === "remove") return impl.pluginTrustRemove(owner, pl)
        return impl.pluginTrustList(pl)
      }
      return impl.pluginList(pl)
    }
    case "goal": {
      const gd = { dispatch, sessionId, config, signal }
      switch (req.action) {
        case "status":
          return impl.goalStatus(gd)
        case "pause":
          return impl.goalPause(gd)
        case "resume":
          return impl.goalResume(gd)
        case "stop":
          return impl.goalStop(gd)
        case "list":
          return impl.goalList(gd)
        default:
          return impl.goalStart(arg, gd)
      }
    }
    case "export":
      return impl.exportSession(arg, { dispatch, home: deps.home, sessionId, cwd })
    case "doctor":
      return impl.runDoctor({
        dispatch,
        config,
        home: deps.home,
        version: deps.version,
        // Lets the report read THIS session's live Cognia parity facts rather
        // than describing the preset in the abstract.
        sessionId,
        os: { platform: () => process.platform, homedir: os.homedir },
        env: process.env,
      })
    case "init":
      return impl.runInit({
        dispatch,
        cwd,
        action: req.action,
        home: deps.home,
        config,
        ...(deps.initDraft ? { initDraft: deps.initDraft } : {}),
      })
    case "permissions": {
      const pd = { dispatch, config, home: deps.home }
      if (req.action === "clear") return impl.permissionsClear(pd)
      if (req.action === "remove") return impl.permissionsRemove(pd, req.arg ?? "")
      return impl.permissionsList(pd)
    }
    case "status":
      return impl.runStatus({
        dispatch,
        config,
        home: deps.home,
        version: deps.version,
        sessionId,
        usage: deps.usage,
        contextWindow: deps.contextWindow,
        capabilities: deps.capabilities,
      })
    case "limits":
      return impl.runLimits({
        dispatch,
        config,
        usageHistory: deps.usageHistory,
        toolStats: deps.toolStats,
        rateLimits: deps.rateLimits,
      })
    case "agentStats":
      return impl.runAgentStats({
        dispatch,
        osHome: deps.osHome ?? os.homedir(),
        ...(signal ? { signal } : {}),
      })
    case "context":
      return impl.runContextReport({
        dispatch,
        config,
        sessionId: deps.sessionId,
        usage: deps.usage,
        contextWindow: deps.contextWindow,
        ...(deps.capabilities?.presetId ? { presetId: deps.capabilities.presetId } : {}),
      })
    case "tasks": {
      const tk = { dispatch }
      if (req.action === "show") return impl.tasksShow(arg, tk)
      if (req.action === "pause") return impl.tasksPause(arg, tk)
      if (req.action === "resume") return impl.tasksResume(arg, tk)
      return impl.tasksList(tk)
    }
    case "hooks":
      return impl.hooksList({ dispatch, home: deps.home, osHome: deps.osHome })
    case "council":
      return impl.councilRun(arg, { dispatch, signal })
    case "orchestrate":
      return impl.orchestrateRun(arg, { dispatch, config, sessionId, signal })
    case "commit":
      return impl.runCommit({
        dispatch,
        cwd,
        action: req.action,
        config,
        home: deps.home,
        ...(deps.commitDraft ? { commitDraft: deps.commitDraft } : {}),
      })
    case "pr":
      return impl.runPr({
        dispatch,
        cwd,
        action: req.action,
        config,
        home: deps.home,
        ...(deps.prDraft ? { prDraft: deps.prDraft } : {}),
      })
    case "stack":
      return impl.runStack({
        dispatch,
        cwd,
        ...(req.action ? { action: req.action } : {}),
        ...(arg ? { arg } : {}),
      })
    case "view":
      return impl.viewFile(arg, { dispatch, cwd })
    case "plan": {
      const pd = { dispatch, home: deps.home }
      if (req.action === "show") return impl.planShow(arg, pd)
      if (req.action === "delete") return impl.planDelete(arg, pd)
      if (req.action === "diff") return impl.planDiff(arg, pd)
      if (req.action === "explore") {
        // The deterministic Explore→Plan pipeline runs the read-only built-in
        // subagents over the live sidecar (same seam as `/agents run`).
        return impl.planExplore(arg, {
          dispatch,
          dispatchAgent: buildAgentsRunDispatch({ config, home: deps.home, sessionId, signal }),
          ...(signal ? { signal } : {}),
        })
      }
      return impl.planList(pd)
    }
    default:
      dispatch({ type: "NOTICE", message: `Unknown runtime feature: ${req.feature}` })
  }
}
