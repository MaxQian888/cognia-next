/**
 * Agent-team surface nodes — expose the multi-bot / Agent Team programmable
 * interfaces to the visual workflow editor:
 *
 * - `action.team.compose`  — auto-orchestrate a team from one objective
 *   (`planAutoOrchestration` → `materializeProposal`), optionally starting it.
 * - `action.team.status`   — read-only snapshot of a team (status, final
 *   result, tasks / teammates / delegations on demand).
 * - `action.team.delegate` — delegate a sub-problem on behalf of a team to a
 *   twin / background agent / external agent / another team.
 * - `action.team.message`  — post into the team chat / blackboard.
 *
 * All four run in the renderer (Zustand store + renderer LLM client); none
 * require Tauri. Compose is PII-gated fail-closed inside
 * `planAutoOrchestration` before any model call.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { TeamExecutionPattern } from "@/types/agent/agent-team"

export interface TeamComposeParams {
  objective?: string
  name?: string
  maxRoster?: number
  preferredPattern?: TeamExecutionPattern
  /** Start the team lifecycle right after materialization (waits for terminal). */
  autoStart?: boolean
  ultracode?: boolean
}

export interface TeamStatusParams {
  teamId?: string
  includeTasks?: boolean
  includeTeammates?: boolean
  includeDelegations?: boolean
}

export interface TeamDelegateParams {
  teamId?: string
  target?: "twin" | "background" | "external" | "team"
  /** Existing team task id; a tracking task is created when omitted. */
  taskId?: string
  prompt?: string
  systemPrompt?: string
  reason?: string
  twinId?: string
  targetTeamId?: string
  targetAgentId?: string
  /** Await the delegation's terminal state (default true). */
  awaitCompletion?: boolean
  /** Launch even inside the team's quiet-hours window. */
  force?: boolean
  ultracode?: boolean
}

export interface TeamMessageParams {
  teamId?: string
  content?: string
  senderId?: string
  recipientId?: string
  taskId?: string
}

// ── action.team.compose ─────────────────────────────────────────────────────

export async function runTeamCompose(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as TeamComposeParams
  const objective = params.objective?.trim()
  if (!objective) throw nonRetryable("action.team.compose requires a non-empty 'objective'")

  const [{ useSettingsStore }, { buildRendererLlmClient }] = await Promise.all([
    import("@/stores/settings/settings-store"),
    import("@/lib/ai/renderer-llm-client"),
  ])
  const client = buildRendererLlmClient({
    session: null,
    appSettings: useSettingsStore.getState().settings,
    featureId: "workflow.team.compose",
  })
  if (!client) {
    throw nonRetryable(
      "action.team.compose: no renderer-side LLM provider is configured (a provider with a renderer API key is required)"
    )
  }

  const { planAutoOrchestration, AutoOrchestrationPiiError } =
    await import("@/lib/ai/agent/team/auto/auto-orchestrate")
  let proposal
  try {
    proposal = await planAutoOrchestration({
      objective,
      client,
      ...(params.maxRoster !== undefined ? { maxRoster: params.maxRoster } : {}),
      ...(params.preferredPattern ? { preferredPattern: params.preferredPattern } : {}),
      signal: ctx.signal,
    })
  } catch (err) {
    if (err instanceof AutoOrchestrationPiiError) throw nonRetryable(err.message)
    throw err
  }

  const { materializeProposal } = await import("@/lib/ai/agent/team/auto/materialize")
  const result = materializeProposal(proposal, {
    ...(params.name?.trim() ? { name: params.name.trim() } : {}),
  })
  ctx.log("info", "team composed", {
    teamId: result.teamId,
    roster: proposal.roster.length,
    tasks: proposal.tasks.length,
    pattern: proposal.assessment.recommendedPattern,
  })

  let started = false
  let finalStatus: string | undefined
  let finalResult: string | undefined
  if (params.autoStart) {
    const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
    await agentTeamManager
      .start(result.teamId, {
        ...(params.ultracode !== undefined ? { ultracode: params.ultracode } : {}),
      })
      .catch((err: unknown) => {
        throw nonRetryable(
          `action.team.compose: team start failed — ${err instanceof Error ? err.message : String(err)}`
        )
      })
    started = true
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const team = useAgentTeamStore.getState().getTeam(result.teamId)
    finalStatus = team?.status
    finalResult = team?.finalResult
  }

  return {
    output: {
      teamId: result.teamId,
      leadId: result.leadId,
      teammateIds: result.teammateIds,
      taskIds: result.taskIds,
      pattern: proposal.assessment.recommendedPattern,
      assessmentReason: proposal.assessment.reason,
      started,
      ...(finalStatus !== undefined ? { status: finalStatus } : {}),
      ...(finalResult !== undefined ? { finalResult } : {}),
    },
  }
}

