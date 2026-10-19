/**
 * The window event that hands material to a mounted composer from outside it:
 * a chat-message card appending OCR text, a sidechat handing back a conclusion,
 * a plugin, or a stopped turn putting its queued follow-ups back.
 *
 * Lives outside `components/chat/composer.tsx` so the runtime side (the steer
 * queue in `hooks/chat/steer-runtime.ts`) can dispatch it without importing the
 * composer component. The composer re-exports these for its existing callers.
 */

import type { MessageReplyTo } from "@cognia/agent-config-types"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type { CarriedPromptPreamble } from "@/lib/chat/prompt-preamble"

/** Window-event name a chat-message card dispatches to append to the composer. */
export const COMPOSER_APPEND_EVENT = "cognia:composer-append"

/** Detail of a {@link COMPOSER_APPEND_EVENT}. */
export interface ComposerAppendDetail {
  text?: string
  /**
   * Which composer should take the text. More than one composer is mounted at
   * once — split view has two, and a workbench sidechat adds another — so an
   * un-addressed event would land in all of them. Omit only when the intent
   * really is "whichever composer is focused"; `undefined` is treated as
   * addressed to the active session.
   */
  sessionId?: string
  /** Files to stage as attachments, in order. */
  files?: readonly File[]
  /** Chip-style citations to stage alongside the text. */
  citations?: readonly ContextRef[]
  /** The message the next send should answer, when the composer has none yet. */
  replyTo?: MessageReplyTo
  /** Context envelopes to re-send with the next turn. */
  carried?: readonly CarriedPromptPreamble[]
  /**
   * Attachments that could not come back (only their extracted text was
   * kept). The composer names them so the user knows to re-attach.
   */
  missing?: readonly string[]
  /**
   * Set by the composer that took the event. A dispatcher that would discard
   * its own copy (a queued follow-up's bubble) keeps it when nobody did — no
   * composer was mounted for that conversation.
   */
  claimed?: boolean
  /** Append, then use the claiming composer's normal guarded submit path. */
  submit?: boolean
  /** False means the text remains a draft (blocked or cancelled), not sent. */
  onSubmitted?: (sent: boolean) => void
}

/** Whether a detail carries anything a composer would stage. */
export function composerAppendHasContent(detail: ComposerAppendDetail | undefined): boolean {
  if (!detail) return false
  return Boolean(
    detail.text?.trim() ||
    detail.files?.length ||
    detail.citations?.length ||
    detail.carried?.length ||
    detail.replyTo ||
    // Naming the files that could not come back is worth claiming on its own:
    // an attachment-only message put back has nothing else to say.
    detail.missing?.length
  )
}

/**
 * Append to one composer's draft. See {@link ComposerAppendDetail}. Returns
 * whether a mounted composer claimed it.
 */
export function dispatchComposerAppend(detail: ComposerAppendDetail): boolean {
  if (typeof window === "undefined") return false
  const carrier: ComposerAppendDetail = { ...detail, claimed: false }
  window.dispatchEvent(new CustomEvent(COMPOSER_APPEND_EVENT, { detail: carrier }))
  return carrier.claimed === true
}
