import { liveQuery, type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import { enqueueOutbound, waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import {
  listExecutionRunBindings,
  sweepExecutionRunEventRetention,
  updateExecutionRunBinding,
} from "@/lib/db/execution-runs"
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
import { readForResolution } from "@/lib/db/conversation-overrides"
import {
  buildRunActivitySurface,
  formatRunActivityTimeline,
  runActivitiesForPresentation,
  runTitleForPresentation,
} from "@/lib/connectors/activity/activity-to-a2ui"
import { resolveActivityI18n } from "@/lib/connectors/activity/i18n"
import { safeStableActivityId, sanitizeActivityLabel } from "@/lib/execution/run-activity"

const TERMINAL = new Set<RunProjectionSnapshot["status"]>(["completed", "failed", "cancelled"])
const COALESCE_MS = 2_000
const APPEND_UPDATE_INTERVAL_MS = 30_000
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
  ): Promise<FallbackDeliveryResult>
  saveBinding(binding: ExecutionRunBinding): Promise<void>
  deliverMilestone?(binding: ExecutionRunBinding, snapshot: RunProjectionSnapshot): Promise<void>
  recordDegraded(binding: ExecutionRunBinding, reason: string): Promise<void> | void
  nativeEnabled(binding: ExecutionRunBinding): boolean
  resolveQueueDepth?(binding: ExecutionRunBinding): Promise<number>
}

type FallbackDeliveryMode = Exclude<ExecutionRunBinding["deliveryMode"], "native">