// ── action.team.status ──────────────────────────────────────────────────────

export async function runTeamStatus(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as TeamStatusParams
  const teamId = params.teamId?.trim()
  if (!teamId) throw nonRetryable("action.team.status requires 'teamId'")

  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  const store = useAgentTeamStore.getState()
  const team = store.getTeam(teamId)
  if (!team) throw nonRetryable(`action.team.status: team ${teamId} not found`)

  const tasks = store.getTeamTasks(teamId)
  const taskCounts: Record<string, number> = {}
  for (const task of tasks) {
    taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1
  }

  return {
    output: {
      teamId,
      name: team.name,
      status: team.status,
      task: team.task,
      finalResult: team.finalResult,
      error: team.error,
      taskCounts,
      taskTotal: tasks.length,
      ...(params.includeTasks !== false
        ? {
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              assignedTo: t.assignedTo,
              result: t.result,
              error: t.error,
            })),
          }
        : {}),
      ...(params.includeTeammates !== false
        ? {
            teammates: store.getTeammates(teamId).map((m) => ({
              id: m.id,
              name: m.name,
              role: m.role,
              status: m.status,
            })),
          }
        : {}),
      ...(params.includeDelegations
        ? {
            delegations: Object.values(store.delegations)
              .filter((d) => d.sourceTeamId === teamId)
              .map((d) => ({
                id: d.id,
                targetType: d.targetType,
                targetId: d.targetId,
                status: d.status,
                result: d.result,
                error: d.error,
              })),
          }
        : {}),
    },
  }
}

// ── action.team.delegate ────────────────────────────────────────────────────

