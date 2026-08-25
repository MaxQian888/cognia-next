// Single source of truth for chat bubble geometry (ADR-0148).
//
// Three files used to decide independently what a message looks like:
//
//   1. `components/ai-elements/message.tsx` (vendored) — user bubble
//      `rounded-lg bg-secondary px-4 py-3`
//   2. `components/chat/message-renderer.tsx` — overrode (1), but only when the
//      layout was not `cards`
//   3. `components/chat/message-shell.tsx` — a third treatment for the `cards`
//      shell and the `bubbles` assistant bubble
//
// Because (2) opted out of `cards`, the user bubble in that layout silently
// fell through to the vendored default — a different colour, corner and padding
// from every other layout, chosen by nobody. Owning the strings here means the
// two sides of a conversation can be compared by reading one file.
//
// The user bubble and the assistant bubble deliberately live on DIFFERENT
// elements: the user's hugs its content (`w-fit ml-auto` on `MessageContent`),
// the assistant's is the full message shell. That is a layout constraint, not
// duplication — which is exactly why the class strings, rather than the DOM,
// are what gets centralised.

import type { MessageDisplayLayout } from "@/types/appearance"

/**
 * `rounded-2xl` is deliberate and NOT migrated to the named scale: it is 16px
 * where `rounded-stage` is 14px, and bubbles already follow a style pack
 * through the `rounded-2xl` rebase in globals.css. Swapping it would move the
 * default look by 2px to buy nothing.
 */
const BUBBLE_RADIUS = "rounded-2xl"

/**
 * Classes for the user's message body, applied to `MessageContent`.
 *
 * Every layout returns a value, so the vendored default is always overridden
 * and can never leak back in.
 */
export function userBubbleClass(layout: MessageDisplayLayout): string {
  if (layout === "cards") {
    // Inside a card shell the bubble is one step tighter — it is nested, not
    // free-floating. Previously this branch returned nothing and inherited the
    // vendored `bg-secondary` treatment by accident.
    return "group-[.is-user]:rounded-panel group-[.is-user]:bg-muted/70 group-[.is-user]:px-3 group-[.is-user]:py-2"
  }
  return `group-[.is-user]:${BUBBLE_RADIUS} group-[.is-user]:rounded-br-md group-[.is-user]:bg-muted/70 group-[.is-user]:px-4 group-[.is-user]:py-2.5`
}

/** Classes for the assistant's bubble, applied to the message shell. */
export function assistantBubbleClass(layout: MessageDisplayLayout): string {
  return layout === "bubbles" ? `${BUBBLE_RADIUS} bg-muted/45 px-4 py-3` : ""
}

/** Classes for the card shell that wraps every message in the `cards` layout. */
export function messageCardClass(layout: MessageDisplayLayout): string {
  return layout === "cards" ? "rounded-stage border bg-card p-3 shadow-sm" : ""
}
