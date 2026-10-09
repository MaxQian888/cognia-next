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

/**
 * `/inbox/c` for one exact session. Several sessions can bind the same IM
 * conversation (a re-created session keeps the key), so the list and the
 * triage pane always name the session they show rather than letting the
 * redirect pick the newest one.
 */
export function inboxSessionHref(conversationKey: string, sessionId: string): string {
  return `${inboxConversationHref(conversationKey)}&sessionId=${encodeURIComponent(sessionId)}`
}

/** A list scope the Inbox has a route for. */
export type InboxScope =
  { kind: "adapter"; adapterId: string } | { kind: "platform"; platform: string }

/**
 * The scoped list route. `/inbox/platform` reads `kind` (not `platformKind`):
 * that is the route's existing contract, and bookmarks already carry it.
 */
export function inboxScopeHref(scope: InboxScope): string {
  return scope.kind === "adapter"
    ? `/inbox/adapter?adapterId=${encodeURIComponent(scope.adapterId)}`
    : `/inbox/platform?kind=${encodeURIComponent(scope.platform)}`
}
