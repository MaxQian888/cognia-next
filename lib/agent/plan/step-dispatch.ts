/**
 * Per-kind execution for one `PlanStep` in the orchestrated path (ADR-0045 P2).
 *
 * `dispatchPlanStepNode` is the body of the `action.plan.step.dispatch` node
 * executor, isolated here so it's unit-testable without the workflow
 * orchestrator. It marks the step in_progress, runs the kind-specific work via
 * `runStepWork`, then writes completed / failed back through the run context's
 * writer.
 *
 * Implemented kinds: `agent_turn` (headless `executeAgent`), `approval_gate`
 * (`lib/runtime/approval-bus`), `sub_workflow` (nested `runWorkflow`),
 * `tool_call` (a single plugin-registered tool via `invokePluginTool`), and
 * `teammate_dispatch` (one teammate turn via the team subsystem's
 * `dispatchTeammate`, adapted through `createPlanTeammateRunContext`).
 */

import type { StepExecutionResult, TriggerEvent } from "@/types/workflow/visual"
import type { PlanStep } from "@/types/agent/plan"
import type { AgentTeammate } from "@/types/agent/agent-team"
import type { PlanRunContext } from "./plan-run-context"

/** The approval-bus scope plan `approval_gate` steps wait on. */
export const PLAN_APPROVAL_SCOPE = "agent-plan"

