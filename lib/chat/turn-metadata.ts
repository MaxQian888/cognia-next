/**
 * What the composer assembles for one turn and every host forwards to its
 * send path unchanged.
 *
 * Five hosts (the desktop workspace, the mobile shell, the Inbox page, the
 * workbench chat panel, the workflow copilot) used to spread each field of
 * the metadata into their send options by hand, so a field added here had
 * ten places to be forgotten in. They now all call
 * {@link turnMetadataSendOptions}.
 *
 * Pure: no store, no React.
 */

import type { MessageReplyTo, SendOptions } from "@cognia/agent-config-types"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type { PromptPreambleSummary } from "@/lib/chat/prompt-preamble"

/** Metadata assembled before dispatch that must travel with this exact turn. */
export interface ComposerTurnMetadata {
  webSearchContext?: SendOptions["webSearchContext"]
  /** The message this turn answers (ADR-0177 batch 2). */
  replyTo?: MessageReplyTo
  /**
   * The room members the user picked to answer this turn (ADR-0177 batch
   * 3), in pick order. Only a team room's composer sets it; a direct chat's
   * send path ignores it.
   */
  targetMemberIds?: readonly string[]
  /**
   * What the context envelope in front of the typed text carries — sections and
   * reference names, never bodies. Persisted as `metadata.promptPreamble` so the
   * bubble can name what was attached (`lib/chat/prompt-preamble.ts`).
   */
  promptPreamble?: PromptPreambleSummary
  /**
   * Every record this turn cites: the chips it actually sent plus token-less
   * picks such as a staged document.
   *
   * Carried with the turn rather than read from the store by the send path,
   * because the store is keyed by conversation and a first message from the
   * new-chat composer is staged under NO conversation — reading the destination
   * conversation's slice after it was created found nothing, so the first turn
   * of a conversation started from a reference was never cited.
   */
  citations?: readonly ContextRef[]
}

/** The send-option fields a turn's metadata carries, absent keys omitted. */
export function turnMetadataSendOptions(
  turnMetadata: ComposerTurnMetadata | undefined
): Pick<
  ComposerTurnMetadata,
  "webSearchContext" | "replyTo" | "targetMemberIds" | "promptPreamble" | "citations"
> {
  return {
    ...(turnMetadata?.webSearchContext ? { webSearchContext: turnMetadata.webSearchContext } : {}),
    ...(turnMetadata?.replyTo ? { replyTo: turnMetadata.replyTo } : {}),
    ...(turnMetadata?.targetMemberIds && turnMetadata.targetMemberIds.length > 0
      ? { targetMemberIds: turnMetadata.targetMemberIds }
      : {}),
    ...(turnMetadata?.promptPreamble ? { promptPreamble: turnMetadata.promptPreamble } : {}),
    ...(turnMetadata?.citations && turnMetadata.citations.length > 0
      ? { citations: turnMetadata.citations }
      : {}),
  }
}
