/**
 * `/agents` controller — list `.cognia/agents/*.md` subagents and dispatch one
 * by reusing `dispatchSubagent` (renderer-store-free → works in the CLI). File
 * discovery + the dispatcher are injectable for tests.
 */
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { listBackgroundTaskRecords } from "@/lib/db/background-tasks"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"

import {
  applySubagentModelOverrides,
  discoverDispatchableAgents,
  type AgentSummary,
} from "../../agent/discover-agents"
import { withBuiltinAgents } from "../../agent/builtin-agents"
import { buildSubagentModelRows } from "./subagent-models-model"
import type { ResolvedConfig } from "../../config/schema"
import {
  listCliBackgroundRuns,
  type CliBackgroundRunInfo,
} from "../../agent/subagent-background-tasks"
import { listLiveSubagents, type SubagentLiveEntry } from "../../agent/subagent-live-output"
import { buildAgentPanelRows } from "./agents-panel-model"
import { errorMessage, truncate } from "./shared"
import type { InflightSubagentRow } from "../format/subagent"
import type { TuiAction } from "../state/types"

export interface AgentsDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Discovery roots (project + home). Defaults to `[cwd]`. */
  roots?: string[]
  signal?: AbortSignal
  /** Per-subagent provider/model overrides (`config.subagentModels`) overlaid
   * onto the discovered set, so a `/agents models` choice wins at dispatch. */
  subagentModels?: ResolvedConfig["subagentModels"]
  list?: () => Promise<AgentSummary[]>
  dispatchAgent?: (
    def: PluginSubagentDef,
    prompt: string,
    opts: { cwd?: string; abortSignal?: AbortSignal }
  ) => Promise<SubagentRunResult>
}

/**
 * The subset of `PluginSubagentDispatchResult` the `/agents run` summary surfaces.
 * Kept structural (not the full type) so the injectable test dispatcher can return
 * just `{ text }` while the real {@link dispatchSubagent} (a superset) still fits.
 */
type SubagentRunResult = {
  text: string
  usage?: { totalTokens: number }
  finishReason?: string
  /** Set (never thrown) when a nesting guard refused the dispatch. */
  rejection?: { reason: string; message: string }
}

async function loadAgents(deps: AgentsDeps): Promise<AgentSummary[]> {
  const base = deps.list
    ? await deps.list()
    : withBuiltinAgents(await discoverDispatchableAgents(deps.roots ?? [deps.cwd]))
  return applySubagentModelOverrides(base, deps.subagentModels)
}

export async function agentsList(deps: AgentsDeps): Promise<void> {
  const agents = await loadAgents(deps)
  if (agents.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No subagents found. Add markdown files under .cognia/agents/.",
    })
    return
  }
  const lines = agents.map((a) => `  ${a.name}${a.description ? ` — ${a.description}` : ""}`)
  deps.dispatch({
    type: "NOTICE",
    message: `Subagents:\n${lines.join("\n")}\n\nRun one: /agents run <id> <prompt>`,
  })
}

export interface AgentsPanelDeps {
  dispatch: (action: TuiAction) => void
  /** In-turn sub-agent dispatches still running (from `state.inflight.tools`). */
  inflight: InflightSubagentRow[]
  /** The current chat session — scopes the background runs/records shown so the
   * panel never surfaces another session's (or a `/clear`ed session's) runs.
   * Omitted ⇒ no scoping (tests / legacy callers see everything). */
  sessionId?: string
  /** Per-subagent live-output entries — injectable for tests. */
  liveSubagents?: () => SubagentLiveEntry[]
  /** Live CLI background runs — injectable for tests. */
  liveRuns?: () => CliBackgroundRunInfo[]
  /** Journaled CLI background records — injectable for tests. */
  journal?: () => Promise<BackgroundTaskJournalRecord[]>
}

