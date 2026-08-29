/**
 * Reveal a workflow proposal inside the editor's chat stream.
 *
 * Two surfaces point at the same card and neither could reach it: the sticky
 * banner takes a `onRevealInChat` callback (and hides its button without one),
 * and the changelog tab renders a "Reveal" button whose handler was optional
 * and never supplied — a visible control that did nothing. Both now call here.
 *
 * The card in the stream is tagged `data-proposal-id`; the changelog also
 * knows the id of the message that carried it, which survives when the card
 * itself has scrolled out of a virtualized list. Try the card first, fall
 * back to the message row.
 */

import { MESSAGE_ANCHOR_ATTR } from "@/lib/chat/message-anchor"

/** Attribute the proposal card in the chat stream is tagged with. */
export const PROPOSAL_ANCHOR_ATTR = "data-proposal-id"

function escapeAttrValue(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&")
}

/** CSS selector matching the proposal card for `proposalId`. */
export function proposalAnchorSelector(proposalId: string): string {
  return `[${PROPOSAL_ANCHOR_ATTR}="${escapeAttrValue(proposalId)}"]`
}

export interface RevealProposalInput {
  proposalId: string
  /** The chat message that carried the card, when the caller knows it. */
  messageId?: string
  /** Where to search. Defaults to the document. */
  root?: ParentNode | null
}

/**
 * Scroll the proposal into view. Returns the element it landed on, or `null`
 * when neither anchor is currently rendered — the caller can then say so
 * rather than silently doing nothing, which is the behaviour this replaces.
 */
export function revealProposalInChat({
  proposalId,
  messageId,
  root,
}: RevealProposalInput): HTMLElement | null {
  const scope: ParentNode | null = root ?? (typeof document !== "undefined" ? document : null)
  if (!scope) return null

  const target =
    scope.querySelector<HTMLElement>(proposalAnchorSelector(proposalId)) ??
    (messageId
      ? scope.querySelector<HTMLElement>(`[${MESSAGE_ANCHOR_ATTR}="${escapeAttrValue(messageId)}"]`)
      : null)
  if (!target) return null

  // `scrollIntoView` is missing in jsdom and in some embedded WebViews; the
  // reveal is a convenience, never a correctness path, so degrade quietly.
  target.scrollIntoView?.({ block: "center", behavior: "smooth" })
  return target
}
