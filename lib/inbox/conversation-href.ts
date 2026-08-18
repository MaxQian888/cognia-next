/**
 * In-app route for one platform-bound (IM) conversation.
 *
 * `/inbox/c` reads `key` and, optionally, `messageId` (`app/inbox/c/page.tsx`)
 * — the latter lands the pane on one message once the session hydrates. Every
 * cross-link into the Inbox (⌘K hits, the chat header, "send to IM" toasts)
 * builds its href here so the two params are spelled once.
 */
export function inboxConversationHref(conversationKey: string, messageId?: string): string {
  const base = `/inbox/c?key=${encodeURIComponent(conversationKey)}`
  return messageId ? `${base}&messageId=${encodeURIComponent(messageId)}` : base
}
