import { liveQuery, type Subscription } from "dexie"
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  putExecutionRunBinding,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import type { Goal } from "@/types/goal"
import type { AgentPlan, PlanStepStatus } from "@/types/agent/plan"
import type {
  ExecutionRunKind,
  ExecutionRunStatus,
  RunEventType,
  RunStepStatus,
} from "@/types/execution/run"

type AgentStateKind = Extract<ExecutionRunKind, "goal" | "plan">

export function agentStateExecutionRunId(kind: AgentStateKind, sourceId: string): string {
  return `execution:${kind}:${sourceId}`
}

function bindingId(runId: string, adapterId: string, conversationKey: string): string {
  return `execution-binding:${runId}:${adapterId}:${conversationKey}`
}

async function ensureBinding(
  runId: string,
  projectId: string | undefined,
  session: ChatSession
): Promise<void> {
  const platformBinding = session.platformBinding
  if (!platformBinding) return
  const override = await readForResolution(platformBinding.conversationKey)
  if (override?.liveActivity === false) return
  const deliveryTarget =
    platformBinding.deliveryTarget ??
    (await getConnectorConversationState(platformBinding.conversationKey))?.deliveryTarget
  if (!deliveryTarget) return
  const id = bindingId(runId, platformBinding.adapterId, platformBinding.conversationKey)
  if (await getDb().executionRunBindings.get(id)) return
  const now = Date.now()
  await putExecutionRunBinding({
    id,
    runId,
    ...(projectId ? { projectId } : {}),
    adapterId: platformBinding.adapterId,
    conversationKey: platformBinding.conversationKey,
    status: "active",
    deliveryMode: "native",
    ...(deliveryTarget.sourceMessageId ? { sourceMessageId: deliveryTarget.sourceMessageId } : {}),
    deliveryTarget,
    lastProjectedRevision: 0,
    createdAt: now,
    updatedAt: now,
  })
}

async function ensureRun(input: {
  kind: AgentStateKind
  sourceId: string
  session: ChatSession
  projectId?: string
  title: string
  startedAt: number
}): Promise<string> {
  const runId = agentStateExecutionRunId(input.kind, input.sourceId)
  if (!(await getExecutionRun(runId))) {
    try {
      await createExecutionRun({
        id: runId,
        kind: input.kind,
        sourceId: input.sourceId,
        sessionId: input.session.id,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        title: input.title,
        status: "queued",
        currentRevision: 0,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
      })
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConstraintError")) throw error
    }
  }
  await ensureBinding(runId, input.projectId, input.session)
  return runId
}

function lifecycleEvent(
  current: ExecutionRunStatus,
  desired: ExecutionRunStatus
): RunEventType | undefined {
  if (current === desired || ["completed", "failed", "cancelled"].includes(current)) {
    return undefined
  }
  switch (desired) {
    case "running":
      return current === "paused" || current === "waiting" ? "run.resumed" : "run.started"
    case "waiting":
      return "run.waiting"
    case "paused":
      return "run.paused"
    case "completed":
      return "run.completed"
    case "failed":
      return "run.failed"
    case "cancelled":
      return "run.cancelled"
    default:
      return undefined
  }
}

function goalExecutionStatus(goal: Goal): ExecutionRunStatus {
  switch (goal.status) {
    case "active":
      return "running"
    case "paused":
      return goal.awaitingAcceptance ? "waiting" : "paused"
    case "completed":
      return "completed"
    case "stopped":
    case "preempted":
      return "cancelled"
    case "budget_limited":
    case "turn_limited":
    case "timed_out":
      return "failed"
  }
}