/** Build the approval-bus key for a plan step's approval gate. */
export function planApprovalKey(planId: string, stepId: string): { scope: string; id: string } {
  return { scope: PLAN_APPROVAL_SCOPE, id: `${planId}:${stepId}` }
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

interface StepWorkResult {
  value: unknown
  summary: string
}

/** Derive the turn/approval prompt text for a step. */
function stepPrompt(step: PlanStep): string {
  if (step.params?.kind === "agent_turn" && step.params.prompt) return step.params.prompt
  if (step.params?.kind === "approval_gate" && step.params.prompt) return step.params.prompt
  return step.description ? `${step.title}\n\n${step.description}` : step.title
}

/**
 * Best-effort, cyclic-safe one-line summary of a tool result for the step's
 * `result` field (the writer slices to 2000 chars). Never throws.
 */
function stringifySummary(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

async function runStepWork(
  runCtx: PlanRunContext,
  step: PlanStep,
  signal: AbortSignal
): Promise<StepWorkResult> {
  switch (step.kind) {
    case "agent_turn": {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      const result = await executeAgent(stepPrompt(step), {
        toolsEnabled: true,
        ...(runCtx.characterId ? { characterId: runCtx.characterId } : {}),
        abortSignal: signal,
      })
      return { value: { text: result.text, channel: result.channel }, summary: result.text }
    }

    case "approval_gate": {
      const { waitForDecision } = await import("@/lib/runtime/approval-bus")
      const decision = await waitForDecision(planApprovalKey(runCtx.planId, step.id), signal)
      if (decision.outcome === "reject") {
        throw nonRetryable(
          `plan approval gate rejected${decision.feedback ? `: ${decision.feedback}` : ""}`
        )
      }
      return { value: { outcome: decision.outcome }, summary: "approved" }
    }

    case "sub_workflow": {
      if (step.params?.kind !== "sub_workflow" || !step.params.workflowId) {
        throw nonRetryable("sub_workflow step requires params.workflowId")
      }
      const [{ getWorkflow }, { runWorkflow }] = await Promise.all([
        import("@/lib/db/workflows"),
        import("@/lib/workflow/runtime/orchestrator"),
      ])
      const sub = await getWorkflow(step.params.workflowId)
      if (!sub) throw nonRetryable(`sub_workflow: workflow "${step.params.workflowId}" not found`)
      const trigger: TriggerEvent = {
        workflowId: sub.id,
        kind: "trigger.manual",
        payload: step.params.triggerPayload ?? {},
        originAt: Date.now(),
      }
      const result = await runWorkflow({ workflow: sub, trigger, signal })
      if (result.status !== "succeeded") {
        throw new Error(`sub_workflow ended with status "${result.status}"`)
      }
      return { value: result.output, summary: `sub-workflow ${sub.name} completed` }
    }

    case "tool_call": {
      if (step.params?.kind !== "tool_call" || !step.params.toolName) {
        throw nonRetryable("tool_call step requires params.toolName")
      }
      const { toolName, input } = step.params
      const { resolvePluginToolByName, invokePluginTool, PluginToolInvocationError } =
        await import("@/lib/plugin/core/invoke-plugin-tool")
      const owner = await resolvePluginToolByName(toolName)
      if (!owner) {
        // Built-in cognia tools (Bash/Read/Edit/…) have no host-side single-call
        // executor — they run only inside an agent turn. MCP tools now have a
        // dedicated `mcp_tool_call` step kind.
        throw nonRetryable(
          `tool_call: no plugin-registered tool '${toolName}'. ` +
            "Built-in tools run only inside an agent turn (use an agent_turn step); " +
            "for MCP server tools use an mcp_tool_call step instead."
        )
      }
      try {
        const { result } = await invokePluginTool(owner.pluginId, toolName, input ?? {}, {
          signal,
          reason: "plan:tool_call",
          ...(runCtx.plan.sessionId ? { sessionId: runCtx.plan.sessionId } : {}),
        })
        return {
          value: { toolName, pluginId: owner.pluginId, data: result },
          summary: stringifySummary(result),
        }
      } catch (err) {
        // Config / permission / resolution failures are terminal; runtime
        // (`execution-failed`) and `aborted` stay retryable so the
        // orchestrator's retry budget applies. Mirrors `action.plugin.invoke`.
        if (
          err instanceof PluginToolInvocationError &&
          (err.code === "plugin-not-found" ||
            err.code === "plugin-disabled" ||
            err.code === "tool-not-found" ||
            err.code === "permission-denied")
        ) {
          throw nonRetryable(`tool_call '${toolName}': ${err.message}`)
        }
        throw err
      }
    }

    case "mcp_tool_call": {
      if (step.params?.kind !== "mcp_tool_call" || !step.params.serverId || !step.params.toolName) {
        throw nonRetryable("mcp_tool_call step requires params.serverId and params.toolName")
      }
      const { serverId, toolName, input } = step.params
      const [{ invokeMcpTool, McpServerNotFoundError }, { getPluginEventHooks }] =
        await Promise.all([import("@/lib/mcp/invoke"), import("@/lib/plugin")])
      const hooks = getPluginEventHooks()
      const args = input ?? {}
      // Fire the same plugin lifecycle hooks the workflow node fires — an MCP
      // call is an MCP call regardless of entry point.
      hooks.dispatchMCPServerConnect(serverId, serverId)
      hooks.dispatchMCPToolCall(serverId, toolName, args)
      try {
        const result = await invokeMcpTool({
          serverId,
          toolName,
          args,
          signal,
          scopeId: `run:${runCtx.runId}`,
          surface: "plan",
          clientInfo: { name: "cognia-plan", version: "1.0.0" },
        })
        hooks.dispatchMCPToolResult(serverId, toolName, {
          isError: result.isError,
          content: result.content,
          structuredContent: result.structuredContent,
        })
        return {
          value: { serverId, toolName, data: result },
          summary: stringifySummary(result.content),
        }
      } catch (err) {
        // Server-not-found is a config error → terminal; connection / runtime
        // failures stay retryable so the orchestrator's retry budget applies.
        if (err instanceof McpServerNotFoundError) {
          throw nonRetryable(`mcp_tool_call '${toolName}': ${err.message}`)
        }
        throw err
      } finally {
        hooks.dispatchMCPServerDisconnect(serverId)
      }
    }

    case "teammate_dispatch": {
      if (step.params?.kind !== "teammate_dispatch" || !step.params.teamId) {
        throw nonRetryable("teammate_dispatch step requires params.teamId")
      }
      const { teamId, teammateId, spawnPrompt } = step.params
      const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store/store")
      const state = useAgentTeamStore.getState()
      const team = state.teams[teamId]
      if (!team) {
        // Team definitions persist across restart (Scheduler Phase D); a miss
        // means the team was never created or was deleted.
        throw nonRetryable(
          `teammate_dispatch: team '${teamId}' is not loaded — create the team before dispatching to it`
        )
      }
      let teammates: AgentTeammate[]
      if (teammateId) {
        const tm = state.teammates[teammateId]
        if (!tm) throw nonRetryable(`teammate_dispatch: teammate '${teammateId}' not found`)
        teammates = [tm]
      } else {
        teammates = (team.teammateIds ?? [])
          .map((id) => state.teammates[id])
          .filter((t): t is AgentTeammate => t !== undefined)
      }
      if (teammates.length === 0) {
        throw nonRetryable(`teammate_dispatch: team '${teamId}' has no resolvable teammates`)
      }
      const [{ createPlanTeammateRunContext }, { dispatchTeammate }] = await Promise.all([
        import("./plan-teammate-context"),
        import("@/lib/ai/agent/team/dispatch-teammate"),
      ])
      const teamCtx = createPlanTeammateRunContext({ runId: runCtx.runId, team, teammates })
      const result = await dispatchTeammate(teamCtx, {
        taskId: step.id,
        prompt: spawnPrompt?.trim() || stepPrompt(step),
        signal,
        validateOutput: true,
        recordToStore: false,
      })
      return {
        value: {
          text: result.text,
          teammateId: result.teammateId,
          teammateName: result.teammateName,
          channel: result.channel,
          usage: result.usage,
        },
        summary: result.text,
      }
    }

    default: {
      const exhaustive: never = step.kind
      throw nonRetryable(`unknown plan step kind: ${String(exhaustive)}`)
    }
  }
}

/**
 * Execute one plan step, writing its status transitions through the run
 * context. Returns the workflow node result. On failure the step is marked
 * `failed` and the error is re-thrown so the orchestrator's retry / error
 * policy applies.
 */
export async function dispatchPlanStepNode(
  runCtx: PlanRunContext,
  stepId: string,
  signal: AbortSignal
): Promise<StepExecutionResult> {
  const step = runCtx.plan.steps.find((s) => s.id === stepId)
  if (!step) {
    throw nonRetryable(`action.plan.step.dispatch: step "${stepId}" not in plan "${runCtx.planId}"`)
  }

  const startedAt = Date.now()
  await runCtx.writer.setStepStatus(step.id, "in_progress", { startedAt })

  try {
    const work = await runStepWork(runCtx, step, signal)
    const completedAt = Date.now()
    await runCtx.writer.setStepStatus(step.id, "completed", {
      result: work.summary.slice(0, 2000),
      output: work.value,
      completedAt,
      actualDurationMs: completedAt - startedAt,
    })
    return { output: work.value }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await runCtx.writer.setStepStatus(step.id, "failed", {
      error: message,
      completedAt: Date.now(),
      attempts: (step.attempts ?? 0) + 1,
    })
    throw err
  }
}