export interface FallbackDeliveryResult {
  ref: RunPresentationRef
  deliveryMode: FallbackDeliveryMode
  delivered: boolean
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

interface ImSafeProjection {
  snapshot: RunProjectionSnapshot
  redacted: boolean
}

function imSafeSnapshot(snapshot: RunProjectionSnapshot): RunProjectionSnapshot {
  const safeStep = (step: RunProjectionSnapshot["activeSteps"][number]) => ({
    id: safeStableActivityId(step.id),
    title: sanitizeActivityLabel(step.title, "Step"),
    status: step.status,
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
  })
  const safeActivities = runActivitiesForPresentation(snapshot)
  const safeRunId = safeStableActivityId(snapshot.runId)
  return {
    runId: safeRunId,
    kind: snapshot.kind,
    title: runTitleForPresentation(snapshot),
    status: snapshot.status,
    revision: snapshot.revision,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
    ...(snapshot.planVersion !== undefined ? { planVersion: snapshot.planVersion } : {}),
    progress: {
      completed: snapshot.progress.completed,
      total: snapshot.progress.total,
      ...(snapshot.progress.ratio !== undefined ? { ratio: snapshot.progress.ratio } : {}),
      trustworthy: snapshot.progress.trustworthy,
    },
    summary: snapshot.status === "completed" ? "Run completed" : undefined,
    error: snapshot.status === "failed" ? "Run failed; sensitive details are hidden." : undefined,
    waitingReason: snapshot.status === "waiting" ? "Waiting for a local review." : undefined,
    activeSteps: snapshot.activeSteps.map(safeStep),
    recentSteps: snapshot.recentSteps.map(safeStep),
    pendingSteps: snapshot.pendingSteps.map(safeStep),
    pendingStepCount: snapshot.pendingStepCount,
    activities: safeActivities,
    activityCount: snapshot.activityCount ?? safeActivities.length,
    omittedActivityCount: snapshot.omittedActivityCount ?? 0,
    ...(snapshot.connectorQueueDepth !== undefined
      ? { connectorQueueDepth: snapshot.connectorQueueDepth }
      : {}),
    elapsedMs: snapshot.elapsedMs,
    detailsUrl: `/agent-runs?run=${encodeURIComponent(safeRunId)}`,
    pendingInterrupt: snapshot.pendingInterrupt
      ? {
          id: safeStableActivityId(snapshot.pendingInterrupt.id),
          title: "Approval required",
          ...(snapshot.pendingInterrupt.expiresAt !== undefined
            ? { expiresAt: snapshot.pendingInterrupt.expiresAt }
            : {}),
        }
      : undefined,
    artifacts: snapshot.artifacts.map((artifact) => ({
      id: safeStableActivityId(artifact.id),
      title: "Artifact created",
      ...(artifact.mimeType ? { mimeType: sanitizeActivityLabel(artifact.mimeType, "") } : {}),
    })),
    allowedActions: [...snapshot.allowedActions],
    ...(snapshot.locale && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(snapshot.locale)
      ? { locale: snapshot.locale }
      : {}),
  }
}

/**
 * The final outbound boundary. Projection is intentionally explicit instead
 * of spreading the source snapshot so unknown legacy fields cannot cross an
 * IM connector. If the normal safe projection ever still trips the shared PII
 * detector, replace all descriptive content with a constant-safe shell.
 */
function projectImSafeSnapshot(snapshot: RunProjectionSnapshot): ImSafeProjection {
  const projected = imSafeSnapshot(snapshot)
  const sourceSafe = hasNoLeakingPiiDeep(snapshot)
  if (hasNoLeakingPiiDeep(projected)) {
    return { snapshot: projected, redacted: !sourceSafe }
  }

  const safeRunId = safeStableActivityId(snapshot.runId)
  const opaque: RunProjectionSnapshot = {
    runId: safeRunId,
    kind: snapshot.kind,
    title: "Execution run",
    status: snapshot.status,
    revision: snapshot.revision,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
    progress: { completed: 0, total: 0, trustworthy: false },
    activeSteps: [],
    recentSteps: [],
    pendingSteps: [],
    pendingStepCount: 0,
    activities: [],
    activityCount: 0,
    omittedActivityCount: Math.max(0, snapshot.activityCount ?? snapshot.activities?.length ?? 0),
    elapsedMs: snapshot.elapsedMs,
    detailsUrl: `/agent-runs?run=${encodeURIComponent(safeRunId)}`,
    artifacts: [],
    allowedActions: [...snapshot.allowedActions],
  }
  if (!hasNoLeakingPiiDeep(opaque)) {
    throw new Error("Unsafe execution projection blocked")
  }
  return { snapshot: opaque, redacted: true }
}

export function resolveFallbackDeliveryMode(input: {
  canEdit: boolean
  appendActivity: boolean
}): FallbackDeliveryMode {
  if (input.canEdit) return "card-edit"
  return input.appendActivity ? "append" : "final-only"
}

export function resolveCapabilityAwareFallbackDeliveryMode(input: {
  hasEditMethod: boolean
  messageEditing?: boolean | undefined
  appendActivity: boolean
  appendFallback?: boolean | undefined
}): FallbackDeliveryMode {
  return resolveFallbackDeliveryMode({
    canEdit: input.hasEditMethod && input.messageEditing !== false,
    appendActivity: input.appendActivity && input.appendFallback !== false,
  })
}

export function shouldDeliverFallbackUpdate(
  binding: ExecutionRunBinding,
  snapshot: RunProjectionSnapshot,
  mode: FallbackDeliveryMode,
  now: number = Date.now()
): boolean {
  if (TERMINAL.has(snapshot.status)) return true
  if (mode === "final-only") return false
  if (mode === "card-edit" || binding.lastProjectedRevision === 0) return true
  if (
    snapshot.status === "waiting" ||
    snapshot.status === "paused" ||
    snapshot.status === "recovery_required"
  ) {
    return true
  }
  const lastProjectedStatus = binding.presentationState?.lastProjectedStatus
  if (
    snapshot.status === "running" &&
    (lastProjectedStatus === "waiting" ||
      lastProjectedStatus === "paused" ||
      lastProjectedStatus === "recovery_required")
  ) {
    return true
  }
  const lastAppendAt = binding.presentationState?.lastAppendAt
  return typeof lastAppendAt !== "number" || now - lastAppendAt >= APPEND_UPDATE_INTERVAL_MS
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
  const projection = projectImSafeSnapshot(contextualSnapshot)
  const projectedSnapshot = projection.snapshot
  if (projection.redacted) {
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

  const fallback = await deps.deliverFallback(latestBinding, projectedSnapshot)
  const fallbackRef = fallback.ref
  const next: ExecutionRunBinding = {
    ...latestBinding,
    ...(fallbackRef.platformMessageId ? { platformMessageId: fallbackRef.platformMessageId } : {}),
    ...(fallbackRef.opaqueState ? { presentationState: fallbackRef.opaqueState } : {}),
    deliveryMode: fallback.deliveryMode,
    lastProjectedRevision: snapshot.revision,
    status: TERMINAL.has(snapshot.status) ? "finished" : "degraded",
    updatedAt: Date.now(),
  }
  await deps.saveBinding(next)
  return next
}

function markdown(snapshot: RunProjectionSnapshot): string {
  return formatRunActivityTimeline(snapshot, resolveActivityI18n(snapshot.locale))
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
): Promise<FallbackDeliveryResult> {
  const adapter = getRunningAdapter(binding.adapterId)?.adapter
  const override = await readForResolution(binding.conversationKey).catch(() => undefined)
  const deliveryMode = resolveCapabilityAwareFallbackDeliveryMode({
    hasEditMethod: typeof adapter?.edit === "function",
    messageEditing: adapter?.runtimeCapabilities?.messageEditing,
    appendActivity: override?.appendActivity !== false,
    appendFallback: adapter?.runtimeCapabilities?.appendFallback,
  })
  if (!shouldDeliverFallbackUpdate(binding, snapshot, deliveryMode)) {
    return {
      ref: {
        ...(binding.platformMessageId ? { platformMessageId: binding.platformMessageId } : {}),
        ...(binding.presentationState ? { opaqueState: binding.presentationState } : {}),
      },
      deliveryMode,
      delivered: false,
    }
  }
  const editTargetMessageId = deliveryMode === "card-edit" ? binding.platformMessageId : undefined
  const surface = buildRunActivitySurface(snapshot, resolveActivityI18n(snapshot.locale))
  const job = await enqueueOutbound({
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    request: {
      conversationRef: deliveryConversationRef(binding),
      deliveryTarget: binding.deliveryTarget,
      segments: [buildA2UISegment(`execution-run:${snapshot.runId}`, surface)],
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
  const platformMessageId = terminal.platformMessageId ?? binding.platformMessageId
  return {
    ref: {
      ...(platformMessageId ? { platformMessageId } : {}),
      opaqueState: {
        ...binding.presentationState,
        ...(deliveryMode === "append" ? { lastAppendAt: Date.now() } : {}),
        lastProjectedStatus: snapshot.status,
      },
    },
    deliveryMode,
    delivered: true,
  }
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
    const current = await getDb().executionRunBindings.get(binding.id)
    if (current?.status === "disabled" && binding.status !== "disabled") return
    await getDb().executionRunBindings.put(binding)
  },
  async recordDegraded(binding, reason) {
    const current = await getDb().executionRunBindings.get(binding.id)
    if (current?.status === "disabled") return
    await updateExecutionRunBinding(binding.id, {
      status: "degraded",
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
const projecting = new Map<string, Promise<void>>()

async function projectLatest(bindingId: string): Promise<void> {
  const existing = projecting.get(bindingId)
  if (existing) return existing
  const projection = (async () => {
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
  })()
  projecting.set(bindingId, projection)
  return projection
}

export function areExecutionRunPresentationsFrozen(
  bindings: readonly ExecutionRunBinding[]
): boolean {
  return bindings.every((binding) => binding.status === "finished" || binding.status === "disabled")
}

/**
 * Ensure a terminal run card is frozen before the authoritative answer is
 * enqueued. The function actively projects pending bindings, so correctness
 * does not depend on the liveQuery subscription having started or fired.
 */
export async function waitForExecutionRunPresentationFreeze(
  runId: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (true) {
    const bindings = await listExecutionRunBindings(runId)
    if (bindings.length === 0 || areExecutionRunPresentationsFrozen(bindings)) return true

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      await disableAndDrainRunProjections(bindings)
      return false
    }
    const projection = Promise.all(
      bindings
        .filter((binding) => binding.status !== "finished" && binding.status !== "disabled")
        .map((binding) => projectLatest(binding.id))
    )
    const completed = await Promise.race([
      projection.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), remainingMs)
      }),
    ])
    if (!completed) {
      await disableAndDrainRunProjections(bindings)
      return false
    }
    if (!areExecutionRunPresentationsFrozen(await listExecutionRunBindings(runId))) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())))
      })
    }
  }
}

