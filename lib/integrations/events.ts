import type {
  IntegrationEventEnvelope,
  IntegrationInboxProjectionDef,
  IntegrationSubscription,
} from "@/types/plugin/plugin-integration"
import { createDiagnostic } from "@cognia/diagnostics"
import {
  appendIntegrationAudit,
  claimIntegrationEventProjection,
  getIntegrationAccount,
  insertIntegrationEvent,
  listDueIntegrationEventProjections,
  listIntegrationSubscriptions,
  recordIntegrationEventProjection,
} from "@/lib/db/integrations"
import {
  INTEGRATION_PROJECTION_STEPS,
  type IntegrationEventProjectionV1,
  type IntegrationEventRow,
  type IntegrationProjectionStep,
  type IntegrationProjectionStepState,
} from "@/lib/db/integration-types"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { getDb } from "@/lib/db/schema"
import { createSession, updateSession } from "@/lib/db/sessions"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { findMatchingWorkflows } from "@/lib/workflow/runtime/trigger-subscriptions"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { getRegisteredIntegration } from "./registry"
import { reconcileGithubLifecycle } from "./github-lifecycle"
import type { UIMessage } from "ai"

export interface PublishIntegrationEventResult {
  inserted: boolean
  workflowDispatches: number
  inboxProjections: number
  /** Bot deliveries enqueued for this event by this pass. */
  botDeliveries: number
  /**
   * True when the event was already stored but had unfinished projections,
   * and this call (a redelivery) finished some of them.
   */
  resumed?: boolean
  /** Projection steps still unfinished after this pass; recovery retries them. */
  pendingSteps?: IntegrationProjectionStep[]
}

function subscriptionMatches(
  subscription: IntegrationSubscription,
  event: IntegrationEventEnvelope
): boolean {
  if (!subscription.enabled || !subscription.eventTypes.includes(event.eventType)) return false
  if (subscription.resourceKind && event.resource?.kind !== subscription.resourceKind) return false
  if (subscription.resourceId && event.resource?.id !== subscription.resourceId) return false
  return true
}

export function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value
  if (!pointer.startsWith("/")) return undefined
  let current = value
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function pointerString(payload: unknown, pointer: string): string | undefined {
  const value = readJsonPointer(payload, pointer)
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function firstPointerString(payload: unknown, pointers: readonly string[]): string | undefined {
  for (const pointer of pointers) {
    const value = pointerString(payload, pointer)
    if (value) return value
  }
  return undefined
}

async function projectEventToInbox(
  event: IntegrationEventEnvelope,
  subscription: IntegrationSubscription,
  projection: IntegrationInboxProjectionDef
): Promise<boolean> {
  if (!projection.eventTypes.includes(event.eventType)) return false
  const threadKey = pointerString(event.payload, projection.threadKeyPointer)
  const title = pointerString(event.payload, projection.titlePointer)
  const body =
    firstPointerString(event.payload, [
      ...(projection.bodyFallbackPointers ?? []),
      projection.bodyPointer,
    ]) ?? title
  if (!threadKey || !title || !body) return false
  const url = firstPointerString(event.payload, [
    ...(projection.urlFallbackPointers ?? []),
    ...(projection.urlPointer ? [projection.urlPointer] : []),
  ])
  const alias = projection.threadAlias
  const threadProjectionId =
    alias && readJsonPointer(event.payload, alias.whenPointer) != null
      ? alias.projectionId
      : projection.id
  const binding = {
    pluginId: event.pluginId,
    integrationId: event.integrationId,
    accountId: event.accountId,
    projectionId: threadProjectionId,
    threadKey,
    resourceKind: event.resource?.kind,
    resourceId: event.resource?.id,
  }
  const existing = await getDb()
    .sessions.filter((session) => {
      const candidate = session.integrationBinding
      return (
        candidate?.pluginId === binding.pluginId &&
        candidate.integrationId === binding.integrationId &&
        candidate.accountId === binding.accountId &&
        candidate.projectionId === binding.projectionId &&
        candidate.threadKey === binding.threadKey
      )
    })
    .first()
  const session =
    existing ??
    (await createSession({
      title,
      integrationBinding: binding,
    }))
  if (existing && existing.title !== title) await updateSession(existing.id, { title })
  const messages = await listMessages(session.id)
  if (messages.some((message) => message.id === event.id)) return false
  const text = url ? `${body}\n\n${url}` : body
  const projected: UIMessage = {
    id: event.id,
    role: "assistant",
    parts: [{ type: "text", text }],
  }
  await persistMessages(session.id, [...messages, projected])
  return true
}

export async function publishIntegrationEvent(
  pluginId: string,
  event: IntegrationEventEnvelope
): Promise<PublishIntegrationEventResult> {
  if (event.pluginId !== pluginId) {
    throw new Error("An Integration plugin cannot publish events for another plugin")
  }
  const registered = getRegisteredIntegration(pluginId, event.integrationId)
  if (!registered) throw new Error(`Integration "${event.integrationId}" is not registered`)
  if (!registered.definition.eventTypes.some((candidate) => candidate.id === event.eventType)) {
    throw new Error(`Integration event type "${event.eventType}" is not declared`)
  }
  const account = await getIntegrationAccount(pluginId, event.accountId)
  if (!account || account.integrationId !== event.integrationId) {
    throw new Error(`Integration account "${event.accountId}" does not belong to this integration`)
  }
  const stored = await insertIntegrationEvent(event)
  if (stored.inserted) {
    return { inserted: true, ...(await projectStoredEvent(stored.row, { retry: false })) }
  }
  // A redelivery of an event whose projections never finished (the process
  // died, or a consumer threw) resumes them instead of being dropped as a
  // duplicate. A finished, deadlettered or legacy row is a plain duplicate.
  const claimed = await claimIntegrationEventProjection(stored.row.id)
  if (!claimed) {
    return { inserted: false, workflowDispatches: 0, inboxProjections: 0, botDeliveries: 0 }
  }
  return {
    inserted: false,
    resumed: true,
    ...(await projectStoredEvent(claimed, { retry: true })),
  }
}

type ProjectionCounts = Omit<PublishIntegrationEventResult, "inserted" | "resumed">

function projectionErrorCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== "Error") return error.name
  return "projection_failed"
}

