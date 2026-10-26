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
 * The message ids a request points at must keep it in the same chat too: on
 * Lark a reply to or an edit of a message id lands in that message's chat,
 * and an edit's composite id (`chatId:messageId`) names its own chat on
 * Telegram, Slack, Discord and Matrix. Each id is placed by
 * `message-placement.ts`. One in another chat is refused (`foreign-message`),
 * and so is one nothing can place (`unplaced-message`). One that cannot be
 * placed now (the bot is not running here, or the platform could not be
 * asked) is placed again just before a queued delivery is sent
 * (`metadata.pendingPlacement`); a delivery sent at once refuses it.
 */

import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import type { OutboundRequest } from "@/types/connectors"
import { parseConversationKey, type ConversationDeliveryTarget } from "@/types/connectors/event"

import {
  messagePointers,
  placeMessage,
  type MessagePlacement,
  type PlaceMessageInput,
} from "./message-placement"
import { findSessionByConversationKey } from "./session-bindings"

export type PluginDestinationProblem =
  /** The key is malformed, or names another bot than the one sending. */
  | "invalid-key"
  /** The request's own delivery target names another conversation or bot. */
  | "target-mismatch"
  /** No delivery target is stored for the conversation yet. */
  | "unknown-conversation"
  /** A reply or edit names a message in another chat. */
  | "foreign-message"
  /** A reply or edit names a message nothing can place in this chat. */
  | "unplaced-message"

const PROBLEM_TEXT: Record<PluginDestinationProblem, string> = {
  "invalid-key": "the conversation key is malformed or belongs to another bot",
  "target-mismatch": "the request's delivery target names another conversation",
  "unknown-conversation":
    "no delivery target is known for this conversation yet: it must have received a message, or be bootstrapped (ctx.connectors.bootstrapConversation)",
  "foreign-message": "it replies to or edits a message that is not from this conversation",
  "unplaced-message":
    "it replies to or edits a message the host cannot place in this conversation (the bot is not running, or the platform did not return the message)",
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
  /** Where a reply to or an edit of a message lands (`placeMessage`). */
  placeMessage(input: PlaceMessageInput): Promise<MessagePlacement>
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

async function defaultPlaceMessage(input: PlaceMessageInput): Promise<MessagePlacement> {
  return placeMessage(input, {
    getAdapter: async (adapterId) => {
      const { getBus } = await import("./bus")
      return getBus().getAdapter(adapterId)
    },
  })
}

const defaultDeps: PluginDestinationDeps = {
  storedTarget: defaultStoredTarget,
  placeMessage: defaultPlaceMessage,
}

export interface PluginDestinationOptions {
  /**
   * The request is queued, so a message that cannot be placed now is placed
   * again before it is sent (`metadata.pendingPlacement`). Otherwise it is
   * refused.
   */
  queued?: boolean
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
  deps: Partial<PluginDestinationDeps> = {},
  options: PluginDestinationOptions = {}
): Promise<OutboundRequest> {
  const { storedTarget, placeMessage: place } = { ...defaultDeps, ...deps }
  // The plugin keeps its request object and may change it while the checks
  // below await: check and return one copy of it, so what is placed is what
  // is queued (Codex review). The message pointers are the fields that
  // decide where it lands; `metadata` is rebuilt below.
  const own: OutboundRequest = {
    ...request,
    metadata: { ...request.metadata },
    ...(request.replyTo ? { replyTo: { ...request.replyTo } } : {}),
  }
  let keyAdapter: string
  try {
    keyAdapter = parseConversationKey(conversationKey).adapterId
  } catch {
    throw new PluginDestinationError("invalid-key", conversationKey)
  }
  if (keyAdapter !== adapterId) throw new PluginDestinationError("invalid-key", conversationKey)

  const claimed = own.deliveryTarget?.address
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

  const pending: NonNullable<OutboundRequest["metadata"]["pendingPlacement"]> = []
  for (const pointer of messagePointers(own)) {
    const placement = await place({
      ...pointer,
      adapterId,
      conversationKey,
      conversationRef: target.conversationRef,
    })
    if (placement === "within") continue
    if (placement === "elsewhere") {
      throw new PluginDestinationError("foreign-message", conversationKey)
    }
    if (placement === "unavailable" && options.queued) {
      pending.push(pointer)
      continue
    }
    throw new PluginDestinationError("unplaced-message", conversationKey)
  }

  // The host writes `pendingPlacement`; a value the plugin set is dropped.
  const { pendingPlacement: _plugin, ...metadata } = own.metadata
  return {
    ...own,
    metadata: pending.length > 0 ? { ...metadata, pendingPlacement: pending } : metadata,
    conversationRef: target.conversationRef,
    deliveryTarget: target,
  }
}