async function disableAndDrainRunProjections(
  bindings: readonly ExecutionRunBinding[]
): Promise<void> {
  const pending = bindings.filter(
    (binding) => binding.status !== "finished" && binding.status !== "disabled"
  )
  await Promise.all(
    pending.map((binding) =>
      updateExecutionRunBinding(binding.id, {
        status: "disabled",
        updatedAt: Date.now(),
      })
    )
  )
  await Promise.all(
    pending.map((binding) => projecting.get(binding.id)).filter(Boolean) as Promise<void>[]
  )
  // A stale in-flight projection may have checkpointed after the first write.
  // Reassert the terminal disabled state only after every platform mutation
  // has settled, so the caller can safely enqueue the independent answer.
  await Promise.all(
    pending.map((binding) =>
      updateExecutionRunBinding(binding.id, {
        status: "disabled",
        updatedAt: Date.now(),
      })
    )
  )
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

export function heartbeatExecutionRunBinding(bindingId: string): Promise<void> {
  const existing = projecting.get(bindingId)
  if (existing) return existing
  const projection = runHeartbeatExecutionRunBinding(bindingId)
  projecting.set(bindingId, projection)
  return projection.finally(() => {
    if (projecting.get(bindingId) === projection) projecting.delete(bindingId)
  })
}

async function runHeartbeatExecutionRunBinding(bindingId: string): Promise<void> {
  const binding = await getDb().executionRunBindings.get(bindingId)
  if (
    !binding ||
    (binding.status !== "active" && binding.status !== "degraded") ||
    binding.deliveryMode === "final-only"
  ) {
    return
  }
  const snapshot = (await getDb().executionRuns.get(binding.runId))?.latestSnapshot
  if (!snapshot || TERMINAL.has(snapshot.status)) return
  if (binding.deliveryMode === "append") {
    try {
      const contextualSnapshot: RunProjectionSnapshot = {
        ...snapshot,
        ...(binding.locale ? { locale: binding.locale } : {}),
        elapsedMs: Math.max(0, Date.now() - snapshot.startedAt),
        connectorQueueDepth: await countPendingConnectorInboundJobs(binding.conversationKey),
      }
      const projected = projectImSafeSnapshot(contextualSnapshot)
      const projectedSnapshot = projected.snapshot
      if (projected.redacted) {
        await defaultDependencies.recordDegraded(binding, "pii_gate_blocked")
      }
      const result = await defaultDependencies.deliverFallback(binding, projectedSnapshot)
      if (result.delivered) {
        await defaultDependencies.saveBinding({
          ...binding,
          ...(result.ref.platformMessageId
            ? { platformMessageId: result.ref.platformMessageId }
            : {}),
          ...(result.ref.opaqueState ? { presentationState: result.ref.opaqueState } : {}),
          updatedAt: Date.now(),
        })
      }
    } catch (error) {
      await defaultDependencies.recordDegraded(binding, errorMessage(error))
    }
    return
  }
  const driver = defaultDependencies.nativeEnabled(binding)
    ? defaultDependencies.resolveDriver(binding)
    : undefined
  if (!driver || !binding.platformMessageId) return
  let latestBinding = binding
  try {
    const contextualSnapshot: RunProjectionSnapshot = {
      ...snapshot,
      ...(binding.locale ? { locale: binding.locale } : {}),
      elapsedMs: Math.max(0, Date.now() - snapshot.startedAt),
      connectorQueueDepth: await countPendingConnectorInboundJobs(binding.conversationKey),
    }
    const projected = projectImSafeSnapshot(contextualSnapshot)
    const projectedSnapshot = projected.snapshot
    if (projected.redacted) {
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
      .anyOf("active", "degraded")
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
