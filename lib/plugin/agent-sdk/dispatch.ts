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
import { assertNoLeakingPiiDeep } from "@/lib/plugin/api/plugin-pii-gate"
import { getDispatchBudget, isDispatchBudgetExhausted } from "@/lib/claude/agents/dispatch-budget"
import {
  envelopeForBudgetExhausted,
  envelopeForRejection,
} from "@/lib/claude/agents/dispatch-error"

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
    errorEnvelope: envelopeForRejection(rejection),
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

  const pluginId = thisId.includes(":") ? thisId.slice(0, thisId.indexOf(":")) : "<builtin>"
  assertNoLeakingPiiDeep(pluginId, "plugin.agent.dispatchSubagent", [prompt, def.prompt])

  // ── Policy guards (fail-closed; the enum can drift within a session) ──────
  // `disabled` defs and settings-level dispatch-rule denials are refused even
  // when a stale tool schema still advertises the id.
  if (def.disabled) {
    return rejectionResult(runId, {
      reason: "policy",
      message: `Dispatch refused — subagent "${thisId}" is disabled.`,
    })
  }
  if (!(await isDispatchAllowedByPolicy(thisId))) {
    return rejectionResult(runId, {
      reason: "policy",
      message: `Dispatch refused — subagent "${thisId}" is denied by the dispatch policy.`,
    })
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
    const message = "Dispatch refused — the token budget for this dispatch subtree is exhausted."
    return {
      text: message,
      channel: "text",
      toolsAvailable: false,
      finishReason: "error",
      runId,
      depthExhausted: true,
      errorEnvelope: envelopeForBudgetExhausted(message),
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

  // ADR-0090 Phase 6: the unified authority resolves the child's frozen spec
  // (surface "plugin") behind the resolver flag; legacy executeAgent otherwise.
  const { executeAgentTurnFromRenderer } =
    await import("@/lib/ai/agent/execution/agent-execution-service")
  const result = await executeAgentTurnFromRenderer(
    prompt,
    {
      // An explicit empty list is a deny-all declaration. Force the executor's
      // top-level tool switch off as well because downstream option synthesis
      // intentionally omits empty allowlists.
      toolsEnabled: def.tools?.length === 0 ? false : (options.toolsEnabled ?? true),
      // Every run dispatched here is a subagent. Without a dispatchContext (leaf,
      // allowNesting unset) build-options must WITHHOLD dispatch_agent — including
      // the plan-mode force-offer — instead of treating the child as top-level.
      isDispatchedSubagent: true,
      ...(def.prompt ? { systemPrompt: def.prompt } : {}),
      ...(def.model ? { model: def.model } : {}),
      // Cross-provider subagent: route the run to the def's provider (with its own
      // credentials) instead of the dispatching session's provider.
      ...(def.provider ? { provider: def.provider } : {}),
      ...(def.tools !== undefined ? { allowedTools: def.tools } : {}),
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
      // Managed/headless projections have no Cognia chat pane to own approval
      // requests. Thread their correlated responder into the canonical
      // executor permission seam instead of creating a second tool gate.
      ...(options._canUseTool ? { canUseTool: options._canUseTool } : {}),
      // Permission-ask routing: surface the child's asks in the PARENT chat
      // session (instead of the legacy silent auto-deny against the unopened
      // ephemeral session).
      ...(options._approvalRoute ? { approvalRoute: options._approvalRoute } : {}),
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
    },
    { surface: "plugin" }
  )

  // Draw the run's usage down the shared subtree budget (best-effort — the
  // root dispatch creates the guard with the real limit).
  if (options._budgetRootRunId && result.usage) {
    getDispatchBudget(options._budgetRootRunId)?.add({
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    })
  }

  // ADR-0090 Phase 7: classify this dispatch's delegation mode at RUNTIME
  // (not just in the editor preview). The parent baseline and the child spec
  // implied by the def resolve through the same authority; a def that pins a
  // different provider/runtime is an orchestrated child by construction —
  // native delegation can never smuggle a route/provider/credential change.
  let delegation:
    import("@/lib/ai/agent/execution/delegation-mode").DelegationModeDecision | undefined
  if (result.runtime) {
    try {
      const [{ decideDelegationMode }, { resolveAgentExecutionSpec }, { getAgentExecutionFlags }] =
        await Promise.all([
          import("@/lib/ai/agent/execution/delegation-mode"),
          import("@/lib/ai/agent/execution/resolve-agent-execution-spec"),
          import("@/lib/ai/agent/execution/feature-flags"),
        ])
      const { isTauri } = await import("@/lib/tauri")
      const base = {
        surface: "plugin" as const,
        environment: { isTauri: isTauri(), isHeadlessHost: false },
        flags: getAgentExecutionFlags(),
      }
      const parent = resolveAgentExecutionSpec({ ...base, legacy: { toolsEnabled: true } }).spec
      const child = resolveAgentExecutionSpec({
        ...base,
        legacy: { toolsEnabled: true, providerId: def.provider },
      }).spec
      delegation = decideDelegationMode(parent, child)
    } catch {
      // Classification is observability — never fail a finished dispatch.
    }
  }

  return {
    text: result.text,
    channel: result.channel,
    toolsAvailable: result.toolsAvailable,
    runId,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.runtime ? { runtime: result.runtime } : {}),
    ...(result.routeKind ? { routeKind: result.routeKind } : {}),
    ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    ...(delegation
      ? { delegationMode: delegation.mode, delegationReasons: delegation.reasons }
      : {}),
  }
}

