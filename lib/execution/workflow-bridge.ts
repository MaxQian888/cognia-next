import { liveQuery, type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  putExecutionRunBinding,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { listForWorkflow } from "@/lib/db/workflow-fanout-subscriptions"
import { topoSort } from "@/lib/workflow/runtime/topo-sort"
import { mapWorkflowRunEvent } from "@/lib/execution/sources/workflow"
import type { WorkflowFanoutSubscriptionRow } from "@/lib/db/connector-types"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import type { ExecutionRunKind } from "@/types/execution/run"
import { startAgentStateExecutionBridge } from "./agent-state-bridge"

export function workflowExecutionRunId(sourceRunId: string): string {
  return `execution:workflow:${sourceRunId}`
}

function bindingId(runId: string, adapterId: string, conversationKey: string): string {
  return `execution-binding:${runId}:${adapterId}:${conversationKey}`
}

export function executionKindForWorkflowRun(sourceRun: WorkflowRunRow): ExecutionRunKind {
  if (sourceRun.triggerKind === "trigger.team") return "team"
  if (sourceRun.triggerKind === "trigger.cron") return "scheduled"
  return "workflow"
}

function stepPlan(row: WorkflowRunRow): Array<{ id: string; title: string }> {
  const labels = new Map(row.workflowSnapshot.nodes.map((node) => [node.id, node.data.label]))
  return topoSort(row.workflowSnapshot)
    .order.filter((id) => {
      const node = row.workflowSnapshot.nodes.find((candidate) => candidate.id === id)
      return node && !node.type.startsWith("trigger.")
    })
    .map((id) => ({ id, title: labels.get(id) ?? id }))
}

export async function syncWorkflowExecutionRun(
  sourceRun: WorkflowRunRow,
  sourceEvents: readonly WorkflowRunEventRow[],
  subscriptions: readonly WorkflowFanoutSubscriptionRow[]
): Promise<void> {
  const runId = workflowExecutionRunId(sourceRun.id)
  let run = await getExecutionRun(runId)
  if (!run) {
    try {
      await createExecutionRun({
        id: runId,
        kind: executionKindForWorkflowRun(sourceRun),
        sourceId: sourceRun.id,
        sessionId: sourceRun.triggeredBy?.sessionId,
        projectId: sourceRun.projectId,
        title: sourceRun.title ?? sourceRun.workflowSnapshot.name,
        initiator: sourceRun.triggeredBy?.initiator,
        status: "running",
        currentRevision: 0,
        startedAt: sourceRun.startedAt,
        updatedAt: sourceRun.startedAt,
      })
      await runEventJournal.appendBatch(runId, [
        semanticRunEvent(
          "plan.created",
          { version: 1, steps: stepPlan(sourceRun) },
          { ts: sourceRun.startedAt, sourceEventId: `workflow:${sourceRun.id}:plan` }
        ),
        semanticRunEvent(
          "run.started",
          {},
          { ts: sourceRun.startedAt, sourceEventId: `workflow:${sourceRun.id}:started` }
        ),
      ])
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConstraintError")) throw error
    }
    run = await getExecutionRun(runId)
  }
  if (!run) throw new Error(`Failed to create execution run ${runId}`)

  const origin = sourceRun.triggeredBy
  const destinations = [
    ...(origin?.adapterId && origin.conversationKey
      ? [
          {
            adapterId: origin.adapterId,
            conversationKey: origin.conversationKey,
            sourceMessageId: origin.sourceMessageId,
            deliveryTarget: origin.deliveryTarget,
          },
        ]
      : []),
    ...subscriptions
      .filter((subscription) => subscription.enabled)
      .map((subscription) => ({
        adapterId: subscription.adapterId,
        conversationKey: subscription.conversationKey,
      })),
  ]
  const unique = new Map(
    destinations.map((target) => [`${target.adapterId}:${target.conversationKey}`, target])
  )
  for (const target of unique.values()) {
    const id = bindingId(runId, target.adapterId, target.conversationKey)
    const existing = await getDb().executionRunBindings.get(id)
    if (existing) continue
    const deliveryTarget =
      ("deliveryTarget" in target ? target.deliveryTarget : undefined) ??
      (await getConnectorConversationState(target.conversationKey))?.deliveryTarget
    await putExecutionRunBinding({
      id,
      runId,
      projectId: sourceRun.projectId,
      adapterId: target.adapterId,
      conversationKey: target.conversationKey,
      status: "active",
      deliveryMode: "native",
      ...("sourceMessageId" in target && target.sourceMessageId
        ? { sourceMessageId: target.sourceMessageId }
        : {}),
      ...(deliveryTarget ? { deliveryTarget } : {}),
      lastProjectedRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  const labels = new Map(sourceRun.workflowSnapshot.nodes.map((node) => [node.id, node.data.label]))
  const mapped = sourceEvents
    .map((event) =>
      mapWorkflowRunEvent(event, { stepTitle: event.stepId ? labels.get(event.stepId) : undefined })
    )
    .filter((event): event is NonNullable<typeof event> => event !== null)
  if (mapped.length > 0) await runEventJournal.appendBatch(runId, mapped)
}

let subscription: Subscription | null = null
let stopAgentStateBridge: (() => void) | null = null

export function startWorkflowExecutionBridge(): () => void {
  if (subscription) return stopWorkflowExecutionBridge
  stopAgentStateBridge = startAgentStateExecutionBridge()
  subscription = liveQuery(async () => {
    const runs = await getDb().workflowRuns.toArray()
    const rows = await Promise.all(
      runs.map(async (run) => ({
        run,
        events: await getDb().workflowRunEvents.where("runId").equals(run.id).toArray(),
        subscriptions: await listForWorkflow(run.workflowId),
      }))
    )
    return rows.filter(
      ({ run, subscriptions }) =>
        run.triggeredBySource === "im" || subscriptions.some((subscription) => subscription.enabled)
    )
  }).subscribe({
    next(rows) {
      for (const row of rows) {
        void syncWorkflowExecutionRun(row.run, row.events, row.subscriptions).catch((error) => {
          console.error(`[workflow-execution-bridge] sync failed for run=${row.run.id}`, error)
        })
      }
    },
    error(error) {
      console.error("[workflow-execution-bridge] subscription failed", error)
    },
  })
  return stopWorkflowExecutionBridge
}

function stopWorkflowExecutionBridge(): void {
  subscription?.unsubscribe()
  subscription = null
  stopAgentStateBridge?.()
  stopAgentStateBridge = null
}

export function __resetWorkflowExecutionBridgeForTesting(): void {
  stopWorkflowExecutionBridge()
}
