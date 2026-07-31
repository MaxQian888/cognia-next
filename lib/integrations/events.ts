import type {
  IntegrationEventEnvelope,
  IntegrationInboxProjectionDef,
  IntegrationSubscription,
} from "@/types/plugin/plugin-integration"
import {
  appendIntegrationAudit,
  getIntegrationAccount,
  insertIntegrationEvent,
  listIntegrationSubscriptions,
} from "@/lib/db/integrations"
import { getDb } from "@/lib/db/schema"
import { createSession, updateSession } from "@/lib/db/sessions"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { findMatchingWorkflows } from "@/lib/workflow/runtime/trigger-subscriptions"
import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { getRegisteredIntegration } from "./registry"
import type { UIMessage } from "ai"

export interface PublishIntegrationEventResult {
  inserted: boolean
  workflowDispatches: number
  inboxProjections: number
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

function readJsonPointer(value: unknown, pointer: string): unknown {
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

async function projectEventToInbox(
  event: IntegrationEventEnvelope,
  subscription: IntegrationSubscription,
  projection: IntegrationInboxProjectionDef
): Promise<boolean> {
  if (!projection.eventTypes.includes(event.eventType)) return false
  const threadKey = pointerString(event.payload, projection.threadKeyPointer)
  const title = pointerString(event.payload, projection.titlePointer)
  const body = pointerString(event.payload, projection.bodyPointer)
  if (!threadKey || !title || !body) return false
  const url = projection.urlPointer
    ? pointerString(event.payload, projection.urlPointer)
    : undefined
  const binding = {
    pluginId: event.pluginId,
    integrationId: event.integrationId,
    accountId: event.accountId,
    projectionId: projection.id,
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
  const inserted = await insertIntegrationEvent(event)
  if (!inserted.inserted) {
    return { inserted: false, workflowDispatches: 0, inboxProjections: 0 }
  }

  const subscriptions = (await listIntegrationSubscriptions(pluginId, event.accountId)).filter(
    (subscription) => subscriptionMatches(subscription, event)
  )
  let workflowDispatches = 0
  let inboxProjections = 0
  for (const subscription of subscriptions) {
    const payload = { ...event, subscriptionId: subscription.id }
    const matches = findMatchingWorkflows("trigger.integration.event", {
      pluginId,
      integrationId: event.integrationId,
      accountId: event.accountId,
      eventType: event.eventType,
      resourceKind: event.resource?.kind,
      resourceId: event.resource?.id,
    })
    await Promise.all(
      matches.map(async (match) => {
        await dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.integration.event",
          triggerId: match.nodeId,
          payload,
          originAt: Date.now(),
        })
        workflowDispatches += 1
      })
    )

    if (subscription.inboxProjectionId) {
      const projection = registered.definition.inboxProjections?.find(
        (candidate) => candidate.id === subscription.inboxProjectionId
      )
      if (projection && (await projectEventToInbox(event, subscription, projection))) {
        inboxProjections += 1
      }
    }
  }

  await appendIntegrationAudit({
    pluginId,
    integrationId: event.integrationId,
    accountId: event.accountId,
    kind: `event.${event.eventType}`,
    outcome: "succeeded",
    detail: {
      eventId: event.id,
      deliveryId: event.deliveryId,
      workflowDispatches,
      inboxProjections,
    },
  })
  return { inserted: true, workflowDispatches, inboxProjections }
}
