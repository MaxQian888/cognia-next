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
 * Telegram, Slack, Discord and Matrix. An id is placed, in this order, by:
 *
 * 1. the inbound ledger: the host received it in, or delivered it to, the
 *    conversation (a window of recent messages);
 * 2. the message the host stored when it received it (`messages`, scoped to
 *    the bot and the chat), which does not age out;
 * 3. the adapter (`PlatformAdapter.messageRoute`): where a reply or edit of
 *    that id, sent through the stored reference, lands. Lark reads the
 *    message's chat from the platform; the composite-id adapters read the id;
 *    the rest keep every delivery in the reference's chat.
 *
 * An id placed in another chat is refused (`foreign-message`), and so is one
 * nothing can place (`unplaced-message`: an adapter that is not running, or a
 * message the platform will not return).
 */

import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import { isInboundRecorded } from "@/lib/db/inbound-ledger"
import { getDb } from "@/lib/db/schema"
import type { MessageRoute, OutboundRequest } from "@/types/connectors"
import {
  parseConversationKey,
  type ConversationDeliveryTarget,
  type ConversationReference,
} from "@/types/connectors/event"

import { wasDeliveredByUs } from "./delivered-messages"
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
  /**
   * Where a reply to or an edit of `messageId` through `conversationRef`
   * lands, as the module comment orders the evidence.
   */
  messageRoute(input: {
    adapterId: string
    conversationKey: string
    messageId: string
    use: "reply" | "edit"
    conversationRef: ConversationReference
  }): Promise<MessageRoute>
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

/** Whether two conversation keys name the same chat of the same bot, any thread. */
function sameBotChat(a: string, b: string): boolean {
  try {
    const left = parseConversationKey(a)
    const right = parseConversationKey(b)
    return (
      left.remoteChatId !== "" &&
      left.platform === right.platform &&
      left.adapterId === right.adapterId &&
      left.remoteChatId === right.remoteChatId
    )
  } catch {
    return false
  }
}

/** Whether the host stored `messageId` as received in this chat of this bot. */
async function storedInChat(
  adapterId: string,
  conversationKey: string,
  messageId: string
): Promise<boolean> {
  const rows = await getDb().messages.where("platformMessageId").equals(messageId).toArray()
  return rows.some((row) => {
    const received = (row.metadata as { platformMessage?: unknown } | undefined)
      ?.platformMessage as { adapterId?: unknown; conversationKey?: unknown } | undefined
    // Rows from before the bot and conversation were recorded cannot be placed.
    return (
      received?.adapterId === adapterId &&
      typeof received.conversationKey === "string" &&
      sameBotChat(received.conversationKey, conversationKey)
    )
  })
}

async function defaultMessageRoute(input: {
  adapterId: string
  conversationKey: string
  messageId: string
  use: "reply" | "edit"
  conversationRef: ConversationReference
}): Promise<MessageRoute> {
  const { adapterId, conversationKey, messageId } = input
  const received = await isInboundRecorded(adapterId, messageId, "inbound", conversationKey).catch(
    () => false
  )
  if (received || (await wasDeliveredByUs(adapterId, conversationKey, messageId))) {
    return "within"
  }
  if (await storedInChat(adapterId, conversationKey, messageId).catch(() => false)) {
    return "within"
  }
  try {
    const { getBus } = await import("./bus")
    const adapter = getBus().getAdapter(adapterId)
    if (!adapter?.messageRoute) return "unknown"
    return await adapter.messageRoute(messageId, input.use, input.conversationRef)
  } catch {
    return "unknown"
  }
}

const defaultDeps: PluginDestinationDeps = {
  storedTarget: defaultStoredTarget,
  messageRoute: defaultMessageRoute,
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
  const { storedTarget, messageRoute } = { ...defaultDeps, ...deps }
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

  const pointers = [
    { use: "reply" as const, messageId: request.replyTo?.messageId },
    { use: "edit" as const, messageId: request.editTargetMessageId },
  ]
  for (const { use, messageId } of pointers) {
    if (typeof messageId !== "string" || messageId === "") continue
    const route = await messageRoute({
      adapterId,
      conversationKey,
      messageId,
      use,
      conversationRef: target.conversationRef,
    })
    if (route === "elsewhere") throw new PluginDestinationError("foreign-message", conversationKey)
    if (route !== "within") throw new PluginDestinationError("unplaced-message", conversationKey)
  }

  return { ...request, conversationRef: target.conversationRef, deliveryTarget: target }
}