/**
 * Settings-level dispatch policy over the projected subagent id. Best-effort
 * read (unreadable settings ⇒ allow — the pre-existing behavior); the verdict
 * itself is fail-closed for explicit denials.
 */
async function isDispatchAllowedByPolicy(subagentId: string): Promise<boolean> {
  try {
    const [{ getSettings }, { isSubagentDispatchAllowed }] = await Promise.all([
      import("@/lib/db/settings"),
      import("@/lib/claude/agents/subagent-dispatch-policy"),
    ])
    const settings = await getSettings()
    return isSubagentDispatchAllowed(settings?.agentPermissions?.subagentRules, subagentId)
  } catch {
    return true
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
  const [
    { getExternalAgentManager },
    { createAgentFromPreset, isFromPreset },
    { supportsExternalAgents },
  ] = await Promise.all([
    import("@/lib/ai/agent/external/manager"),
    import("@/lib/ai/agent/external/presets"),
    import("@/lib/ai/agent/external/agent-transport"),
  ])

  // External CLIs only run on the desktop / headless host — never in the browser
  // shell. Fail loudly with an actionable message instead of an opaque spawn
  // error deep inside the manager.
  if (!supportsExternalAgents()) {
    throw new Error(
      `dispatchSubagent: external agent "${presetId}" requires the Cognia desktop app (external CLI agents don't run in the browser shell).`
    )
  }

  const manager = getExternalAgentManager()
  const existing = manager.getAllAgents().find((inst) => isFromPreset(inst.config) === presetId)
  let agentId: string
  if (existing) {
    agentId = existing.config.id
  } else {
    const config = createAgentFromPreset(presetId)
    if (!config) {
      throw new Error(
        `dispatchSubagent: external preset "${presetId}" is not registered — enable the plugin that contributes it, or use a built-in preset.`
      )
    }
    await manager.addAgent(config)
    agentId = config.id
  }

  // Clamp the child's tool surface against the dispatching agent's permission
  // ceiling (fail-closed) and derive the external permission mode from it.
  const { deriveExternalSessionPermission } =
    await import("@/lib/ai/agent/external/permission-cascade")
  const merged = deriveExternalSessionPermission(
    options._permissionCeiling ?? {},
    def.tools !== undefined ? { allowedTools: def.tools } : {}
  )

  // Forward the subagent's declared MCP servers into the external agent's ACP
  // session (`session/new` mcpServers) so it can call the same tools a built-in
  // teammate would (the external CLI keeps its own MCP config in addition). Only
  // the explicitly-listed enabled servers are forwarded — never "all".
  let mcpServers: import("@/types/agent/external-agent").AcpMcpServerConfig[] = []
  if (def.mcpServerIds && def.mcpServerIds.length > 0) {
    const { resolveAcpMcpServers } = await import("@/lib/ai/agent/external/resolve-acp-mcp-servers")
    mcpServers = await resolveAcpMcpServers(def.mcpServerIds)
  }

  // Live progress: translate the external protocol stream into the same
  // CaptureStreamEvent shape the subagent runtime store already renders, so an
  // external subagent lights up `SubagentPart`'s live progress like a built-in.
  const { pipeExternalEventsToCapture } =
    await import("@/lib/ai/agent/external/external-event-progress")
  const onEvent = options._onEvent ? pipeExternalEventsToCapture(options._onEvent) : undefined

  const result = await manager.execute(agentId, prompt, {
    ...(def.prompt ? { systemPrompt: def.prompt } : {}),
    // Honor the subagent's declared model on the external CLI too (the sidecar
    // path already threads `def.model`). Best-effort per the manager.
    ...(def.model ? { model: def.model } : {}),
    ...(merged.permissionMode ? { permissionMode: merged.permissionMode } : {}),
    ...(merged.allowedTools ? { allowedTools: merged.allowedTools } : {}),
    ...(mcpServers.length > 0 ? { context: { custom: { mcpServers } } } : {}),
    ...(options.cwd ? { workingDirectory: options.cwd } : {}),
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    ...(onEvent ? { onEvent } : {}),
    ...(options._canUseTool
      ? {
          onPermissionRequest: async (
            request: import("@/types/agent/external-agent").AcpPermissionRequest
          ) => {
            const decision = await options._canUseTool!(
              request.toolInfo.name,
              request.rawInput ?? {},
              { signal: options.abortSignal }
            )
            const granted = decision.behavior === "allow"
            const selected = request.options?.find((option) =>
              granted
                ? option.kind === "allow_once" || option.kind === "allow_always"
                : option.kind === "reject_once" || option.kind === "reject_always"
            )
            return {
              requestId: request.requestId ?? request.id,
              granted,
              ...(selected ? { optionId: selected.optionId } : {}),
              ...(decision.behavior === "deny" ? { reason: decision.message } : {}),
              scope: "once" as const,
            }
          },
        }
      : {}),
  })

  if (!result.success) {
    throw new Error(
      result.error ||
        `dispatchSubagent: external agent "${presetId}" (${agentId}) returned a failure.`
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
