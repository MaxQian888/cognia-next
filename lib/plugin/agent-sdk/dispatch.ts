/**
 * Plugin Agent SDK — programmatic subagent / team dispatch (Package C).
 *
 * - `dispatchSubagent` runs a single, named subagent on a prompt by mapping its
 *   definition onto the executor (`executeAgent`). Subagents have no
 *   direct-invoke entry point in the host (the model normally dispatches them
 *   via the Task tool), so this maps {prompt, model, tools, maxTurns} onto a
 *   one-shot tool-enabled run — faithful "run THIS subagent" semantics.
 * - `runTeam` runs an Agent Team headlessly by reusing `agentTeamManager`
 *   (live store binding + configured runtime deps + the existing per-team
 *   inflight guard). Accepts an existing team id or an ad-hoc team config.
 *
 * Permission-agnostic (gating lives in `context.ts` behind `agent:dispatch`).
 * Lazy-imports the heavy team/executor runtimes so this module stays cheap to
 * load and unit-testable.
 */

import type { AgentTeamConfig } from "@/lib/ai/agent/agent-team"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import type {
  PluginDispatchSubagentOptions,
  PluginRunTeamOptions,
  PluginRunTeamResult,
  PluginSubagentDispatchResult,
} from "@/types/plugin/plugin-agent-sdk"

/**
 * Dispatch a built-in/plugin subagent on a prompt. `idOrDef` resolves a
 * registered subagent by id, or accepts an inline definition.
 */
export async function dispatchSubagent(
  idOrDef: string | PluginSubagentDef,
  prompt: string,
  options: PluginDispatchSubagentOptions = {}
): Promise<PluginSubagentDispatchResult> {
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("dispatchSubagent requires a non-empty prompt")
  }

  let def: PluginSubagentDef | undefined
  if (typeof idOrDef === "string") {
    const { getSubagent } = await import("@/lib/plugin/registries/subagent-registry")
    def = getSubagent(idOrDef)
    if (!def) {
      throw new Error(`dispatchSubagent: subagent "${idOrDef}" is not registered`)
    }
  } else {
    def = idOrDef
  }

  const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
  const result = await executeAgent(prompt, {
    toolsEnabled: options.toolsEnabled ?? true,
    ...(def.prompt ? { systemPrompt: def.prompt } : {}),
    ...(def.model ? { model: def.model } : {}),
    ...(def.tools && def.tools.length > 0 ? { allowedTools: def.tools } : {}),
    ...(typeof def.maxTurns === "number" ? { maxSteps: def.maxTurns } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  })

  return {
    text: result.text,
    channel: result.channel,
    toolsAvailable: result.toolsAvailable,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  }
}

/**
 * Run an Agent Team headlessly. `teamOrConfig` is an existing team id or an
 * ad-hoc team config (created in the store, then started). Reuses
 * `agentTeamManager.start` so the run inherits the configured runtime deps and
 * the per-team inflight guard. Resolves with the terminal status.
 */
export async function runTeam(
  teamOrConfig: string | AgentTeamConfig,
  options: PluginRunTeamOptions = {}
): Promise<PluginRunTeamResult> {
  const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")

  let teamId: string
  if (typeof teamOrConfig === "string") {
    teamId = teamOrConfig
    if (!agentTeamManager.get(teamId)) {
      throw new Error(`runTeam: team "${teamId}" not found`)
    }
  } else {
    if (!teamOrConfig?.id) {
      throw new Error("runTeam: an ad-hoc team config must carry an id")
    }
    agentTeamManager.create(teamOrConfig)
    teamId = teamOrConfig.id
  }

  await agentTeamManager.start(teamId, {
    ...(options.ultracode !== undefined ? { ultracode: options.ultracode } : {}),
  })

  const team = agentTeamManager.get(teamId)
  return { teamId, status: team?.status ?? "unknown" }
}
