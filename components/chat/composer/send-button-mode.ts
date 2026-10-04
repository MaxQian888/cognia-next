/**
 * Pure decision for what the composer's primary action button *is* right now,
 * and whether a secondary "send as a follow-up" control sits beside it.
 *
 * The button is one control with four jobs. The rule for a live turn: **the
 * primary button is Stop for as long as the turn runs** — same size, same
 * place as Send, so interrupting is always one tap on the control the thumb
 * already knows. It used to be taken over by Send the moment anything was
 * typed, and on runtimes whose dispatch stays pending for the whole run it sat
 * on a spinner instead, which left the run with no visible way to stop it.
 *
 * A send during a live turn is still a first-class path
 * (`use-claude-chat-controller`: a `streaming` / `awaiting_approval` session
 * routes the message into the steer lane instead of restarting the turn), so a
 * typed follow-up gets its own secondary control (`followUp`) next to Stop,
 * and Enter keeps queueing it. The control is never a no-op.
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
  /**
   * Synchronous "a dispatch is in flight" flag, set on click before any await.
   * During a live turn it means a FOLLOW-UP is being dispatched: the composer
   * stops reporting the turn's own dispatch once the turn is streaming.
   */
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
 * - `send` — submits a new turn.
 * - `stop` — interrupts the running turn.
 */
export type SendButtonMode = "draft" | "busy" | "send" | "stop"

/**
 * The secondary control offered beside Stop during a live turn: it sends what
 * is typed as a follow-up (steer) into the running turn. `busy` while that
 * follow-up (or an attachment staged for it) is still being prepared.
 */
export interface FollowUpButtonState {
  disabled: boolean
  busy: boolean
}

export interface SendButtonState {
  mode: SendButtonMode
  disabled: boolean
  variant: "default" | "secondary"
  /**
   * Only ever non-null with `mode: "stop"`: there is a follow-up to send (or
   * one being sent) while the turn runs. Null hides the control.
   */
  followUp: FollowUpButtonState | null
}

/**
 * Resolve the button. Priority is deliberate:
 *
 * 1. **streaming** — Stop, always enabled: interrupting is a local action, so
 *    neither the concurrent-stream cap nor a blocked outbound path disables it.
 *    A follow-up control rides alongside when there is something that could be
 *    sent (or one is already on its way).
 * 2. **busy** — a local dispatch or attachment prep owns the button; it shows a
 *    spinner and rejects clicks (`submit()` has its own re-entrancy guard, this
 *    just stops the button from lying about being clickable).
 * 3. **draft** — pending connector drafts, with nothing typed. An empty box has
 *    nothing to send, so the button's one useful job is the drafts waiting
 *    beside it. The moment the user types, it is Send again: a pending draft
 *    must never stand between someone and their own reply. Reviewing is a
 *    local action, so the concurrent-stream cap and a blocked outbound path do
 *    not disable it.
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

  // A send is only possible with something to send, and only if nothing blocks
  // the outbound path. Identical to `submit()`'s own early returns, so the
  // button's enabled state and the submit guard can never disagree.
  const canSend = hasContent && !composerDisabled && !outboundBlocked

  if (status === "streaming") {
    const followUpBusy = isSending || isPreparingAttachments
    const followUp: FollowUpButtonState | null = followUpBusy
      ? { disabled: true, busy: true }
      : canSend
        ? { disabled: false, busy: false }
        : null
    // Same fill as Send: the button changes its job, not its weight. A
    // destructive red on every running turn read as an error state.
    return { mode: "stop", disabled: false, variant: "default", followUp }
  }

  // `submitted` is included for completeness even though the wrapper never
  // emits it today: it means "dispatched, not yet streaming", a window where a
  // second send would restart the turn rather than steer it.
  if (isSending || isPreparingAttachments || status === "submitted") {
    return { mode: "busy", disabled: true, variant: "default", followUp: null }
  }

  if (hasPendingDrafts && !hasContent) {
    return { mode: "draft", disabled: false, variant: "secondary", followUp: null }
  }

  return { mode: "send", disabled: !canSend, variant: "default", followUp: null }
}
