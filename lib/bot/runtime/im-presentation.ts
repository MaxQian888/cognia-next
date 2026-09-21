/**
 * Give an IM-originated Bot delivery a presentation binding.
 *
 * A `connector.inbound` delivery carries the conversation's delivery target in
 * its payload (`sources/connector-inbound.ts`). Writing an
 * `executionRunBinding` for the Bot run is ALL the generic run-presentation
 * plane needs — its liveQuery picks the binding up and the run then gets the
 * same surface an agent-turn gets on that platform: progress card, native COT
 * on Lark, approve/deny controls for parked interrupts, terminal milestone.
 *
 * Best-effort by contract: a Bot run is never failed because its progress
 * could not be announced.
 */

import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import type {
  ConversationAddress,
  ConversationDeliveryTarget,
  ConversationReference,
} from "@/types/connectors/event"
import type { ExecutionRunBinding } from "@/types/execution/run"
import { getDb } from "@/lib/db/schema"
import { putExecutionRunBinding } from "@/lib/db/execution-runs"
import { appendAudit } from "@/lib/connectors/audit"
import { getSettings } from "@/lib/db/settings"

/** Deterministic binding id — a re-entered delivery finds its own row. */
export function botImPresentationBindingId(
  runId: string,
  adapterId: string,
  conversationKey: string
): string {
  return `execution-binding:${runId}:${adapterId}:${conversationKey}`
}

function asDeliveryTarget(value: unknown): ConversationDeliveryTarget | undefined {
  if (!value || typeof value !== "object") return undefined
  const target = value as Partial<ConversationDeliveryTarget>
  const address = target.address as Partial<ConversationAddress> | undefined
  const ref = target.conversationRef as Partial<ConversationReference> | undefined
  if (
    !address ||
    typeof address.conversationKey !== "string" ||
    typeof address.platform !== "string" ||
    typeof address.adapterId !== "string" ||
    typeof address.containerId !== "string" ||
    !ref ||
    typeof ref.platform !== "string" ||
    typeof ref.adapterId !== "string"
  ) {
    return undefined
  }
  return target as ConversationDeliveryTarget
}

/**
 * Bind a Bot run to the IM conversation its event came from. No-op when the
 * delivery did not originate in a connector conversation, the payload's
 * delivery target does not match the routing binding, or a binding already
 * exists for this (run, conversation) pair.
 */
export async function bindImPresentationForBotDelivery(
  delivery: BotEventDeliveryRow,
  runId: string
): Promise<void> {
  try {
    const adapterId = delivery.envelope.binding?.adapterId
    const conversationKey = delivery.envelope.binding?.conversationKey
    const payload =
      delivery.envelope.payload && typeof delivery.envelope.payload === "object"
        ? (delivery.envelope.payload as Record<string, unknown>)
        : undefined
    const deliveryTarget = asDeliveryTarget(payload?.deliveryTarget)
    const sourceMessageId =
      deliveryTarget?.sourceMessageId ??
      (typeof payload?.messageId === "string" ? payload.messageId : undefined)
    if (!adapterId || !conversationKey || !deliveryTarget) return
    // A target that names a different conversation than the routing binding
    // would present the run into the wrong chat — drop it rather than guess.
    if (
      deliveryTarget.address.adapterId !== adapterId ||
      deliveryTarget.address.conversationKey !== conversationKey
    ) {
      return
    }

    const id = botImPresentationBindingId(runId, adapterId, conversationKey)
    if (await getDb().executionRunBindings.get(id)) return

    const language = await getSettings()
      .then((settings) => settings?.language)
      .catch(() => undefined)

    const binding: ExecutionRunBinding = {
      id,
      runId,
      ...(delivery.envelope.binding?.projectId
        ? { projectId: delivery.envelope.binding.projectId }
        : {}),
      adapterId,
      conversationKey,
      status: "active",
      deliveryMode: "native",
      ...(language ? { locale: language } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      deliveryTarget,
      ...(delivery.envelope.actor?.id ? { recipientUserId: delivery.envelope.actor.id } : {}),
      lastProjectedRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await putExecutionRunBinding(binding)
  } catch (error) {
    await appendAudit({
      adapterId: delivery.envelope.binding?.adapterId ?? "unknown",
      kind: "adapter.error",
      at: Date.now(),
      conversationKey: delivery.envelope.binding?.conversationKey ?? "",
      reason: "bot_run_presentation_bind_failed",
      message: error instanceof Error ? error.message : String(error),
      fields: { runId, deliveryId: delivery.id },
    }).catch(() => undefined)
  }
}
