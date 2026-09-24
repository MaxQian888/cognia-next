/**
 * Pure decision for what the composer's primary action button *is* right now.
 *
 * The button is one control with four jobs, and the old inline ternaries got
 * one combination wrong: while a turn streamed it always read "Stop", even
 * with a message typed. That is a dead end — a send during a live turn is a
 * first-class path (`use-claude-chat-controller`: a `streaming` /
 * `awaiting_approval` session routes the message into the steer lane instead
 * of restarting the turn), so the user's typed follow-up had no button.
 *
 * The rule this module encodes: **during a live turn the button offers Send if
 * and only if a send would actually be accepted; otherwise it offers Stop.**
 * The control is never a no-op, and Stop is always one click away the moment
 * the box is empty (which it is again right after a follow-up is queued).
 *
 * Extracted (rather than left inline) because the interesting part is the
 * combination table — busy × streaming × content × blocked — and mounting the
 * whole composer to assert an icon is not how that gets covered.
 */

/** Statuses `ComposerInner` can see. Mirrors ai-elements' `ChatStatus`; the
 * wrapper folds the store's `awaiting_approval` into `"streaming"`, so both
 * turn phases that accept a steer arrive here as `"streaming"`. */
export type SendButtonStatus = "submitted" | "streaming" | "ready" | "error"

export interface SendButtonInput {
  /** `ComposerInner`'s `status` prop. */
  status: SendButtonStatus | undefined
  /** Synchronous "a dispatch is in flight" flag, set on click before any await. */
  isSending: boolean
  /** One or more staged attachments are still being extracted/converted. */
  isPreparingAttachments: boolean
  /** Trimmed text is non-empty, or at least one attachment is staged. */
  hasContent: boolean
  /**
   * A platform conversation has drafted replies waiting for review. With an
   * empty box the button offers to review them; typing takes it back.
   */
  hasPendingDrafts: boolean
  /** `ComposerInner`'s `disabled` prop (concurrent-stream cap, etc.). */
  composerDisabled: boolean
  /** Web shell + a platform-bound session: this shell cannot send outbound. */
  outboundBlocked: boolean
}

/**
 * - `draft` — pending connector drafts and an empty box; opens the draft
 *   review dialog.
 * - `busy` — a dispatch (or attachment prep) is in flight; non-interactive.
 * - `send` — submits. `queues` says whether that lands as a follow-up.
 * - `stop` — interrupts the running turn.
 */
export type SendButtonMode = "draft" | "busy" | "send" | "stop"

export interface SendButtonState {
  mode: SendButtonMode
  disabled: boolean
  /**
   * True only for `mode: "send"` during a live turn: the message joins the
   * running turn as a follow-up (steer) rather than starting a new one. Drives
   * the label/tooltip so the button does not promise a fresh turn.
   */
  queues: boolean
  variant: "default" | "destructive" | "secondary"
}

/**
 * Resolve the button. Priority is deliberate:
 *
 * 1. **busy** — a local dispatch or attachment prep owns the button; it shows a
 *    spinner and rejects clicks (`submit()` has its own re-entrancy guard, this
 *    just stops the button from lying about being clickable).
 * 2. **draft** — pending connector drafts, with nothing typed and no turn
 *    running. An empty box has nothing to send, so the button's one useful job
 *    is the drafts waiting beside it. The moment the user types, it is Send
 *    again: a pending draft must never stand between someone and their own
 *    reply, which is what the old "replace the control outright" rule did.
 *    Reviewing is a local action, so the concurrent-stream cap and a blocked
 *    outbound path do not disable it.
 * 3. **streaming** — Send when the send would be accepted, Stop otherwise.
 * 4. **idle / error** — Send, enabled only when there is something to send.
 */
export function resolveSendButton(input: SendButtonInput): SendButtonState {
  const {
    status,
    isSending,
    isPreparingAttachments,
    hasContent,
    hasPendingDrafts,
    composerDisabled,
    outboundBlocked,
  } = input

  // `submitted` is included for completeness even though the wrapper never
  // emits it today: it means "dispatched, not yet streaming", a window where a
  // second send would restart the turn rather than steer it.
  if (isSending || isPreparingAttachments || status === "submitted") {
    return { mode: "busy", disabled: true, queues: false, variant: "default" }
  }

  if (hasPendingDrafts && !hasContent && status !== "streaming") {
    return { mode: "draft", disabled: false, queues: false, variant: "secondary" }
  }

  // A send is only possible with something to send, and only if nothing blocks
  // the outbound path. Identical to `submit()`'s own early returns, so the
  // button's enabled state and the submit guard can never disagree.
  const canSend = hasContent && !composerDisabled && !outboundBlocked

  if (status === "streaming") {
    // Typed a follow-up mid-turn → Send (queued as a steer). Nothing to send →
    // Stop, which stays reachable even when the composer is disabled or the
    // shell cannot write outbound: interrupting is a local action.
    if (canSend) {
      return { mode: "send", disabled: false, queues: true, variant: "default" }
    }
    return { mode: "stop", disabled: false, queues: false, variant: "destructive" }
  }

  return { mode: "send", disabled: !canSend, queues: false, variant: "default" }
}
