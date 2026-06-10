/**
 * Runtime request router — maps a {@link RuntimeRequest} (produced by a pure
 * command handler) to the matching Cognia-runtime controller. The App's
 * `runtime` effect calls this; it owns the async work + dispatches cells. The
 * controller map is injectable so the routing is unit-tested without a db.
 */
import type { RuntimeRequest } from "../commands/types"
import type { ResolvedConfig } from "../../config/schema"
import type { TuiAction } from "../state/types"
import { agentsDispatch, agentsList } from "./agents-controller"
import { goalList, goalPause, goalResume, goalStart, goalStatus, goalStop } from "./goal-controller"
import { mcpAdd, mcpList, mcpSetEnabled, mcpToggle } from "./mcp-controller"
import { memoryList, memoryShow } from "./memory-controller"
import { pluginList, pluginSetEnabled, pluginShow } from "./plugin-controller"
import { skillList, skillSetEnabled, skillShow, skillToggle } from "./skill-controller"
import { teamList, teamRunUnavailable, teamShow } from "./team-controller"
import { workflowInspect, workflowList, workflowRun } from "./workflow-controller"

export interface RuntimeDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  sessionId: string
  signal: AbortSignal
  /** Config home (`~/.cognia`) for file-based feature state. */
  home: string
  /** Discovery roots for file-based features (project + home). */
  roots: string[]
}

/** The controller surface the router calls — swappable in tests. */
export interface RuntimeImpl {
  workflowList: typeof workflowList
  workflowRun: typeof workflowRun
  workflowInspect: typeof workflowInspect
  agentsList: typeof agentsList
  agentsDispatch: typeof agentsDispatch
  teamList: typeof teamList
  teamShow: typeof teamShow
  teamRunUnavailable: typeof teamRunUnavailable
  memoryList: typeof memoryList
  memoryShow: typeof memoryShow
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
  skillList: typeof skillList
  skillShow: typeof skillShow
  skillToggle: typeof skillToggle
  skillSetEnabled: typeof skillSetEnabled
  pluginList: typeof pluginList
  pluginShow: typeof pluginShow
  pluginSetEnabled: typeof pluginSetEnabled
}

const REAL: RuntimeImpl = {
  workflowList,
  workflowRun,
  workflowInspect,
  agentsList,
  agentsDispatch,
  teamList,
  teamShow,
  teamRunUnavailable,
  memoryList,
  memoryShow,
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
  skillList,
  skillShow,
  skillToggle,
  skillSetEnabled,
  pluginList,
  pluginShow,
  pluginSetEnabled,
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
      return impl.workflowList(wd)
    }
    case "agents": {
      const ad = { dispatch, cwd, roots: deps.roots, signal }
      if (req.action === "run") return impl.agentsDispatch(arg, ad)
      return impl.agentsList(ad)
    }
    case "team": {
      const td = { dispatch }
      if (req.action === "show") return impl.teamShow(arg, td)
      if (req.action === "run") return impl.teamRunUnavailable(td)
      return impl.teamList(td)
    }
    case "memory": {
      const md = { dispatch }
      if (req.action === "show") return impl.memoryShow(arg, md)
      return impl.memoryList(md)
    }
    case "mcp": {
      const mc = { dispatch, roots: deps.roots, home: deps.home }
      if (req.action === "add") return impl.mcpAdd(arg, mc)
      if (req.action === "enable") return impl.mcpSetEnabled(arg, true, mc)
      if (req.action === "disable") return impl.mcpSetEnabled(arg, false, mc)
      if (req.action === "toggle") return impl.mcpToggle(arg, mc)
      return impl.mcpList(mc)
    }
    case "skill": {
      const sk = { dispatch, home: deps.home }
      if (req.action === "show") return impl.skillShow(arg, sk)
      if (req.action === "enable") return impl.skillSetEnabled(arg, true, sk)
      if (req.action === "disable") return impl.skillSetEnabled(arg, false, sk)
      if (req.action === "toggle") return impl.skillToggle(arg, sk)
      return impl.skillList(sk)
    }
    case "plugin": {
      const pl = { dispatch, roots: deps.roots, home: deps.home }
      if (req.action === "show") return impl.pluginShow(arg, pl)
      if (req.action === "enable") return impl.pluginSetEnabled(arg, true, pl)
      if (req.action === "disable") return impl.pluginSetEnabled(arg, false, pl)
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
    default:
      dispatch({ type: "NOTICE", message: `Unknown runtime feature: ${req.feature}` })
  }
}
