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
  PluginSubagentDispatchRejection,
} from "@/types/plugin/plugin-agent-sdk"
import { getDispatchBudget, isDispatchBudgetExhausted } from "@/lib/claude/agents/dispatch-budget"

/** Generate a run id (app code — Date.now/randomUUID are allowed here). */
function newRunId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  }
}

/** Build a refused-dispatch result (never thrown — the model reads `text`). */
function rejectionResult(
  runId: string,
  rejection: PluginSubagentDispatchRejection
): PluginSubagentDispatchResult {
  return {
    text: rejection.message,
    channel: "text",
    toolsAvailable: false,
    finishReason: "rejected",
    runId,
    rejection,
    ...(rejection.reason === "max-depth" ? { depthExhausted: true } : {}),
  }
}

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

  const runId = options._runId ?? newRunId()

  let def: PluginSubagentDef | undefined
  let thisId: string
  if (typeof idOrDef === "string") {
    const { getSubagent } = await import("@/lib/plugin/registries/subagent-registry")
    def = getSubagent(idOrDef)
    if (!def) {
      throw new Error(`dispatchSubagent: subagent "${idOrDef}" is not registered`)
    }
    thisId = idOrDef
  } else {
    def = idOrDef
    thisId = idOrDef.id
  }

  // ── Nesting guards ─────────────────────────────────────────────────────────
  // Cycle: this subagent is already an ancestor on the dispatch chain (A→B→A).
  const parentChain = options._parentChain ?? []
  if (parentChain.includes(thisId)) {
    return rejectionResult(runId, {
      reason: "cycle",
      message: `Dispatch refused — "${thisId}" is already on the dispatch chain (${[
        ...parentChain,
        thisId,
      ].join(" → ")}). Cycles are not allowed.`,
    })
  }
  // Depth: the child would run at parentDepth + 1; refuse beyond the cap.
  const childDepth = (options._depth ?? 0) + 1
  if (typeof options._maxDepth === "number" && childDepth > options._maxDepth) {
    return rejectionResult(runId, {
      reason: "max-depth",
      message: `Dispatch refused — max nesting depth (${options._maxDepth}) reached.`,
      attemptedDepth: childDepth,
    })
  }
  // Budget: refuse a deeper/sibling dispatch when the subtree pool is critical.
  if (isDispatchBudgetExhausted(options._budgetRootRunId)) {
    return {
      text: "Dispatch refused — the token budget for this dispatch subtree is exhausted.",
      channel: "text",
      toolsAvailable: false,
      finishReason: "error",
      runId,
      depthExhausted: true,
    }
  }

  // Thread A2: route to an external CLI agent when the def (or options) names a
  // preset. External agents run their own loop and do not nest back in, so the
  // depth/budget threading stops here.
  const externalPresetId = options.externalAgentId ?? def.externalPresetId
  if (externalPresetId) {
    const ext = await runExternalSubagent(externalPresetId, prompt, def, options)
    return { ...ext, runId }
  }

  // Effective depth cap for the CHILD's own dispatch context: app cap narrowed
  // by the def's per-agent override. A child may itself nest only when opted in.
  const effectiveMaxDepth =
    typeof def.maxDepth === "number" && typeof options._maxDepth === "number"
      ? Math.min(def.maxDepth, options._maxDepth)
      : (def.maxDepth ?? options._maxDepth)
  const childChain = [...parentChain, thisId]
  const deadlineMs = options._deadlineMs
  const timeoutMs =
    typeof deadlineMs === "number" ? Math.max(0, deadlineMs - Date.now()) : undefined

  const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
  const result = await executeAgent(prompt, {
    toolsEnabled: options.toolsEnabled ?? true,
    // Every run dispatched here is a subagent. Without a dispatchContext (leaf,
    // allowNesting unset) build-options must WITHHOLD dispatch_agent — including
    // the plan-mode force-offer — instead of treating the child as top-level.
    isDispatchedSubagent: true,
    ...(def.prompt ? { systemPrompt: def.prompt } : {}),
    ...(def.model ? { model: def.model } : {}),
    // Cross-provider subagent: route the run to the def's provider (with its own
    // credentials) instead of the dispatching session's provider.
    ...(def.provider ? { provider: def.provider } : {}),
    ...(def.tools && def.tools.length > 0 ? { allowedTools: def.tools } : {}),
    // Parent ceiling: clamp THIS child's resolved tool surface against the
    // dispatching agent's ceiling (fail-closed). The child's own dispatchContext
    // below is for its grandchildren; this is the ceiling that bounds the child.
    ...(options._permissionCeiling ? { permissionCeiling: options._permissionCeiling } : {}),
    ...(typeof def.maxTurns === "number" ? { maxSteps: def.maxTurns } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    // Live progress: stream the child's tool-call/result events into the
    // subagent runtime store so its card updates while the run is in flight.
    ...(options._onEvent ? { onEvent: options._onEvent } : {}),
    // Only thread a dispatch context when this child is allowed to nest — that
    // is what re-exposes `dispatch_agent` to it (gated by depth in build-options).
    ...(def.allowNesting && typeof effectiveMaxDepth === "number"
      ? {
          dispatchContext: {
            depth: childDepth,
            maxDepth: effectiveMaxDepth,
            parentChain: childChain,
            selfRunId: runId,
            ...(typeof deadlineMs === "number" ? { deadlineMs } : {}),
            ...(options._budgetRootRunId ? { budgetRootRunId: options._budgetRootRunId } : {}),
          },
        }
      : {}),
  })

  // Draw the run's usage down the shared subtree budget (best-effort — the
  // root dispatch creates the guard with the real limit).
  if (options._budgetRootRunId && result.usage) {
    getDispatchBudget(options._budgetRootRunId)?.add({
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    })
  }

  return {
    text: result.text,
    channel: result.channel,
    toolsAvailable: result.toolsAvailable,
    runId,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  }
}

