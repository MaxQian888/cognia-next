/**
 * Where a plugin's delivery goes (ADR-0239).
 *
 * The outbound policy plans a delivery by its conversation key, and the
 * outbound runner sends it with the request's own platform reference
 * (`deliveryTarget.conversationRef`, else `conversationRef`). Host code builds
 * both from the same event or stored target; a plugin could hand over a key
 * the policy allows and a reference (or a Lark `receiveId` override) that
 * reaches someone else. So a plugin's request never keeps its own reference:
 * it is sent with the delivery target the host stored for that conversation,
 * which an inbound message refreshed or `bootstrapConversation` minted.
 *
 * The message ids a request points at must belong to the same conversation
 * too: on Lark a reply to a message id is posted into that message's chat, so
 * `replyTo` or `editTargetMessageId` naming another chat's message would also
 * reach it. An id counts when the host received it in, or delivered it to, the
 * conversation (`inboundLedger`); one that aged out of the ledger's window is
 * refused with the rest.
 */

import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import { isInboundRecorded } from "@/lib/db/inbound-ledger"
import type { OutboundRequest } from "@/types/connectors"
import { parseConversationKey, type ConversationDeliveryTarget } from "@/types/connectors/event"

import { wasDeliveredByUs } from "./delivered-messages"
import { findSessionByConversationKey } from "./session-bindings"

export type PluginDestinationProblem =
  /** The key is malformed, or names another bot than the one sending. */
  | "invalid-key"
  /** The request's own delivery target names another conversation or bot. */
  | "target-mismatch"
  /** No delivery target is stored for the conversation yet. */
  | "unknown-conversation"
  /** A reply or edit names a message the host never saw in this conversation. */
  | "foreign-message"

const PROBLEM_TEXT: Record<PluginDestinationProblem, string> = {
  "invalid-key": "the conversation key is malformed or belongs to another bot",
  "target-mismatch": "the request's delivery target names another conversation",
  "unknown-conversation":
    "no delivery target is known for this conversation yet: it must have received a message, or be bootstrapped (ctx.connectors.bootstrapConversation)",
  "foreign-message": "it replies to or edits a message that is not from this conversation",
}

/** A plugin's delivery names a destination the host cannot send it to. Nothing was persisted. */
export class PluginDestinationError extends Error {
  readonly code = "connector_delivery_destination"

  constructor(
    readonly problem: PluginDestinationProblem,
    readonly conversationKey: string
  ) {
    super(`ctx.connectors: cannot deliver to ${conversationKey}: ${PROBLEM_TEXT[problem]}`)
    this.name = "PluginDestinationError"
  }
}

export interface PluginDestinationDeps {
  storedTarget(conversationKey: string): Promise<ConversationDeliveryTarget | undefined>
  /** Whether the host received or delivered `messageId` in this conversation. */
  messageInConversation(
    adapterId: string,
    conversationKey: string,
    messageId: string
  ): Promise<boolean>
}

async function defaultStoredTarget(
  conversationKey: string
): Promise<ConversationDeliveryTarget | undefined> {
  const state = await getConnectorConversationState(conversationKey)
  if (state?.deliveryTarget) return state.deliveryTarget
  // A bootstrapped conversation has a bound session before any message.
  const session = await findSessionByConversationKey(conversationKey)
  return session?.platformBinding?.deliveryTarget
}

async function defaultMessageInConversation(
  adapterId: string,
  conversationKey: string,
  messageId: string
): Promise<boolean> {
  const received = await isInboundRecorded(adapterId, messageId, "inbound", conversationKey).catch(
    () => false
  )
  return received || wasDeliveredByUs(adapterId, conversationKey, messageId)
}

const defaultDeps: PluginDestinationDeps = {
  storedTarget: defaultStoredTarget,
  messageInConversation: defaultMessageInConversation,
}

/**
 * `request`, sent to the stored delivery target of `conversationKey` on
 * `adapterId`. Throws {@link PluginDestinationError} when there is none, or
 * when the request points anywhere else.
 */
export async function pluginDestination(
  adapterId: string,
  conversationKey: string,
  request: OutboundRequest,
  deps: Partial<PluginDestinationDeps> = {}
): Promise<OutboundRequest> {
  const { storedTarget, messageInConversation } = { ...defaultDeps, ...deps }
  let keyAdapter: string
  try {
    keyAdapter = parseConversationKey(conversationKey).adapterId
  } catch {
    throw new PluginDestinationError("invalid-key", conversationKey)
  }
  if (keyAdapter !== adapterId) throw new PluginDestinationError("invalid-key", conversationKey)

  const claimed = request.deliveryTarget?.address
  if (claimed && (claimed.conversationKey !== conversationKey || claimed.adapterId !== adapterId)) {
    throw new PluginDestinationError("target-mismatch", conversationKey)
  }

  const target = await storedTarget(conversationKey)
  if (
    !target ||
    target.address.conversationKey !== conversationKey ||
    target.address.adapterId !== adapterId
  ) {
    throw new PluginDestinationError("unknown-conversation", conversationKey)
  }

  const messageIds = [request.replyTo?.messageId, request.editTargetMessageId].filter(
    (id): id is string => typeof id === "string" && id !== ""
  )
  for (const messageId of messageIds) {
    if (!(await messageInConversation(adapterId, conversationKey, messageId))) {
      throw new PluginDestinationError("foreign-message", conversationKey)
    }
  }

  return { ...request, conversationRef: target.conversationRef, deliveryTarget: target }
}
