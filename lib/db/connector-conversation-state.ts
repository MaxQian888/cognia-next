import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import type { ConnectorConversationStateRow } from "./connector-types"
import { getDb } from "./schema"

export async function getConnectorConversationState(
  conversationKey: string
): Promise<ConnectorConversationStateRow | undefined> {
  return getDb().connectorConversationStates.get(conversationKey)
}

export async function activateConnectorConversation(
  deliveryTarget: ConversationDeliveryTarget,
  options: { activatedBy: string; expiresAt: number; sourceTimestamp?: number; now?: number }
): Promise<ConnectorConversationStateRow> {
  const now = options.now ?? Date.now()
  const existing = await getConnectorConversationState(deliveryTarget.address.conversationKey)
  const row: ConnectorConversationStateRow = {
    conversationKey: deliveryTarget.address.conversationKey,
    adapterId: deliveryTarget.address.adapterId,
    activationStatus: "active",
    activatedBy: options.activatedBy,
    activatedAt: existing?.activatedAt ?? now,
    lastHumanActivityAt: now,
    expiresAt: options.expiresAt,
    dispatchMode: existing?.dispatchMode,
    deliveryReadiness: existing?.deliveryReadiness ?? "unknown",
    deliveryTarget,
    historyCursor:
      options.sourceTimestamp !== undefined
        ? { afterTimestamp: options.sourceTimestamp }
        : existing?.historyCursor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getDb().connectorConversationStates.put(row)
  return row
}

export async function touchConnectorConversation(
  conversationKey: string,
  options: {
    deliveryTarget?: ConversationDeliveryTarget
    expiresAt?: number
    sourceTimestamp?: number
    now?: number
  }
): Promise<ConnectorConversationStateRow | undefined> {
  const existing = await getConnectorConversationState(conversationKey)
  if (!existing) return undefined
  const now = options.now ?? Date.now()
  const row: ConnectorConversationStateRow = {
    ...existing,
    ...(options.deliveryTarget ? { deliveryTarget: options.deliveryTarget } : {}),
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    ...(options.sourceTimestamp !== undefined
      ? { historyCursor: { afterTimestamp: options.sourceTimestamp } }
      : {}),
    lastHumanActivityAt: now,
    updatedAt: now,
  }
  await getDb().connectorConversationStates.put(row)
  return row
}

export async function closeConnectorConversation(
  conversationKey: string,
  options: { now?: number } = {}
): Promise<ConnectorConversationStateRow | undefined> {
  const existing = await getConnectorConversationState(conversationKey)
  if (!existing) return undefined
  const row: ConnectorConversationStateRow = {
    ...existing,
    activationStatus: "inactive",
    expiresAt: undefined,
    updatedAt: options.now ?? Date.now(),
  }
  await getDb().connectorConversationStates.put(row)
  return row
}