/**
 * Resolve (reuse or spawn) an external CLI agent from a preset and run one
 * prompt through it (Thread A2). Throws on unknown preset or a failure result.
 */
async function runExternalSubagent(
  presetId: string,
  prompt: string,
  def: PluginSubagentDef,
  options: PluginDispatchSubagentOptions
): Promise<PluginSubagentDispatchResult> {
  const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
  const { createAgentFromPreset, isFromPreset } = await import("@/lib/ai/agent/external/presets")
  const manager = getExternalAgentManager()

  const existing = manager.getAllAgents().find((inst) => isFromPreset(inst.config) === presetId)
  let agentId: string
  if (existing) {
    agentId = existing.config.id
  } else {
    const config = createAgentFromPreset(presetId)
    if (!config) {
      throw new Error(`dispatchSubagent: external preset "${presetId}" is not registered`)
    }
    await manager.addAgent(config)
    agentId = config.id
  }

  const result = await manager.execute(agentId, prompt, {
    ...(def.prompt ? { systemPrompt: def.prompt } : {}),
    ...(options.cwd ? { workingDirectory: options.cwd } : {}),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  })

  if (!result.success) {
    throw new Error(
      result.error || `dispatchSubagent: external agent ${agentId} returned a failure`
    )
  }

  return {
    text: result.finalResponse ?? "",
    channel: "external",
    toolsAvailable: true,
    ...(result.tokenUsage
      ? {
          usage: {
            inputTokens: result.tokenUsage.promptTokens,
            outputTokens: result.tokenUsage.completionTokens,
            totalTokens: result.tokenUsage.totalTokens,
          },
        }
      : {}),
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
    origin: options.origin ?? "plugin",
    ...(options.ultracode !== undefined ? { ultracode: options.ultracode } : {}),
  })

  const team = agentTeamManager.get(teamId)
  return { teamId, status: team?.status ?? "unknown" }
}
