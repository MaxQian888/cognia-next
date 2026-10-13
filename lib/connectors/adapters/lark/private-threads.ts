/**
 * Feishu private chats with threaded replies.
 *
 * A private chat is one conversation: every message in it, and every reply in
 * any of its threads (话题), continues the same session. With the adapter's
 * `replyInThread` on, what the bot says about a message (its run card, the
 * answer, any notice) is posted into that message's thread instead of the
 * main chat, so the chat itself keeps only what the person wrote. The address
 * stays the whole chat (history, routing and the session key are unchanged);
 * only the delivery anchor moves, carried on the conversation reference.
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
