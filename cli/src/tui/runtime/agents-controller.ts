/**
 * `/agents` controller — list `.cognia/agents/*.md` subagents and dispatch one
 * by reusing `dispatchSubagent` (renderer-store-free → works in the CLI). File
 * discovery + the dispatcher are injectable for tests.
 */
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

import { buildAgents, discoverAgentFiles, type AgentSummary } from "../../agent/discover-agents"
import { errorMessage, truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface AgentsDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Discovery roots (project + home). Defaults to `[cwd]`. */
  roots?: string[]
  signal?: AbortSignal
  list?: () => Promise<AgentSummary[]>
  dispatchAgent?: (
    def: PluginSubagentDef,
    prompt: string,
    opts: { cwd?: string; abortSignal?: AbortSignal }
  ) => Promise<{ text: string }>
}

async function loadAgents(deps: AgentsDeps): Promise<AgentSummary[]> {
  if (deps.list) return deps.list()
  return buildAgents(await discoverAgentFiles(deps.roots ?? [deps.cwd]))
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
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "done",
      summary: `Subagent "${id}":\n${result.text}`,
    })
  } catch (err) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: `Subagent "${id}" failed: ${errorMessage(err)}`,
    })
  }
}
