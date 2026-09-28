import Dexie, { type Subscription } from "dexie"
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

function currentDatabaseGuard(): () => boolean {
  const database = getDb()
  return () => getDb() === database
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Dexie.AbortError("Execution projection database changed")
}

/**
 * Bind an execution run to the IM conversation that started it.
 *
 * Exported because the Agent Team bridge needs the identical rules — the
 * `liveActivity` opt-out, the delivery-target resolution, and the idempotent
 * id — and a second copy would drift. Without a binding row the run-presentation
 * runner has nothing to project onto and `callback-authorization` rejects every
 * control callback with `run_conversation_mismatch`, so a run with no binding
 * is not merely uncarded: it is uncontrollable.
 */
export async function ensureConnectorRunBinding(
  runId: string,
  projectId: string | undefined,
  session: ChatSession,
  isCurrent = currentDatabaseGuard()
): Promise<void> {
  const platformBinding = session.platformBinding
  if (!platformBinding) return
  const override = await readForResolution(platformBinding.conversationKey)
  assertCurrent(isCurrent)
  if (override?.liveActivity === false) return
  const deliveryTarget =
    platformBinding.deliveryTarget ??
    (await getConnectorConversationState(platformBinding.conversationKey))?.deliveryTarget
  assertCurrent(isCurrent)
  if (!deliveryTarget) return
  const id = bindingId(runId, platformBinding.adapterId, platformBinding.conversationKey)
  if (await getDb().executionRunBindings.get(id)) return
  assertCurrent(isCurrent)
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

async function ensureRun(
  input: {
    kind: AgentStateKind
    sourceId: string
    session: ChatSession
    projectId?: string
    title: string
    startedAt: number
  },
  isCurrent: () => boolean
): Promise<string> {
  assertCurrent(isCurrent)
  const runId = agentStateExecutionRunId(input.kind, input.sourceId)
  if (!(await getExecutionRun(runId))) {
    assertCurrent(isCurrent)
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
  assertCurrent(isCurrent)
  await ensureConnectorRunBinding(runId, input.projectId, input.session, isCurrent)
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
    // A rejected plan never ran: the run it projects was declined, which the
    // execution vocabulary spells `cancelled`.
    case "rejected":
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

export async function syncGoalExecutionRun(
  goal: Goal,
  session: ChatSession,
  isCurrent = currentDatabaseGuard()
): Promise<void> {
  const runId = await ensureRun(
    {
      kind: "goal",
      sourceId: goal.id,
      session,
      projectId: goal.projectId ?? session.projectId,
      title: goal.safeObjective || "Goal",
      startedAt: goal.createdAt,
    },
    isCurrent
  )
  assertCurrent(isCurrent)
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
  assertCurrent(isCurrent)
  const current = (await getExecutionRun(runId))?.latestSnapshot?.status ?? "queued"
  assertCurrent(isCurrent)
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

export async function syncPlanExecutionRun(
  plan: AgentPlan,
  session: ChatSession,
  isCurrent = currentDatabaseGuard()
): Promise<void> {
  const runId = await ensureRun(
    {
      kind: "plan",
      sourceId: plan.id,
      session,
      projectId: plan.projectId ?? session.projectId,
      title: plan.title || "Plan",
      startedAt: plan.createdAt,
    },
    isCurrent
  )
  assertCurrent(isCurrent)
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
  assertCurrent(isCurrent)
  const current = (await getExecutionRun(runId))?.latestSnapshot?.status ?? "queued"
  assertCurrent(isCurrent)
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

type BridgeOwner = {
  databaseName: string
  subscription: Subscription | null
  references: number
}
let activeBridge: BridgeOwner | null = null

function releaseBridge(owner: BridgeOwner): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    owner.references -= 1
    if (owner.references === 0) {
      owner.subscription?.unsubscribe()
      if (activeBridge === owner) activeBridge = null
    }
  }
}

export function startAgentStateExecutionBridge(): () => void {
  const databaseName = getDb().name
  if (activeBridge?.databaseName === databaseName) {
    activeBridge.references += 1
    return releaseBridge(activeBridge)
  }
  stopAgentStateExecutionBridge()
  const owner: BridgeOwner = { databaseName, subscription: null, references: 1 }
  activeBridge = owner
  const isCurrent = () => activeBridge === owner && getDb().name === databaseName
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  owner.subscription = Dexie.liveQuery(async () => {
    assertCurrent(isCurrent)
    // Schema upgrades can replace the Dexie connection without changing scope.
    const database = getDb()
    const [goals, plans, sessions] = await Promise.all([
      database.chatGoals.toArray(),
      database.agentPlans.toArray(),
      database.sessions.toArray(),
    ])
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    return {
      goals: goals.flatMap((goal) => {
        const session = sessionsById.get(goal.sessionId)
        return session ? [{ goal, session }] : []
      }),
      plans: plans.flatMap((plan) => {
        const session = sessionsById.get(plan.sessionId)
        return session ? [{ plan, session }] : []
      }),
    }
  }).subscribe({
    next(rows) {
      if (!isCurrent()) return
      for (const { goal, session } of rows.goals) {
        void syncGoalExecutionRun(goal, session, isCurrent).catch((error) => {
          if (!isCurrent()) return
          console.error(
            `[agent-state-execution-bridge] goal sync failed for goal=${goal.id}`,
            error
          )
        })
      }
      for (const { plan, session } of rows.plans) {
        void syncPlanExecutionRun(plan, session, isCurrent).catch((error) => {
          if (!isCurrent()) return
          console.error(
            `[agent-state-execution-bridge] plan sync failed for plan=${plan.id}`,
            error
          )
        })
      }
    },
    error(error) {
      if (!isCurrent()) return
      console.error("[agent-state-execution-bridge] subscription failed", error)
    },
  })
  return releaseBridge(owner)
}

function stopAgentStateExecutionBridge(): void {
  activeBridge?.subscription?.unsubscribe()
  activeBridge = null
}

export function __resetAgentStateExecutionBridgeForTesting(): void {
  stopAgentStateExecutionBridge()
}