export async function runTeamDelegate(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as TeamDelegateParams
  const teamId = params.teamId?.trim()
  if (!teamId) throw nonRetryable("action.team.delegate requires 'teamId'")
  const target = params.target
  if (!target) throw nonRetryable("action.team.delegate requires 'target'")
  const prompt = params.prompt?.trim()
  if (target !== "team" && !prompt) {
    throw nonRetryable(`action.team.delegate: target '${target}' requires a non-empty 'prompt'`)
  }

  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  const store = useAgentTeamStore.getState()
  const team = store.getTeam(teamId)
  if (!team) throw nonRetryable(`action.team.delegate: team ${teamId} not found`)

  const reason = params.reason?.trim() || `workflow ${ctx.workflowId} step ${ctx.stepId} delegation`

  // Delegation records reference a source task; create a tracking task when
  // the workflow author didn't point at an existing one.
  let taskId = params.taskId?.trim()
  if (!taskId) {
    const tracking = store.createTask({
      teamId,
      title: reason.slice(0, 80),
      description: prompt ?? reason,
      assignedTo: team.leadId,
      metadata: { workflowRunId: ctx.runId, workflowStepId: ctx.stepId },
    })
    taskId = tracking.id
  }

  const orchestrator = await import("@/lib/ai/agent/team/delegation-orchestrator")
  let launched: {
    delegation: import("@/types/agent/agent-team").TeamDelegationRecord
    completionPromise: Promise<import("@/types/agent/agent-team").TeamDelegationRecord>
  }
  switch (target) {
    case "twin": {
      const twinId = params.twinId?.trim()
      if (!twinId) throw nonRetryable("action.team.delegate: target 'twin' requires 'twinId'")
      launched = orchestrator.delegateToTwin({
        sourceTeamId: teamId,
        sourceTaskId: taskId,
        twinId,
        prompt: prompt as string,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        reason,
        ...(params.force !== undefined ? { force: params.force } : {}),
      })
      break
    }
    case "background": {
      launched = orchestrator.delegateToBackground({
        sourceTeamId: teamId,
        sourceTaskId: taskId,
        prompt: prompt as string,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        reason,
        ...(params.force !== undefined ? { force: params.force } : {}),
      })
      break
    }
    case "external": {
      const targetAgentId = params.targetAgentId?.trim()
      if (!targetAgentId) {
        throw nonRetryable("action.team.delegate: target 'external' requires 'targetAgentId'")
      }
      launched = orchestrator.delegateToExternal({
        sourceTeamId: teamId,
        sourceTaskId: taskId,
        targetAgentId,
        prompt: prompt as string,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        reason,
        ...(params.force !== undefined ? { force: params.force } : {}),
      })
      break
    }
    case "team": {
      const targetTeamId = params.targetTeamId?.trim()
      if (!targetTeamId) {
        throw nonRetryable("action.team.delegate: target 'team' requires 'targetTeamId'")
      }
      launched = orchestrator.delegateToTeam({
        sourceTeamId: teamId,
        sourceTaskId: taskId,
        targetTeamId,
        reason,
        ...(params.force !== undefined ? { force: params.force } : {}),
        ...(params.ultracode !== undefined ? { ultracode: params.ultracode } : {}),
      })
      break
    }
    default:
      throw nonRetryable(`action.team.delegate: unknown target '${String(target)}'`)
  }

  ctx.log("info", "delegation launched", {
    delegationId: launched.delegation.id,
    target,
    status: launched.delegation.status,
  })

  const record =
    params.awaitCompletion !== false ? await launched.completionPromise : launched.delegation

  // A delegation the orchestrator itself settled as failed is a step failure
  // (visible to errorPolicy) rather than a silently-successful output.
  if (
    params.awaitCompletion !== false &&
    (record.status === "failed" || record.status === "timeout")
  ) {
    throw nonRetryable(
      `action.team.delegate: delegation ${record.id} ${record.status}${record.error ? ` — ${record.error}` : ""}`
    )
  }

  return {
    output: {
      delegationId: record.id,
      teamId,
      taskId,
      target,
      targetId: record.targetId,
      status: record.status,
      result: record.result,
      error: record.error,
    },
  }
}

// ── action.team.message ─────────────────────────────────────────────────────

export async function runTeamMessage(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as TeamMessageParams
  const teamId = params.teamId?.trim()
  if (!teamId) throw nonRetryable("action.team.message requires 'teamId'")
  const content = params.content?.trim()
  if (!content) throw nonRetryable("action.team.message requires a non-empty 'content'")

  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  const store = useAgentTeamStore.getState()
  const team = store.getTeam(teamId)
  if (!team) throw nonRetryable(`action.team.message: team ${teamId} not found`)

  const message = store.addMessage({
    teamId,
    senderId: params.senderId?.trim() || team.leadId,
    content,
    ...(params.recipientId?.trim() ? { recipientId: params.recipientId.trim() } : {}),
    ...(params.taskId?.trim() ? { taskId: params.taskId.trim() } : {}),
    metadata: { workflowRunId: ctx.runId, workflowStepId: ctx.stepId },
  })

  return {
    output: {
      messageId: message.id,
      teamId,
      senderId: message.senderId,
      recipientId: message.recipientId,
    },
  }
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}