/**
 * Open the interactive agents panel: merge the in-turn dispatches with the
 * background runs (live registry + journal) into one row list and hand it to the
 * `agents` overlay. Opens even when empty — the panel's empty state is itself
 * the "nothing running" affordance (mirrors `/mcp`).
 */
export async function agentsPanel(deps: AgentsPanelDeps): Promise<void> {
  const owner = deps.sessionId
  const live = (deps.liveSubagents ?? (() => listLiveSubagents(owner)))()
  const backgroundRuns = (deps.liveRuns ?? (() => listCliBackgroundRuns(owner)))()
  const allRecords = await (deps.journal ?? (() => listBackgroundTaskRecords({ host: "cli" })))()
  const journalRecords =
    owner === undefined ? allRecords : allRecords.filter((r) => r.sessionId === owner)
  const rows = buildAgentPanelRows({
    inflight: deps.inflight,
    live,
    backgroundRuns,
    journalRecords,
  })
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "agents", rows } })
}

export interface AgentsModelsPanelDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Discovery roots (project + home). Defaults to `[cwd]`. */
  roots?: string[]
  /** The live resolved config — supplies the active provider, the per-provider
   * model catalog, and the persisted `subagentModels` overrides. */
  config: ResolvedConfig
  /** Raw discovered agents (overrides NOT overlaid) — injectable for tests. */
  list?: () => Promise<AgentSummary[]>
}

/**
 * Open the `/agents models` panel: discover the subagents (RAW — overrides are
 * read from config by the row builder, not pre-applied, so a row can tell an
 * override from frontmatter) and project them into editable rows. Opens even
 * when only the built-in `general-purpose` agent exists.
 */
export async function agentsModelsPanel(deps: AgentsModelsPanelDeps): Promise<void> {
  const base = deps.list
    ? await deps.list()
    : withBuiltinAgents(await discoverDispatchableAgents(deps.roots ?? [deps.cwd]))
  const rows = buildSubagentModelRows(base, deps.config)
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "subagentModels", rows, index: 0 } })
}

export async function agentsDispatch(arg: string, deps: AgentsDeps): Promise<void> {
  const trimmed = arg.trim()
  const space = trimmed.indexOf(" ")
  const id = space === -1 ? trimmed : trimmed.slice(0, space)
  const prompt = space === -1 ? "" : trimmed.slice(space + 1).trim()
  if (!id || !prompt) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /agents run <id> <prompt>" })
    return
  }
  const agents = await loadAgents(deps)
  const match = agents.find((a) => a.id === id)
  if (!match) {
    deps.dispatch({
      type: "NOTICE",
      message: `Unknown subagent "${id}". Try /agents to list them.`,
    })
    return
  }
  deps.dispatch({ type: "ACTIVITY_START", kind: "agent", label: truncate(`${id}: ${prompt}`) })
  const run = deps.dispatchAgent ?? ((def, p, opts) => dispatchSubagent(def, p, opts))
  try {
    const result = await run(match.def, prompt, { cwd: deps.cwd, abortSignal: deps.signal })
    // A nesting guard can refuse a dispatch (depth/cycle) by returning a result
    // with `rejection` set rather than throwing — surface it as an error end.
    if (result.rejection) {
      deps.dispatch({
        type: "ACTIVITY_END",
        status: "error",
        summary: `Subagent "${id}" was refused (${result.rejection.reason}): ${result.rejection.message}`,
      })
      return
    }
    // Enrich the summary with the token spend + a non-default finish reason so the
    // run reads like a delegated agent's result, not just a wall of text.
    const meta: string[] = []
    if (result.usage?.totalTokens) meta.push(`${result.usage.totalTokens} tok`)
    if (result.finishReason && result.finishReason !== "end_turn") meta.push(result.finishReason)
    const suffix = meta.length > 0 ? `  (${meta.join(" · ")})` : ""
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "done",
      summary: `Subagent "${id}"${suffix}:\n${result.text}`,
    })
  } catch (err) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: `Subagent "${id}" failed: ${errorMessage(err)}`,
    })
  }
}