function reportProjectionFailure(
  row: IntegrationEventRow,
  step: IntegrationProjectionStep,
  error: unknown
): void {
  dispatchDiagnostic(
    createDiagnostic("serverError", {
      source: "connector",
      message: error instanceof Error ? error.message : String(error),
      meta: {
        extra: {
          stage: "integration-event-projection",
          step,
          pluginId: row.pluginId,
          integrationId: row.integrationId,
          eventId: row.id,
          eventType: row.eventType,
        },
      },
    }),
    { kind: "background" }
  )
}

/**
 * Run every unfinished projection of a claimed, stored event and record the
 * outcome on the row. Each step runs in its own try: one consumer failing
 * neither stops the others nor is forgotten. Every step is idempotent per
 * event, so re-running one that may have half-completed is safe.
 */
async function projectStoredEvent(
  row: IntegrationEventRow,
  options: { retry: boolean }
): Promise<ProjectionCounts> {
  const event = publicEnvelope(row)
  const pluginId = row.pluginId
  const steps: IntegrationEventProjectionV1["steps"] = {
    ...(row.projection?.steps ?? allPendingSteps()),
  }
  let workflowDispatches = 0
  let inboxProjections = 0
  let botDeliveries = 0

  /** A body returns its own state only when it finished but is still owed work. */
  async function run(
    step: IntegrationProjectionStep,
    body: () => Promise<IntegrationProjectionStepState | void>
  ): Promise<void> {
    if (steps[step].status === "complete") return
    try {
      steps[step] = (await body()) ?? { status: "complete" }
    } catch (error) {
      steps[step] = { ...steps[step], status: "pending", errorCode: projectionErrorCode(error) }
      reportProjectionFailure(row, step, error)
    }
  }

  await run("lifecycle", () => reconcileGithubLifecycle(event))

  const registered = getRegisteredIntegration(pluginId, event.integrationId)
  const subscriptions = (await listIntegrationSubscriptions(pluginId, event.accountId)).filter(
    (subscription) => subscriptionMatches(subscription, event)
  )

  await run("workflow", async () => {
    const subscriptionIds = subscriptions.map((subscription) => subscription.id).sort()
    const payload = {
      ...event,
      subscriptionId: subscriptionIds[0],
      subscriptionIds,
    }
    const matches = findMatchingWorkflows("trigger.integration.event", {
      pluginId,
      integrationId: event.integrationId,
      accountId: event.accountId,
      eventType: event.eventType,
      resourceKind: event.resource?.kind,
      resourceId: event.resource?.id,
    })
    // Keyed on the delivery, the same identity the event row is deduplicated
    // on, so a redelivered or recovered event never starts a second run and
    // two events in the same second never share one (ADR-0224 A9).
    const occurrenceKey = `${pluginId}:${event.integrationId}:${event.accountId}:${event.deliveryId}`
    await Promise.all(
      matches.map(async (match) => {
        await dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.integration.event",
          triggerId: match.nodeId,
          payload,
          originAt: Date.now(),
          occurrenceKey,
        })
      })
    )
    workflowDispatches = matches.length
  })

  await run("bots", async () => {
    const { dispatchIntegrationEventToBots } = await import("@/lib/bot/sources/integration-event")
    const previous = steps.bots.retryInstallationIds
    const result = await dispatchIntegrationEventToBots(event, {
      ...(previous ? { installationIds: previous } : {}),
      ...(options.retry ? { installedBefore: epochMs(event.receivedAt) } : {}),
    })
    botDeliveries = result.enqueued.length
    // An installation whose plugin has not registered its definition or
    // handler yet is owed this event; it is not a zero-match success.
    if (result.retryable.length > 0) {
      return {
        status: "pending",
        errorCode: "bot_not_ready",
        retryInstallationIds: result.retryable,
      }
    }
  })

  await run("issues", async () => {
    // The issue board: a GitHub issue event schedules a refresh of that
    // repository's mirror / import bindings, so a webhook shows up on the
    // board without waiting for the 15-minute poll.
    const { GithubEventIssueRefresher, getGithubEventIssueRefresher } =
      await import("@/lib/issues/github-event-refresh")
    if (GithubEventIssueRefresher.relevant(event)) {
      await getGithubEventIssueRefresher().handle(event)
    }
  })

  await run("inbox", async () => {
    for (const subscription of subscriptions) {
      if (!subscription.inboxProjectionId) continue
      const projection = registered?.definition.inboxProjections?.find(
        (candidate) => candidate.id === subscription.inboxProjectionId
      )
      if (projection && (await projectEventToInbox(event, subscription, projection))) {
        inboxProjections += 1
      }
    }
  })

  const recorded = await recordIntegrationEventProjection(row.id, steps)
  const pendingSteps = INTEGRATION_PROJECTION_STEPS.filter(
    (step) => steps[step].status !== "complete"
  )

  await appendIntegrationAudit({
    pluginId,
    integrationId: event.integrationId,
    accountId: event.accountId,
    kind: `event.${event.eventType}`,
    outcome: pendingSteps.length === 0 ? "succeeded" : "failed",
    detail: {
      eventId: event.id,
      deliveryId: event.deliveryId,
      workflowDispatches,
      inboxProjections,
      botDeliveries,
      ...(pendingSteps.length > 0
        ? {
            pendingSteps,
            projectionState: recorded?.projectionState,
            errorCodes: Object.fromEntries(
              pendingSteps.map((step) => [step, steps[step].errorCode ?? "pending"])
            ),
          }
        : {}),
      ...(options.retry ? { retry: true } : {}),
    },
  })
  return {
    workflowDispatches,
    inboxProjections,
    botDeliveries,
    ...(pendingSteps.length > 0 ? { pendingSteps } : {}),
  }
}

