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

/** Metadata assembled before dispatch that must travel with this exact turn. */
export interface ComposerTurnMetadata {
  webSearchContext?: SendOptions["webSearchContext"]
  /** The message this turn answers (ADR-0177 batch 2). */
  replyTo?: MessageReplyTo
}

/** The send-option fields a turn's metadata carries, absent keys omitted. */
export function turnMetadataSendOptions(
  turnMetadata: ComposerTurnMetadata | undefined
): Pick<ComposerTurnMetadata, "webSearchContext" | "replyTo"> {
  return {
    ...(turnMetadata?.webSearchContext ? { webSearchContext: turnMetadata.webSearchContext } : {}),
    ...(turnMetadata?.replyTo ? { replyTo: turnMetadata.replyTo } : {}),
  }
}
