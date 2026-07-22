import { liveQuery, type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import { enqueueOutbound, waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { sweepExecutionRunEventRetention, updateExecutionRunBinding } from "@/lib/db/execution-runs"
import { getRunningAdapter } from "@/lib/connectors/lifecycle"
import type {
  ExecutionRunBinding,
  RunPresentationDriver,
  RunPresentationRef,
  RunProjectionSnapshot,
  RunEventType,
} from "@/types/execution/run"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { countPendingConnectorInboundJobs } from "@/lib/db/connector-inbound-jobs"

const TERMINAL = new Set<RunProjectionSnapshot["status"]>(["completed", "failed", "cancelled"])
const COALESCE_MS = 2_000
const NATIVE_KILL_SWITCH_KEY = "cognia-run-presentation-native-disabled"
const IMMEDIATE_EVENT_TYPES = new Set<RunEventType>([
  "run.started",
  "run.waiting",
  "run.paused",
  "run.resumed",
  "run.recovery_required",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "step.started",
  "interrupt.requested",
  "interrupt.resolved",
  "interrupt.expired",
  "control.accepted",
  "control.rejected",
])

export interface ProjectionDependencies {
  resolveDriver(binding: ExecutionRunBinding): RunPresentationDriver | undefined
  deliverFallback(
    binding: ExecutionRunBinding,
    snapshot: RunProjectionSnapshot
  ): Promise<RunPresentationRef>
  saveBinding(binding: ExecutionRunBinding): Promise<void>
  deliverMilestone?(binding: ExecutionRunBinding, snapshot: RunProjectionSnapshot): Promise<void>
  recordDegraded(binding: ExecutionRunBinding, reason: string): Promise<void> | void
  nativeEnabled(binding: ExecutionRunBinding): boolean
  resolveQueueDepth?(binding: ExecutionRunBinding): Promise<number>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function presentationRef(binding: ExecutionRunBinding): RunPresentationRef {
  const opaqueState = binding.presentationState
    ? {
        ...binding.presentationState,
        ...(binding.deliveryTarget
          ? {
              target: {
                adapterId: binding.adapterId,
                conversationKey: binding.conversationKey,
                sourceMessageId: binding.sourceMessageId,
                deliveryTarget: binding.deliveryTarget,
                recipientUserId: binding.recipientUserId,
                recipientTeamId: binding.recipientTeamId,
              },
            }
          : {}),
      }
    : undefined
  return {
    ...(binding.platformMessageId ? { platformMessageId: binding.platformMessageId } : {}),
    ...(opaqueState ? { opaqueState } : {}),
  }
}

function deliveryConversationRef(binding: ExecutionRunBinding) {
  const ref = binding.deliveryTarget?.conversationRef
  if (!ref) {
    throw new Error("Execution presentation binding has no persisted delivery target")
  }
  return ref
}

function piiSafeSnapshot(snapshot: RunProjectionSnapshot): RunProjectionSnapshot {
  if (hasNoLeakingPiiDeep(snapshot)) return snapshot
  return {
    ...snapshot,
    title: "Execution run",
    summary: "Sensitive run details are hidden. Open Cognia to review locally.",
    error: snapshot.status === "failed" ? "Run failed; sensitive details are hidden." : undefined,
    waitingReason: snapshot.status === "waiting" ? "Waiting for a local review." : undefined,
    activeSteps: snapshot.activeSteps.map((step, index) => ({
      ...step,
      title: `Step ${index + 1}`,
      summary: undefined,
      detail: undefined,
    })),
    recentSteps: snapshot.recentSteps.map((step, index) => ({
      ...step,
      title: `Recent step ${index + 1}`,
      summary: undefined,
      detail: undefined,
    })),
    pendingSteps: snapshot.pendingSteps.map((step, index) => ({
      ...step,
      title: `Pending step ${index + 1}`,
      summary: undefined,
      detail: undefined,
    })),
    artifacts: [],
  }
}

export async function projectExecutionRunBinding(
  binding: ExecutionRunBinding,
  snapshot: RunProjectionSnapshot,
  deps: ProjectionDependencies
): Promise<ExecutionRunBinding> {
  if (binding.status === "disabled" || snapshot.revision <= binding.lastProjectedRevision) {
    return binding
  }
  const contextualSnapshot: RunProjectionSnapshot = {
    ...snapshot,
    ...(binding.locale ? { locale: binding.locale } : {}),
    elapsedMs: Math.max(0, (snapshot.endedAt ?? Date.now()) - snapshot.startedAt),
    ...(deps.resolveQueueDepth
      ? { connectorQueueDepth: await deps.resolveQueueDepth(binding) }
      : {}),
  }
  const projectedSnapshot = piiSafeSnapshot(contextualSnapshot)
  if (projectedSnapshot !== contextualSnapshot) {
    await deps.recordDegraded(binding, "pii_gate_blocked")
  }

  const driver = deps.nativeEnabled(binding) ? deps.resolveDriver(binding) : undefined
  let latestBinding = binding
  if (driver && binding.deliveryMode === "native") {
    try {
      const checkpoint = async (checkpointRef: RunPresentationRef) => {
        latestBinding = {
          ...latestBinding,
          ...(checkpointRef.platformMessageId
            ? { platformMessageId: checkpointRef.platformMessageId }
            : {}),
          ...(checkpointRef.opaqueState ? { presentationState: checkpointRef.opaqueState } : {}),
          updatedAt: Date.now(),
        }
        await deps.saveBinding(latestBinding)
      }
      const ref = binding.platformMessageId
        ? TERMINAL.has(snapshot.status)
          ? await driver.finish(presentationRef(binding), projectedSnapshot, { checkpoint })
          : await driver.update(presentationRef(binding), projectedSnapshot, { checkpoint })
        : await driver.open(
            {
              adapterId: binding.adapterId,
              conversationKey: binding.conversationKey,
              sourceMessageId: binding.sourceMessageId,
              deliveryTarget: binding.deliveryTarget,
              recipientUserId: binding.recipientUserId,
              recipientTeamId: binding.recipientTeamId,
            },
            projectedSnapshot,
            {
              previousRef: presentationRef(binding),
              checkpoint,
            }
          )
      if (TERMINAL.has(snapshot.status) && snapshot.kind !== "agent-turn") {
        await deps.deliverMilestone?.(binding, projectedSnapshot)
      }
      const next: ExecutionRunBinding = {
        ...latestBinding,
        ...(ref.platformMessageId ? { platformMessageId: ref.platformMessageId } : {}),
        ...(ref.opaqueState ? { presentationState: ref.opaqueState } : {}),
        lastProjectedRevision: snapshot.revision,
        status: TERMINAL.has(snapshot.status) ? "finished" : "active",
        updatedAt: Date.now(),
      }
      await deps.saveBinding(next)
      return next
    } catch (error) {
      await deps.recordDegraded(latestBinding, errorMessage(error))
    }
  }

  const fallbackRef = await deps.deliverFallback(latestBinding, projectedSnapshot)
  const next: ExecutionRunBinding = {
    ...latestBinding,
    ...(fallbackRef.platformMessageId ? { platformMessageId: fallbackRef.platformMessageId } : {}),
    ...(fallbackRef.opaqueState ? { presentationState: fallbackRef.opaqueState } : {}),
    deliveryMode: fallbackRef.platformMessageId ? "card-edit" : "append",
    lastProjectedRevision: snapshot.revision,
    status: TERMINAL.has(snapshot.status) ? "finished" : "degraded",
    updatedAt: Date.now(),
  }
  await deps.saveBinding(next)
  return next
}

function markdown(snapshot: RunProjectionSnapshot): string {
  const progress = snapshot.progress.trustworthy
    ? `${snapshot.progress.completed}/${snapshot.progress.total}${
        snapshot.progress.ratio === undefined
          ? ""
          : ` (${Math.round(snapshot.progress.ratio * 100)}%)`
      }`
    : `${snapshot.progress.completed} completed`
  const steps = [...snapshot.activeSteps, ...snapshot.recentSteps]
    .slice(0, 6)
    .map(
      (step) =>
        `- ${step.status === "completed" ? "✅" : step.status === "failed" ? "❌" : "⏳"} ${step.title}`
    )
  const artifacts = snapshot.artifacts
    .slice(0, 6)
    .map((artifact) =>
      artifact.url ? `- [${artifact.title}](${artifact.url})` : `- 📎 ${artifact.title}`
    )
  return [
    `**${snapshot.title}** · ${snapshot.status} · ${progress}`,
    snapshot.summary,
    snapshot.error,
    ...steps,
    ...artifacts,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 12_000)
}

async function deliverMilestone(
  binding: ExecutionRunBinding,
  snapshot: RunProjectionSnapshot
): Promise<void> {
  const job = await enqueueOutbound({
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    request: {
      conversationRef: deliveryConversationRef(binding),
      deliveryTarget: binding.deliveryTarget,
      segments: [{ type: "markdown", md: markdown(snapshot) }],
      metadata: {
        idempotencyKey: `execution-run:${binding.id}:${snapshot.revision}:final`,
        ...(binding.sourceMessageId ? { sourceMessageId: binding.sourceMessageId } : {}),
      },
    },
    source: snapshot.kind === "workflow" ? "workflow" : "ai-run",
  })
  const terminal = await waitForOutboundTerminal(job.id, 30_000)
  if (terminal?.status !== "sent") {
    throw new Error(`Execution run milestone delivery failed: ${terminal?.status ?? "missing"}`)
  }
}

async function deliverFallback(
  binding: ExecutionRunBinding,
  snapshot: RunProjectionSnapshot
): Promise<RunPresentationRef> {
  const adapter = getRunningAdapter(binding.adapterId)?.adapter
  const editTargetMessageId = adapter?.edit ? binding.platformMessageId : undefined
  const job = await enqueueOutbound({
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    request: {
      conversationRef: deliveryConversationRef(binding),
      deliveryTarget: binding.deliveryTarget,
      segments: [
        buildA2UISegment(`execution-run:${snapshot.runId}`, {
          components: {
            root: { id: "root", component: "Column", children: ["summary"] },
            summary: { id: "summary", component: "Text", text: markdown(snapshot) },
          },
          dataModel: {
            runId: snapshot.runId,
            revision: snapshot.revision,
            status: snapshot.status,
          },
          rootId: "root",
          widget: { fallbackText: markdown(snapshot) },
        }),
      ],
      ...(editTargetMessageId ? { editTargetMessageId } : {}),
      metadata: {
        idempotencyKey: `execution-run:${binding.id}:${snapshot.revision}`,
        ...(binding.sourceMessageId ? { sourceMessageId: binding.sourceMessageId } : {}),
      },
    },
    source: snapshot.kind === "workflow" ? "workflow" : "ai-run",
    ...(snapshot.kind === "workflow"
      ? {
          sourceWorkflow: {
            workflowId: snapshot.runId,
            runId: snapshot.runId,
            nodeId: "run-projection",
          },
        }
      : {}),
  })
  const terminal = await waitForOutboundTerminal(job.id, 30_000)
  if (terminal?.status !== "sent") {
    throw new Error(
      `Execution run fallback delivery did not complete: ${terminal?.status ?? "missing"}`
    )
  }
  return { platformMessageId: terminal.platformMessageId ?? binding.platformMessageId }
}

function nativeEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_COGNIA_NATIVE_RUN_PRESENTATION === "0") return false
  try {
    return globalThis.localStorage?.getItem(NATIVE_KILL_SWITCH_KEY) !== "true"
  } catch {
    return true
  }
}

const defaultDependencies: ProjectionDependencies = {
  resolveDriver(binding) {
    return getRunningAdapter(binding.adapterId)?.adapter.runPresentation
  },
  deliverFallback,
  deliverMilestone,
  async saveBinding(binding) {
    await getDb().executionRunBindings.put(binding)
  },
  async recordDegraded(binding, reason) {
    await updateExecutionRunBinding(binding.id, {
      status: "degraded",
      deliveryMode: "card-edit",
      presentationState: {
        ...binding.presentationState,
        degradedReason: reason.slice(0, 500),
      },
      updatedAt: Date.now(),
    })
    await appendAudit({
      adapterId: binding.adapterId,
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: binding.conversationKey,
      reason: "run_projection_degraded",
      message: reason.slice(0, 500),
      fields: { runId: binding.runId, bindingId: binding.id },
    })
  },
  nativeEnabled,
  resolveQueueDepth(binding) {
    return countPendingConnectorInboundJobs(binding.conversationKey)
  },
}

let subscription: Subscription | null = null
let retentionTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const projecting = new Set<string>()

async function projectLatest(bindingId: string): Promise<void> {
  if (projecting.has(bindingId)) return
  projecting.add(bindingId)
  try {
    while (true) {
      const binding = await getDb().executionRunBindings.get(bindingId)
      if (!binding || binding.status === "disabled" || binding.status === "finished") return
      const snapshot = (await getDb().executionRuns.get(binding.runId))?.latestSnapshot
      if (!snapshot || snapshot.revision <= binding.lastProjectedRevision) return
      await projectExecutionRunBinding(binding, snapshot, defaultDependencies)
    }
  } catch (error) {
    console.error(`[run-presentation] projection failed for binding=${bindingId}`, error)
  } finally {
    projecting.delete(bindingId)
  }
}

function schedule(
  binding: ExecutionRunBinding,
  snapshot: RunProjectionSnapshot,
  latestEventType?: RunEventType
): void {
  if (timers.has(binding.id) || projecting.has(binding.id)) return
  const delay =
    binding.lastProjectedRevision === 0 ||
    TERMINAL.has(snapshot.status) ||
    (latestEventType !== undefined && IMMEDIATE_EVENT_TYPES.has(latestEventType))
      ? 0
      : COALESCE_MS
  timers.set(
    binding.id,
    setTimeout(() => {
      timers.delete(binding.id)
      void projectLatest(binding.id)
    }, delay)
  )
}

export async function heartbeatExecutionRunBinding(bindingId: string): Promise<void> {
  if (projecting.has(bindingId)) return
  const binding = await getDb().executionRunBindings.get(bindingId)
  if (!binding || binding.status !== "active" || binding.deliveryMode !== "native") return
  const snapshot = (await getDb().executionRuns.get(binding.runId))?.latestSnapshot
  const driver = defaultDependencies.nativeEnabled(binding)
    ? defaultDependencies.resolveDriver(binding)
    : undefined
  if (!snapshot || !driver || !binding.platformMessageId || TERMINAL.has(snapshot.status)) return
  projecting.add(bindingId)
  let latestBinding = binding
  try {
    const contextualSnapshot: RunProjectionSnapshot = {
      ...snapshot,
      ...(binding.locale ? { locale: binding.locale } : {}),
      elapsedMs: Math.max(0, Date.now() - snapshot.startedAt),
      connectorQueueDepth: await countPendingConnectorInboundJobs(binding.conversationKey),
    }
    const projectedSnapshot = piiSafeSnapshot(contextualSnapshot)
    if (projectedSnapshot !== contextualSnapshot) {
      await defaultDependencies.recordDegraded(binding, "pii_gate_blocked")
    }
    const checkpoint = async (checkpointRef: RunPresentationRef) => {
      latestBinding = {
        ...latestBinding,
        ...(checkpointRef.platformMessageId
          ? { platformMessageId: checkpointRef.platformMessageId }
          : {}),
        ...(checkpointRef.opaqueState ? { presentationState: checkpointRef.opaqueState } : {}),
        updatedAt: Date.now(),
      }
      await defaultDependencies.saveBinding(latestBinding)
    }
    const ref = await driver.update(presentationRef(latestBinding), projectedSnapshot, {
      checkpoint,
    })
    await defaultDependencies.saveBinding({
      ...latestBinding,
      ...(ref.platformMessageId ? { platformMessageId: ref.platformMessageId } : {}),
      ...(ref.opaqueState ? { presentationState: ref.opaqueState } : {}),
      updatedAt: Date.now(),
    })
  } catch (error) {
    await defaultDependencies.recordDegraded(latestBinding, errorMessage(error))
  } finally {
    projecting.delete(bindingId)
  }
}

export function startExecutionRunPresentationRunner(): () => void {
  if (subscription) return stopExecutionRunPresentationRunner
  subscription = liveQuery(async () => {
    const bindings = await getDb()
      .executionRunBindings.where("status")
      .anyOf("active", "degraded")
      .toArray()
    return Promise.all(
      bindings.map(async (binding) => ({
        binding,
        snapshot: (await getDb().executionRuns.get(binding.runId))?.latestSnapshot,
        latestEvent: await getDb()
          .executionRunEvents.where("[runId+seq]")
          .between([binding.runId, 0], [binding.runId, Number.POSITIVE_INFINITY])
          .last(),
      }))
    )
  }).subscribe({
    next(rows) {
      for (const { binding, snapshot, latestEvent } of rows) {
        if (snapshot && snapshot.revision > binding.lastProjectedRevision)
          schedule(binding, snapshot, latestEvent?.type)
      }
    },
    error(error) {
      console.error("[run-presentation] subscription failed", error)
    },
  })
  void sweepExecutionRunEventRetention().catch(() => undefined)
  retentionTimer = setInterval(
    () => {
      void sweepExecutionRunEventRetention().catch(() => undefined)
    },
    24 * 60 * 60 * 1_000
  )
  heartbeatTimer = setInterval(() => {
    void getDb()
      .executionRunBindings.where("status")
      .equals("active")
      .primaryKeys()
      .then((ids) =>
        Promise.all(ids.map((id) => heartbeatExecutionRunBinding(String(id)))).then(() => undefined)
      )
      .catch(() => undefined)
  }, 5_000)
  return stopExecutionRunPresentationRunner
}

function stopExecutionRunPresentationRunner(): void {
  subscription?.unsubscribe()
  subscription = null
  if (retentionTimer) clearInterval(retentionTimer)
  retentionTimer = null
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

export function __resetExecutionRunPresentationRunnerForTesting(): void {
  stopExecutionRunPresentationRunner()
  projecting.clear()
}
