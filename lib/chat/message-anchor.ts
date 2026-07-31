/**
 * Message anchors — the DOM contract that lets any surface point at one message
 * in the conversation.
 *
 * Every rendered message row carries `data-msg-id`. That attribute is the only
 * way to reach a row from outside the message list (the list itself prefers the
 * virtualizer's index when it has one), and it had been rendered on the
 * document-flow branch only — so under virtualization every DOM-path jump
 * silently resolved to nothing.
 *
 * The selector escaping lived twice (`message-list` hand-rolled a quote/
 * backslash escape, `use-timeline-scroll-sync` used `CSS.escape` with a
 * fallback) and the two disagreed. One implementation now.
 */

/** Where a jumped-to message should come to rest in the viewport. */
export type JumpAlign = "start" | "center"

/** Attribute every message row is tagged with, in both render paths. */
export const MESSAGE_ANCHOR_ATTR = "data-msg-id"

/**
 * CSS selector matching the row for `messageId`. Message ids are generated
 * (nanoid / provider ids) but are not guaranteed to be selector-safe, so they
 * go through `CSS.escape` where it exists — jsdom and older WebViews get the
 * quote/backslash fallback, which is enough for the id shapes we mint.
 */
export function messageAnchorSelector(messageId: string): string {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(messageId)
      : messageId.replace(/["\\]/g, "\\$&")
  return `[${MESSAGE_ANCHOR_ATTR}="${escaped}"]`
}

/** The rendered row for `messageId` inside `root`, or null when not rendered. */
export function findMessageAnchor(
  root: ParentNode | null | undefined,
  messageId: string
): HTMLElement | null {
  if (!root) return null
  return root.querySelector<HTMLElement>(messageAnchorSelector(messageId))
}
