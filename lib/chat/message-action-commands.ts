export type MessageActionCommandId =
  | "copy"
  | "share"
  | "copyLink"
  | "quote"
  | "reply"
  | "shareCard"
  | "bookmark"
  | "edit"
  | "regenerate"
  | "readAloud"
  | "branch"
  | "truncate"
  | "bringBack"
  | "rerunTemplate"
  | "saveAsMemory"
  | "saveAsIssue"
  | "select"
  | "selectText"
  | "delete"

export interface MessageActionCommandContext {
  role: "user" | "assistant" | "system"
  hasContent: boolean
  hasSession: boolean
  canEdit?: boolean
  canRegenerate?: boolean
  canReadAloud?: boolean
  canBringBack?: boolean
  /** This turn recorded the template parameters it was written from. */
  canRerunTemplate?: boolean
  /**
   * The turn's content can be kept as a pending memory draft.
   *
   * Assistant turns only. A user's own message is already theirs to save with
   * `/remember`; what has no path is the thing the AGENT worked out, which is
   * exactly what `lib/memory/agent-findings.ts` was built to take and what
   * nothing has ever called.
   */
  canSaveAsMemory?: boolean
  /**
   * The turn's content can be filed as a tracker issue (spec 2026-09-06 D9).
   * Assistant turns only, for the same reason as `canSaveAsMemory`: what a
   * reply found that still has to be done is the thing with no path.
   */
  canSaveAsIssue?: boolean
  /**
   * The transcript this turn sits in can enter selection mode: tick several
   * messages, then reference, summarize, copy or save them together.
   *
   * A capability the SURFACE supplies, not the message: only a surface that
   * mounts the selection mode passes it — the desktop transcript and the mobile
   * long-press sheet opened from one. A read-only transcript renders the same
   * rows without it, and so offers no "Select" that would open nothing.
   */
  canSelect?: boolean
  /**
   * The surface offers a sheet for selecting PART of the message's text.
   *
   * Touch only. Where the pointer can drag across the transcript, text is
   * selected in place and the selection capsule acts on it; on a phone a long
   * press opens the action sheet instead of selecting a word, so the sheet is
   * the way to a passage.
   */
  canSelectText?: boolean
  canDelete?: boolean
  streaming?: boolean
}

export interface MessageActionCommand {
  id: MessageActionCommandId
  disabled?: boolean
  destructive?: boolean
}

/**
 * Host-owned command availability shared by pointer, keyboard, overflow, and
 * mobile long-press surfaces. Each surface supplies presentation and handlers;
 * this pure model supplies the same command set and safety flags.
 */
export function resolveMessageActionCommands(
  context: MessageActionCommandContext
): MessageActionCommand[] {
  const commands: MessageActionCommand[] = []
  if (context.hasContent) {
    commands.push({ id: "copy" }, { id: "share" }, { id: "quote" }, { id: "shareCard" })
  }
  commands.push({ id: "bookmark" })
  // A reply needs a conversation to answer into and words to quote: a
  // tool-only turn has nothing a preview could show (ADR-0177 batch 2).
  if (context.hasSession && context.hasContent) commands.push({ id: "reply" })
  if (context.hasSession) {
    commands.push(
      { id: "copyLink" },
      { id: "branch", disabled: context.streaming },
      { id: "truncate", disabled: context.streaming, destructive: true }
    )
  }
  if (context.role === "user" && context.canEdit) commands.push({ id: "edit" })
  if (context.role === "assistant" && context.canRegenerate) {
    commands.push({ id: "regenerate", disabled: context.streaming })
  }
  if (context.role === "assistant" && context.canReadAloud) commands.push({ id: "readAloud" })
  if (context.canBringBack) commands.push({ id: "bringBack" })
  // Only ever on the user's own turn: the values belong to the question, and
  // offering it on the answer would read as "regenerate", which is a different
  // command sitting two rows above.
  if (context.role === "user" && context.canRerunTemplate) {
    commands.push({ id: "rerunTemplate", disabled: context.streaming })
  }
  if (context.role === "assistant" && context.canSaveAsMemory && context.hasContent) {
    commands.push({ id: "saveAsMemory", disabled: context.streaming })
  }
  if (context.role === "assistant" && context.canSaveAsIssue && context.hasContent) {
    commands.push({ id: "saveAsIssue", disabled: context.streaming })
  }
  // Content is not required: a turn that is only tool calls still carries the
  // output a combined reference exists to hand over. A session is — every bulk
  // action stages into, or files under, the conversation.
  if (context.hasSession && context.canSelect) commands.push({ id: "select" })
  // Words are required here, unlike above: the sheet shows the message's text
  // to select from, and a tool-only turn has none.
  if (context.hasSession && context.hasContent && context.canSelectText) {
    commands.push({ id: "selectText" })
  }
  if (context.canDelete) commands.push({ id: "delete", destructive: true })
  return commands
}