function planExecutionStatus(plan: AgentPlan): ExecutionRunStatus {
  switch (plan.status) {
    case "draft":
    case "approved":
    case "executing":
      return "running"
    case "awaiting_approval":
      return "waiting"
    case "paused":
      return "paused"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

function stepEventType(status: PlanStepStatus): RunEventType {
  switch (status) {
    case "pending":
    case "ready":
      return "step.added"
    case "in_progress":
      return "step.started"
    case "completed":
      return "step.completed"
    case "failed":
    case "blocked":
      return "step.failed"
    case "skipped":
      return "step.skipped"
  }
}

function runStepStatus(status: PlanStepStatus): RunStepStatus {
  return status === "ready" ? "pending" : status
}

export async function syncGoalExecutionRun(goal: Goal, session: ChatSession): Promise<void> {
  if (!session.platformBinding) return
  const runId = await ensureRun({
    kind: "goal",
    sourceId: goal.id,
    session,
    projectId: goal.projectId ?? session.projectId,
    title: "Goal",
    startedAt: goal.createdAt,
  })
  const steps = (goal.subgoals ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      id: step.id,
      status: step.done ? ("completed" as const) : ("pending" as const),
    }))
  const events = [
    semanticRunEvent(
      "plan.revised",
      { version: goal.updatedAt, steps },
      {
        ts: goal.updatedAt,
        sourceEventId: `goal:${goal.id}:plan:${goal.updatedAt}`,
      }
    ),
    ...steps.map((step) =>
      semanticRunEvent(
        step.status === "completed" ? "step.completed" : "step.added",
        { stepId: step.id },
        {
          ts: goal.updatedAt,
          sourceEventId: `goal:${goal.id}:step:${step.id}:${step.status}:${goal.updatedAt}`,
        }
      )
    ),
  ]
  await runEventJournal.appendBatch(runId, events)
  const current = (await getExecutionRun(runId))?.latestSnapshot?.status ?? "queued"
  const type = lifecycleEvent(current, goalExecutionStatus(goal))
  if (type) {
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        type,
        {},
        {
          ts: goal.updatedAt,
          sourceEventId: `goal:${goal.id}:status:${goal.status}:${goal.generationId}`,
        }
      )
    )
  }
}

export async function syncPlanExecutionRun(plan: AgentPlan, session: ChatSession): Promise<void> {
  if (!session.platformBinding) return
  const runId = await ensureRun({
    kind: "plan",
    sourceId: plan.id,
    session,
    projectId: plan.projectId ?? session.projectId,
    title: plan.title || "Plan",
    startedAt: plan.createdAt,
  })
  const steps = plan.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      id: step.id,
      sourceStatus: step.status,
      status: runStepStatus(step.status),
    }))
  await runEventJournal.appendBatch(runId, [
    semanticRunEvent(
      "plan.revised",
      { version: plan.updatedAt, steps },
      {
        ts: plan.updatedAt,
        sourceEventId: `plan:${plan.id}:revision:${plan.updatedAt}`,
      }
    ),
    ...steps.map((step) =>
      semanticRunEvent(
        stepEventType(step.sourceStatus),
        { stepId: step.id },
        {
          ts: plan.updatedAt,
          sourceEventId: `plan:${plan.id}:step:${step.id}:${step.status}:${plan.updatedAt}`,
        }
      )
    ),
  ])
  const current = (await getExecutionRun(runId))?.latestSnapshot?.status ?? "queued"
  const type = lifecycleEvent(current, planExecutionStatus(plan))
  if (type) {
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        type,
        {},
        {
          ts: plan.updatedAt,
          sourceEventId: `plan:${plan.id}:status:${plan.status}:${plan.generationId}`,
        }
      )
    )
  }
}

let subscription: Subscription | null = null

export function startAgentStateExecutionBridge(): () => void {
  if (subscription) return stopAgentStateExecutionBridge
  subscription = liveQuery(async () => {
    const [goals, plans, sessions] = await Promise.all([
      getDb().chatGoals.toArray(),
      getDb().agentPlans.toArray(),
      getDb().sessions.toArray(),
    ])
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    return {
      goals: goals.flatMap((goal) => {
        const session = sessionsById.get(goal.sessionId)
        return session?.platformBinding ? [{ goal, session }] : []
      }),
      plans: plans.flatMap((plan) => {
        const session = sessionsById.get(plan.sessionId)
        return session?.platformBinding ? [{ plan, session }] : []
      }),
    }
  }).subscribe({
    next(rows) {
      for (const { goal, session } of rows.goals) {
        void syncGoalExecutionRun(goal, session).catch((error) => {
          console.error(
            `[agent-state-execution-bridge] goal sync failed for goal=${goal.id}`,
            error
          )
        })
      }
      for (const { plan, session } of rows.plans) {
        void syncPlanExecutionRun(plan, session).catch((error) => {
          console.error(
            `[agent-state-execution-bridge] plan sync failed for plan=${plan.id}`,
            error
          )
        })
      }
    },
    error(error) {
      console.error("[agent-state-execution-bridge] subscription failed", error)
    },
  })
  return stopAgentStateExecutionBridge
}

function stopAgentStateExecutionBridge(): void {
  subscription?.unsubscribe()
  subscription = null
}

export function __resetAgentStateExecutionBridgeForTesting(): void {
  stopAgentStateExecutionBridge()
}
