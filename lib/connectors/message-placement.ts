/**
 * Where a delivery lands when it replies to or edits a message (ADR-0239).
 *
 * On some platforms the message id, not the conversation reference, picks
 * the chat: Lark's reply and edit endpoints are keyed by the id alone, and an
 * edit's composite id (`chatId:messageId`) names its own chat on Telegram,
 * Slack, Discord and Matrix. So before a plugin's request may point at a
 * message, the message is placed, in this order, by:
 *
 * 1. the inbound ledger: the host received it in, or delivered it to, the
 *    conversation (`delivered-messages.ts` keeps what it delivered longer
 *    than the inbound window);
 * 2. the message the host stored when it received it (`messages`, scoped to
 *    the bot and the chat), which does not age out;
 * 3. the running adapter (`PlatformAdapter.messageRoute`), told which
 *    platform chats the host's deliveries to the conversation landed in.
 *
 * `"unavailable"` means it cannot be told now: the bot is not running here,
 * or the platform could not be asked (a network error, a rate limit). A
 * queued delivery is then placed again just before it is sent
 * (`metadata.pendingPlacement`, checked by the outbound runner); anything
 * else is refused. An adapter without `messageRoute` answers `"unknown"`.
 *
 * Used by `plugin-destination.ts` when a plugin's request is accepted and by
 * `outbound-runner.ts` before it is sent, so both apply the same evidence.
 */

import { isInboundRecorded } from "@/lib/db/inbound-ledger"
import { getDb } from "@/lib/db/schema"
import type { MessageRoute, OutboundRequest, PlatformAdapter } from "@/types/connectors"
import { parseConversationKey, type ConversationReference } from "@/types/connectors/event"

import { landedChatsOf, wasDeliveredByUs } from "./delivered-messages"

/** A placement: a route, or `"unavailable"` when it cannot be told now. */
export type MessagePlacement = MessageRoute | "unavailable"

/** A message a request points at. */
export interface MessagePointer {
  use: "reply" | "edit"
  messageId: string
}

export interface PlaceMessageInput extends MessagePointer {
  adapterId: string
  conversationKey: string
  /** The reference the delivery is sent through (the stored target's). */
  conversationRef: ConversationReference
}

export interface MessagePlacementDeps {
  /** The running adapter `adapterId` names here, if any. */
  getAdapter(
    adapterId: string
  ):
    | Pick<PlatformAdapter, "messageRoute">
    | undefined
    | Promise<Pick<PlatformAdapter, "messageRoute"> | undefined>
  /** Whether the host received or delivered the message in this conversation. Default: the ledger. */
  recorded?(adapterId: string, conversationKey: string, messageId: string): Promise<boolean>
  /** Whether the host stored the message as received in this chat. Default: `messages`. */
  stored?(adapterId: string, conversationKey: string, messageId: string): Promise<boolean>
  /** The platform chats the host's deliveries to this conversation landed in. Default: the ledger. */
  landed?(adapterId: string, conversationKey: string): Promise<string[]>
}

/** The messages `request` replies to or edits, in that order. */
export function messagePointers(
  request: Pick<OutboundRequest, "replyTo" | "editTargetMessageId">
): MessagePointer[] {
  const pointers: MessagePointer[] = []
  const reply = request.replyTo?.messageId
  if (typeof reply === "string" && reply !== "") pointers.push({ use: "reply", messageId: reply })
  const edit = request.editTargetMessageId
  if (typeof edit === "string" && edit !== "") pointers.push({ use: "edit", messageId: edit })
  return pointers
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

async function defaultRecorded(
  adapterId: string,
  conversationKey: string,
  messageId: string
): Promise<boolean> {
  const received = await isInboundRecorded(adapterId, messageId, "inbound", conversationKey).catch(
    () => false
  )
  return received || wasDeliveredByUs(adapterId, conversationKey, messageId)
}

async function defaultStored(
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

/** Place one message a delivery points at (see the module comment). */
export async function placeMessage(
  input: PlaceMessageInput,
  deps: MessagePlacementDeps
): Promise<MessagePlacement> {
  const { adapterId, conversationKey, messageId } = input
  const recorded = deps.recorded ?? defaultRecorded
  if (await recorded(adapterId, conversationKey, messageId).catch(() => false)) return "within"
  const stored = deps.stored ?? defaultStored
  if (await stored(adapterId, conversationKey, messageId).catch(() => false)) return "within"

  let adapter: Pick<PlatformAdapter, "messageRoute"> | undefined
  try {
    adapter = await deps.getAdapter(adapterId)
  } catch {
    return "unavailable"
  }
  if (!adapter) return "unavailable"
  if (!adapter.messageRoute) return "unknown"
  let landed: string[] = []
  try {
    landed = await (deps.landed ?? landedChatsOf)(adapterId, conversationKey)
  } catch {
    // None known.
  }
  try {
    return await adapter.messageRoute(messageId, input.use, input.conversationRef, {
      landedChatIds: landed,
    })
  } catch {
    // The platform could not be asked now; a definite answer is "unknown".
    return "unavailable"
  }
}
