/**
 * Feishu private chats with threaded replies.
 *
 * With `replyInThread` on, each top-level message starts its own conversation;
 * replies inside that thread continue it. The stable root message id selects
 * the session, while the latest inbound message id anchors the bot's replies
 * (run cards, answers and notices) inside the same thread. Private scope is
 * preserved so these threads never require an @mention.
 */

/** Set on a private chat's conversation reference when its replies go into threads. */
export const LARK_PRIVATE_THREAD_REPLY = "replyInThread"

/**
 * The message whose thread a private-chat reply goes into, or undefined when
 * this reference does not reply in threads.
 */
export function privateThreadReplyAnchor(
  ref: Record<string, unknown> | undefined
): string | undefined {
  if (!ref || ref[LARK_PRIVATE_THREAD_REPLY] !== true) return undefined
  const anchor = ref["threadRootMessageId"]
  return typeof anchor === "string" && anchor.length > 0 ? anchor : undefined
}