/** The envelope without host-local projection bookkeeping. */
function publicEnvelope(row: IntegrationEventRow): IntegrationEventEnvelope {
  const {
    projection: _projection,
    projectionState: _state,
    projectionDueAt: _due,
    projectionAttempts: _attempts,
    ...envelope
  } = row
  return envelope
}

function epochMs(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

let recovering: Promise<number> | undefined

/**
 * Re-run the unfinished projections of every due event (startup and a
 * periodic sweep). A pass already in flight is joined, not doubled; the
 * per-event claim keeps two hosts sharing a database from projecting the
 * same event at once.
 */
export function recoverIntegrationEventProjections(
  options: { now?: number; limit?: number } = {}
): Promise<number> {
  recovering ??= (async () => {
    try {
      const now = options.now ?? Date.now()
      const due = await listDueIntegrationEventProjections(now, options.limit ?? 100)
      let projected = 0
      for (const candidate of due) {
        const claimed = await claimIntegrationEventProjection(candidate.id, now)
        if (!claimed) continue
        const registered = getRegisteredIntegration(claimed.pluginId, claimed.integrationId)
        if (!registered) {
          // The provider plugin is not loaded (yet). Charge the attempt so a
          // plugin that never comes back ends in the deadletter, not a loop.
          await recordIntegrationEventProjection(
            claimed.id,
            claimed.projection?.steps ?? allPendingSteps(),
            now
          )
          continue
        }
        await projectStoredEvent(claimed, { retry: true })
        projected += 1
      }
      return projected
    } finally {
      recovering = undefined
    }
  })()
  return recovering
}

function allPendingSteps(): IntegrationEventProjectionV1["steps"] {
  return Object.fromEntries(
    INTEGRATION_PROJECTION_STEPS.map((step) => [step, { status: "pending" }])
  ) as IntegrationEventProjectionV1["steps"]
}
